import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Exits pi when the user submits the literal text "exit" (or "quit") in the
 * editor, mirroring the behavior of a REPL.
 *
 * The `input` event fires after slash-commands are checked and before the
 * agent runs, so returning `{ action: "handled" }` skips the LLM call entirely
 * and `ctx.shutdown()` requests a graceful exit.
 */
export default function (pi: ExtensionAPI) {
  pi.on("input", async (event, ctx) => {
    const text = event.text.trim().toLowerCase();
    if (text !== "exit" && text !== "quit") return;

    ctx.ui.notify("Exiting pi...", "info");
    ctx.shutdown();
    return { action: "handled" };
  });
}
