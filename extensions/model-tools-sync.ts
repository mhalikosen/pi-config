/**
 * model-tools-sync.ts
 *
 * Activates each model's own provider/MCP tools automatically based on the
 * active provider. When you switch models, provider-specific tools follow:
 *   - minimax provider -> minimax_* tools (web_search, understand_image, ...)
 *   - zai provider     -> z_ai_* tools    (search, reader, zread, vision)
 *
 * Built-in tools and unrelated extension tools are left untouched: we only
 * ever strip the explicitly listed provider tools and re-add the active
 * provider's set.
 *
 * Tool names are listed explicitly (not by prefix), so adding a new tool to a
 * provider extension never silently changes agent behavior. To wire a new tool
 * or provider, edit PROVIDER_TOOLS below.
 *
 * Listens to two events:
 *   - `session_start` (startup/reload): the model is loaded straight from
 *     settings at launch, so `model_select` does NOT fire here. We sync in
 *     this handler so the right toolset is in place on first run.
 *   - `model_select` (set/cycle): keeps the toolset in sync on manual switches
 *     via `/model` or Ctrl+P.
 * Both paths call the same idempotent sync helper.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function modelToolsSyncExtension(pi: ExtensionAPI) {
	// provider id -> exact tool names registered by that provider's extension(s)
	const PROVIDER_TOOLS: Record<string, string[]> = {
		minimax: [
			"minimax_web_search",
			"minimax_understand_image",
			"minimax_list_voices",
			"minimax_text_to_audio",
		],
		zai: [
			"z_ai_search",
			"z_ai_reader",
			"z_ai_zread",
			"z_ai_vision",
		],
	};

	// every tool we manage, flattened for quick stripping
	const allKnownTools = new Set<string>(Object.values(PROVIDER_TOOLS).flat());

	// Strip every managed tool, then re-add the active provider's set.
	// Idempotent: safe to call from multiple events.
	function syncProviderTools(provider: string): string[] {
		const desired = PROVIDER_TOOLS[provider] ?? [];
		const active = pi.getActiveTools();
		const available = new Set(pi.getAllTools().map((t) => t.name));

		// 1. Strip every tool we manage from the current set.
		//    Built-in tools and unrelated extension tools are preserved.
		const next = active.filter((name) => !allKnownTools.has(name));

		// 2. Re-add the active provider's tools, but only the ones that
		//    actually exist (avoids registering phantom tool names).
		for (const name of desired) {
			if (available.has(name)) next.push(name);
		}

		pi.setActiveTools([...new Set(next)]);
		return desired;
	}

	// First launch / reload: model is loaded from settings without a
	// model_select event, so sync here to cover the initial activation.
	pi.on("session_start", async (event, ctx) => {
		if (event.reason !== "startup" && event.reason !== "reload") return;
		const model = ctx.model;
		if (!model) return;
		const desired = syncProviderTools(model.provider);
		if (desired.length > 0) {
			ctx.ui.notify(`${model.provider}/${model.id}: provider tools synced`, "info");
		}
	});

	// Manual switches via /model or Ctrl+P.
	pi.on("model_select", async (event, ctx) => {
		const desired = syncProviderTools(event.model.provider);

		// Only notify on real switches, not silent restores to the same provider.
		const changed = event.previousModel?.provider !== event.model.provider;
		if (desired.length > 0 && (event.source !== "restore" || changed)) {
			ctx.ui.notify(`${event.model.provider}/${event.model.id}: provider tools synced`, "info");
		}
	});
}
