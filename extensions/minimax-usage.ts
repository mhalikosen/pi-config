import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// ────────────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────────────

const STATUS_KEY = "minimax-usage";
const POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const FETCH_TIMEOUT_MS = 10_000;
const LOW_QUOTA_THRESHOLD = 25; // show status only when either window drops below this %
const CODING_PLAN_ENDPOINT =
	"https://api.minimax.io/v1/api/openplatform/coding_plan/remains";

// ────────────────────────────────────────────────────────────────────
// Types — minimal projection of the /coding_plan/remains response
// ────────────────────────────────────────────────────────────────────

interface ModelRemains {
	model_name: string;
	start_time: number;
	end_time: number;
	remains_time: number;
	current_interval_remaining_percent: number;
	current_interval_status: number;
	weekly_remains_time: number;
	current_weekly_remaining_percent: number;
	current_weekly_status: number;
}

interface RemainsResponse {
	model_remains?: ModelRemains[];
	base_resp?: { status_code: number; status_msg?: string };
}

interface QuotaSnapshot {
	general: ModelRemains | undefined;
	fetchedAt: number;
	error?: string;
}

// ────────────────────────────────────────────────────────────────────
// Provider detection
// ────────────────────────────────────────────────────────────────────

function isMinimaxProvider(model: unknown): boolean {
	if (!model || typeof model !== "object") return false;
	const m = model as { provider?: string; baseUrl?: string };
	if (m.provider === "minimax") return true;
	const baseUrl = String(m.baseUrl ?? "");
	return baseUrl.includes("minimax.io") || baseUrl.includes("minimaxi.com");
}

// ────────────────────────────────────────────────────────────────────
// Formatting
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

function formatStatusLine(snapshot: QuotaSnapshot): string | undefined {
	if (snapshot.error || !snapshot.general) return undefined;
	const g = snapshot.general;
	if (
		g.current_interval_remaining_percent >= LOW_QUOTA_THRESHOLD &&
		g.current_weekly_remaining_percent >= LOW_QUOTA_THRESHOLD
	) {
		return undefined;
	}
	const h5 = `${100 - g.current_interval_remaining_percent}%(${formatDuration(g.remains_time)})`;
	const wk = `${100 - g.current_weekly_remaining_percent}%(${formatDuration(g.weekly_remains_time)})`;
	return `minimax 5h:${h5} · wk:${wk}`;
}

function formatDetail(snapshot: QuotaSnapshot): string {
	const lines: string[] = [];
	const g = snapshot.general;
	if (g) {
		lines.push("MiniMax quota (general)");
		lines.push("─────────────────────────");
		lines.push(
			`5-hour window    ${String(100 - g.current_interval_remaining_percent).padStart(3)}%   resets in ${formatDuration(g.remains_time)}`,
		);
		lines.push(
			`Weekly window    ${String(100 - g.current_weekly_remaining_percent).padStart(3)}%   resets in ${formatDuration(g.weekly_remains_time)}`,
		);
	} else if (snapshot.error) {
		lines.push(`MiniMax quota — error: ${snapshot.error}`);
	} else {
		lines.push("MiniMax quota — no data yet");
	}
	lines.push("");
	lines.push(
		`Last fetched: ${new Date(snapshot.fetchedAt).toLocaleTimeString("en-GB", { hour12: false })} · refreshes every 5 min`,
	);
	return lines.join("\n");
}

// ────────────────────────────────────────────────────────────────────
// Network
// ────────────────────────────────────────────────────────────────────

async function fetchQuota(apiKey: string, signal: AbortSignal): Promise<ModelRemains> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
	const onAbort = () => controller.abort();
	signal.addEventListener("abort", onAbort);
	try {
		const response = await fetch(CODING_PLAN_ENDPOINT, {
			method: "GET",
			headers: {
				Authorization: `Bearer ${apiKey}`,
				Accept: "application/json",
				"Content-Type": "application/json",
			},
			signal: controller.signal,
		});
		if (!response.ok) {
			throw new Error(`HTTP ${response.status}`);
		}
		const data = (await response.json()) as RemainsResponse;
		if (data.base_resp && data.base_resp.status_code !== 0) {
			throw new Error(data.base_resp.status_msg ?? "api error");
		}
		const general = data.model_remains?.find((m) => m.model_name === "general");
		if (!general) {
			throw new Error("general entry missing");
		}
		return general;
	} finally {
		clearTimeout(timeout);
		signal.removeEventListener("abort", onAbort);
	}
}

// ────────────────────────────────────────────────────────────────────
// Extension
// ────────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	let snapshot: QuotaSnapshot = { general: undefined, fetchedAt: 0 };
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
		if (!isMinimaxProvider(model)) {
			snapshot = { general: undefined, fetchedAt: Date.now() };
			try {
				ctx.ui.setStatus(STATUS_KEY, undefined);
			} catch {
				// ctx may be stale after session replacement
			}
			return;
		}

		let apiKey: string | undefined;
		try {
			const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
			if (auth.ok && auth.apiKey) {
				apiKey = auth.apiKey;
			}
		} catch {
			// fall through to env
		}
		if (!apiKey) {
			apiKey = process.env.MINIMAX_API_KEY;
		}

		if (!apiKey) {
			if (!authErrorNotified) {
				try {
					ctx.ui.notify(
						"minimax-usage: no API key found (auth.json or MINIMAX_API_KEY env)",
						"warning",
					);
				} catch {
					// ignore
				}
				authErrorNotified = true;
			}
			try {
				ctx.ui.setStatus(STATUS_KEY, undefined);
			} catch {
				// ignore
			}
			return;
		}

		const version = ++requestVersion;
		abortActive();
		const controller = new AbortController();
		activeRequest = controller;

		try {
			const general = await fetchQuota(apiKey, controller.signal);
			if (version !== requestVersion || controller.signal.aborted) return;

			snapshot = { general, fetchedAt: Date.now() };
			authErrorNotified = false;
			const text = formatStatusLine(snapshot);
			ctx.ui.setStatus(
				STATUS_KEY,
				text ? ctx.ui.theme.fg("dim", text) : undefined,
			);
		} catch (err) {
			if (version !== requestVersion) return;
			const message = err instanceof Error ? err.message : String(err);
			snapshot = { general: undefined, fetchedAt: Date.now(), error: message };
			try {
				ctx.ui.setStatus(STATUS_KEY, undefined);
			} catch {
				// ignore
			}
			if (message.includes("HTTP 401") || message.includes("HTTP 403")) {
				if (!authErrorNotified) {
					try {
						ctx.ui.notify(`minimax-usage: auth error — ${message}`, "error");
					} catch {
						// ignore
					}
					authErrorNotified = true;
				}
			}
		} finally {
			if (version === requestVersion) {
				activeRequest = undefined;
			}
		}
	};

	// ── Slash command ─────────────────────────────────────────────

	pi.registerCommand("minimax-usage", {
		description: "Show MiniMax Coding Plan quota usage",
		handler: async (_args, ctx) => {
			await refresh();
			try {
				ctx.ui.notify(formatDetail(snapshot), "info");
			} catch {
				// ignore
			}
		},
	});

	// ── Lifecycle events ──────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		currentCtx = ctx;
		authErrorNotified = false;
		requestVersion++;
		abortActive();
		stopPolling();

		void refresh();

		if (ctx.hasUI) {
			pollTimer = setInterval(() => {
				void refresh();
			}, POLL_INTERVAL_MS);
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
			// ctx may be stale after session replacement
		}
	});
}