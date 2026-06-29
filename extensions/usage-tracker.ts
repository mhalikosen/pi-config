/**
 * usage-tracker.ts (DRAFT)
 *
 * Extension of the original minimax-usage.ts to support multiple coding-plan
 * providers. Currently covers:
 *   - MiniMax Coding Plan  (https://api.minimax.io/.../coding_plan/remains)
 *   - Z.ai GLM Coding Plan (https://api.z.ai/api/monitor/usage/quota/limit)
 *
 * Design: each provider is an adapter implementing ProviderAdapter. The core
 * lifecycle (polling, abort/version guards, status rendering) is shared.
 *
 * Normalized snapshot uses a single polarity everywhere:
 *   usedPercent = CONSUMED percentage (0 = empty, 100 = exhausted)
 * This is the OPPOSITE of MiniMax's raw "remaining" field, so the MiniMax
 * adapter inverts it. Z.ai's raw "percentage" is already "used".
 *
 * Key Z.ai gotcha: it can return HTTP 200 with an error body
 * ({ success:false, msg, code }). We must inspect the body, not just ok.
 *
 * Migration from minimax-usage.ts:
 *   1. Copy this file to ~/.pi/agent/extensions/usage-tracker.ts
 *   2. Delete ~/.pi/agent/extensions/minimax-usage.ts
 *   3. Restart pi.
 *
 * Status key changed from "minimax-usage" to "usage" so only the active
 * provider's quota is shown.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// ────────────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────────────

const STATUS_KEY = "usage";
const POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const FETCH_TIMEOUT_MS = 10_000;
const LOW_QUOTA_THRESHOLD = 25; // show status only when used % crosses (100 - this)

const MINIMAX_ENDPOINT =
	"https://api.minimax.io/v1/api/openplatform/coding_plan/remains";
const ZAI_ENDPOINT = "https://api.z.ai/api/monitor/usage/quota/limit";

// ────────────────────────────────────────────────────────────────────
// Normalized types
// ────────────────────────────────────────────────────────────────────

interface UsageWindow {
	label: string; // e.g. "5h", "wk"
	usedPercent: number; // 0..100, CONSUMED
	resetInMs: number; // remaining duration until window resets
}

interface ProviderUsage {
	provider: "minimax" | "zai";
	windows: UsageWindow[];
	plan?: string; // e.g. z.ai "lite" / "pro" / "max"
	fetchedAt: number;
	error?: string;
}

interface FetchResult {
	windows: UsageWindow[];
	plan?: string;
}

interface ProviderAdapter {
	id: "minimax" | "zai";
	detect(model: unknown): boolean;
	/** Resolve an API key for the current model, falling back to env. */
	resolveKey(ctx: ExtensionContext, model: unknown): Promise<string | undefined>;
	fetch(key: string, signal: AbortSignal): Promise<FetchResult>;
}

// ────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────

function formatDuration(ms: number): string {
	if (!Number.isFinite(ms) || ms <= 0) return "0m";
	const totalSec = Math.floor(ms / 1000);
	const days = Math.floor(totalSec / 86400);
	const hours = Math.floor((totalSec % 86400) / 3600);
	const mins = Math.floor((totalSec % 3600) / 60);
	if (days > 0) return `${days}d${hours}h`;
	if (hours > 0) return `${hours}h${mins}m`;
	if (mins > 0) return `${mins}m`;
	return "<1m";
}

async function resolveKeyShared(
	ctx: ExtensionContext,
	model: unknown,
	envVar: string,
): Promise<string | undefined> {
	try {
		// model is `unknown` at the adapter boundary, but detect() already
		// confirmed it's the active ctx.model, so cast is safe here.
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model as never);
		if (auth.ok && auth.apiKey) return auth.apiKey;
	} catch {
		// fall through to env
	}
	return process.env[envVar];
}

// ────────────────────────────────────────────────────────────────────
// MiniMax adapter (port of the original extension)
// ────────────────────────────────────────────────────────────────────

interface MmRemains {
	model_name: string;
	remains_time: number;
	current_interval_remaining_percent: number;
	weekly_remains_time: number;
	current_weekly_remaining_percent: number;
}
interface MmResponse {
	model_remains?: MmRemains[];
	base_resp?: { status_code: number; status_msg?: string };
}

const minimax: ProviderAdapter = {
	id: "minimax",
	detect(model) {
		if (!model || typeof model !== "object") return false;
		const m = model as { provider?: string; baseUrl?: string };
		if (m.provider === "minimax") return true;
		const baseUrl = String(m.baseUrl ?? "");
		return baseUrl.includes("minimax.io") || baseUrl.includes("minimaxi.com");
	},
	resolveKey: (ctx, model) => resolveKeyShared(ctx, model, "MINIMAX_API_KEY"),
	async fetch(key, signal) {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
		const onAbort = () => controller.abort();
		signal.addEventListener("abort", onAbort);
		try {
			const res = await fetch(MINIMAX_ENDPOINT, {
				method: "GET",
				headers: {
					Authorization: `Bearer ${key}`,
					Accept: "application/json",
					"Content-Type": "application/json",
				},
				signal: controller.signal,
			});
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const data = (await res.json()) as MmResponse;
			if (data.base_resp && data.base_resp.status_code !== 0) {
				throw new Error(data.base_resp.status_msg ?? "api error");
			}
			const g = data.model_remains?.find((m) => m.model_name === "general");
			if (!g) throw new Error("general entry missing");
			// Raw fields are REMAINING %; invert to USED %.
			return {
				windows: [
					{
						label: "5h",
						usedPercent: 100 - g.current_interval_remaining_percent,
						resetInMs: g.remains_time,
					},
					{
						label: "wk",
						usedPercent: 100 - g.current_weekly_remaining_percent,
						resetInMs: g.weekly_remains_time,
					},
				],
			};
		} finally {
			clearTimeout(timeout);
			signal.removeEventListener("abort", onAbort);
		}
	},
};

// ────────────────────────────────────────────────────────────────────
// Z.ai adapter
// ────────────────────────────────────────────────────────────────────
//
// Endpoint: GET https://api.z.ai/api/monitor/usage/quota/limit
// Verified live response (2026-06-29, "lite" plan):
//   {
//     "code": 200, "msg": "Operation successful", "success": true,
//     "data": {
//       "level": "lite",
//       "limits": [
//         { "type": "TIME_LIMIT",  "unit": 5, "number": 1, "percentage": 0,
//           "nextResetTime": 1784545973981, ...usageDetails... },
//         { "type": "TOKENS_LIMIT", "unit": 3, "number": 5, "percentage": 4,
//           "nextResetTime": 1782748205149 },   // 5-hour rolling window
//         { "type": "TOKENS_LIMIT", "unit": 6, "number": 1, "percentage": 23,
//           "nextResetTime": 1783163573998 }     // 7-day rolling window
//       ]
//     }
//   }
//
// `unit` is a time-unit enum: 3 = HOUR, 5 = MONTH, 6 = WEEK (number = how
// many of that unit make up the window). `percentage` is ALREADY used %.
// `nextResetTime` is an epoch-ms INSTANT.
//
// WATCH OUT: Z.ai can also return HTTP 200 with an error body:
//   { "code": 401, "msg": "token expired or incorrect", "success": false }
// so we must inspect `success`, not just response.ok.
//
// There are exactly two TOKENS_LIMIT entries (5h + weekly). We classify each
// by its reset delta to be robust if Z.ai reorders them.

interface ZaiLimit {
	type: string;
	unit?: number; // 3=HOUR, 5=MONTH, 6=WEEK
	number?: number; // window length in that unit
	percentage?: number;
	nextResetTime?: number;
}
interface ZaiResponse {
	code?: number;
	msg?: string;
	success?: boolean;
	data?: { limits?: ZaiLimit[]; level?: string };
}

function classifyZaiWindow(resetDeltaMs: number): string {
	// <= 1 day => rolling session window; otherwise weekly.
	return resetDeltaMs <= 24 * 3600_000 ? "5h" : "wk";
}

const zai: ProviderAdapter = {
	id: "zai",
	detect(model) {
		if (!model || typeof model !== "object") return false;
		const m = model as { provider?: string; baseUrl?: string };
		if (m.provider === "zai") return true;
		const baseUrl = String(m.baseUrl ?? "");
		return baseUrl.includes("z.ai");
	},
	// ZAI_API_KEY is the common name; GLM_API_KEY is the legacy Zhipu name.
	resolveKey: async (ctx, model) => {
		const key = await resolveKeyShared(ctx, model, "ZAI_API_KEY");
		return key ?? process.env.GLM_API_KEY;
	},
	async fetch(key, signal) {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
		const onAbort = () => controller.abort();
		signal.addEventListener("abort", onAbort);
		try {
			const res = await fetch(ZAI_ENDPOINT, {
				method: "GET",
				headers: {
					Authorization: `Bearer ${key}`,
					Accept: "application/json",
					AcceptEncoding: "identity",
				},
				signal: controller.signal,
			});
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const data = (await res.json()) as ZaiResponse;
			// 200-with-error-body trap.
			if (typeof data.success === "boolean" && !data.success && data.msg) {
				throw new Error(`zai api${data.code ?? "?"}: ${data.msg}`);
			}
			const tokenLimits = (data.data?.limits ?? []).filter(
				(l) => l.type === "TOKENS_LIMIT" && typeof l.percentage === "number",
			);
			if (tokenLimits.length === 0) throw new Error("TOKENS_LIMIT not found");

			const now = Date.now();
			const windows = tokenLimits.map((l) => {
				const resetAt = l.nextResetTime ?? now;
				const resetInMs = Math.max(0, resetAt - now);
				return {
					label: l.nextResetTime ? classifyZaiWindow(resetInMs) : "tokens",
					usedPercent: l.percentage as number,
					resetInMs,
				};
			});
			// Stable order: 5h window first, then weekly.
			windows.sort((a, b) => a.resetInMs - b.resetInMs);
			return { windows, plan: data.data?.level };
		} finally {
			clearTimeout(timeout);
			signal.removeEventListener("abort", onAbort);
		}
	},
};

const ADAPTERS: ProviderAdapter[] = [zai, minimax];

// ────────────────────────────────────────────────────────────────────
// Rendering
// ────────────────────────────────────────────────────────────────────

function formatStatusLine(u: ProviderUsage): string | undefined {
	if (u.error || u.windows.length === 0) return undefined;
	// Only show when at least one window is past the threshold.
	const anyLow = u.windows.some(
		(w) => w.usedPercent >= 100 - LOW_QUOTA_THRESHOLD,
	);
	if (!anyLow) return undefined;
	const parts = u.windows.map(
		(w) => `${w.label}:${Math.round(w.usedPercent)}%(${formatDuration(w.resetInMs)})`,
	);
	return `${u.provider} ${parts.join(" · ")}`;
}

function formatDetail(u: ProviderUsage): string {
	const lines: string[] = [];
	if (u.windows.length > 0) {
		lines.push(`${u.provider}${u.plan ? ` (${u.plan})` : ""} quota`);
		lines.push("─────────────────────────");
		for (const w of u.windows) {
			lines.push(
				`${w.label.padEnd(12)} ${String(Math.round(w.usedPercent)).padStart(3)}%   resets in ${formatDuration(w.resetInMs)}`,
			);
		}
	} else if (u.error) {
		lines.push(`${u.provider} quota — error: ${u.error}`);
	} else {
		lines.push(`${u.provider} quota — no data yet`);
	}
	lines.push("");
	lines.push(
		`Last fetched: ${new Date(u.fetchedAt).toLocaleTimeString("en-GB", { hour12: false })} · refreshes every 5 min`,
	);
	return lines.join("\n");
}

// ────────────────────────────────────────────────────────────────────
// Extension
// ────────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	let snapshot: ProviderUsage = { provider: "zai", windows: [], fetchedAt: 0 };
	let currentCtx: ExtensionContext | undefined;
	let pollTimer: ReturnType<typeof setInterval> | undefined;
	let activeRequest: AbortController | undefined;
	let requestVersion = 0;
	let authErrorNotified = false;

	const stopPolling = () => {
		if (pollTimer) {
			clearInterval(pollTimer);
			pollTimer = undefined;
		}
	};
	const abortActive = () => {
		activeRequest?.abort();
		activeRequest = undefined;
	};

	const refresh = async () => {
		const ctx = currentCtx;
		if (!ctx) return;

		const model = ctx.model;
		const adapter = ADAPTERS.find((a) => a.detect(model));
		if (!adapter) {
			snapshot = { provider: "zai", windows: [], fetchedAt: Date.now() };
			try {
				ctx.ui.setStatus(STATUS_KEY, undefined);
			} catch {
				/* stale ctx */
			}
			return;
		}

		const key = await adapter.resolveKey(ctx, model);
		if (!key) {
			if (!authErrorNotified) {
				try {
					ctx.ui.notify(
						`usage-tracker: no API key found for ${adapter.id}`,
						"warning",
					);
				} catch {
					/* ignore */
				}
				authErrorNotified = true;
			}
			try {
				ctx.ui.setStatus(STATUS_KEY, undefined);
			} catch {
				/* ignore */
			}
			return;
		}

		const version = ++requestVersion;
		abortActive();
		const controller = new AbortController();
		activeRequest = controller;

		try {
			const { windows, plan } = await adapter.fetch(key, controller.signal);
			if (version !== requestVersion || controller.signal.aborted) return;

			snapshot = { provider: adapter.id, windows, plan, fetchedAt: Date.now() };
			authErrorNotified = false;
			const text = formatStatusLine(snapshot);
			ctx.ui.setStatus(
				STATUS_KEY,
				text ? ctx.ui.theme.fg("dim", text) : undefined,
			);
		} catch (err) {
			if (version !== requestVersion) return;
			const message = err instanceof Error ? err.message : String(err);
			snapshot = {
				provider: adapter.id,
				windows: [],
				fetchedAt: Date.now(),
				error: message,
			};
			try {
				ctx.ui.setStatus(STATUS_KEY, undefined);
			} catch {
				/* ignore */
			}
			if (message.includes("HTTP 401") || message.includes("HTTP 403") || message.includes("api40")) {
				if (!authErrorNotified) {
					try {
						ctx.ui.notify(`usage-tracker: ${adapter.id} auth error — ${message}`, "error");
					} catch {
						/* ignore */
					}
					authErrorNotified = true;
				}
			}
		} finally {
			if (version === requestVersion) activeRequest = undefined;
		}
	};

	pi.registerCommand("usage", {
		description: "Show coding-plan quota usage (MiniMax / Z.ai)",
		handler: async (_args, ctx) => {
			await refresh();
			try {
				ctx.ui.notify(formatDetail(snapshot), "info");
			} catch {
				/* ignore */
			}
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		currentCtx = ctx;
		authErrorNotified = false;
		requestVersion++;
		abortActive();
		stopPolling();
		void refresh();
		if (ctx.hasUI) {
			pollTimer = setInterval(() => void refresh(), POLL_INTERVAL_MS);
		}
	});

	pi.on("model_select", async (_event, ctx) => {
		currentCtx = ctx;
		requestVersion++;
		abortActive();
		void refresh();
	});

	pi.on("agent_end", async (_event, ctx) => {
		currentCtx = ctx;
		void refresh();
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		requestVersion++;
		abortActive();
		stopPolling();
		try {
			ctx.ui.setStatus(STATUS_KEY, undefined);
		} catch {
			/* stale ctx */
		}
	});
}
