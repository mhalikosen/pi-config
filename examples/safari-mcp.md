# Safari MCP via `pi-mcp-extension`

End-to-end wiring of the high-level Safari browser MCP server behind
[`pi-mcp-extension`](https://www.npmjs.com/package/pi-mcp-extension), so a pi
session can drive a real Safari window without any raw WebDriver calls.
Uses [Safari Technology Preview](https://developer.apple.com/safari/technology-preview/),
the only Safari build that ships `safaridriver --mcp`.

## Prerequisites

- macOS with Safari Technology Preview installed at `/Applications/`.
- `pi-mcp-extension` in `settings.json` (already in the repo, version `1.5.0`).
- One-time in Safari T.P.: `Settings > Advanced > Show Develop menu`, then
  `Develop > Allow Remote Automation`. Without it `safaridriver` will not
  attach to a session.

## `mcp.json`

Drop this at `~/.pi/agent/mcp.json` (global) or `.pi/mcp.json` (per-project).
Project config overrides global via shallow merge, server-for-server.

```jsonc
{
  "mcpServers": {
    "safari": {
      "command": "/Applications/Safari Technology Preview.app/Contents/MacOS/safaridriver",
      "args": ["--mcp"],
      "transport": "stdio",
      "lifecycle": "eager"
    }
  }
}
```

Field rationale:

- `command`: hard-coded path because `$PATH` normally excludes the inner
  `MacOS/` directory of an `.app` bundle.
- `args: ["--mcp"]`: switches `safaridriver` from its classic HTTP server
  mode into MCP tool mode.
- `transport: "stdio"`: pi spawns the binary and talks JSON-RPC over its
  stdin/stdout.
- `lifecycle: "eager"`: connect on pi startup so the tools are available in
  the first turn. Switch to `"lazy"` if you only want them on first reference
  to keep cold-start fast.

## How the bridge surfaces

`pi-mcp-extension` puts each server under its own namespace, so the tools
appear as `mcp_safari_<action>`. The server is browser-automation (not raw
WebDriver), so the surface is high-level. The canonical list is always
`pi /tools` after start; the stable subset I reach for is below.

| Tool | Purpose |
| --- | --- |
| `mcp_safari_list_tabs` | List every open tab with `{handle, title, url}`. |
| `mcp_safari_navigate_to_url` | Open a URL; auto-creates a tab if none is open. Returns the extracted page text so the agent can read it without a second call. Honors the `format` / `region` of the most recent `get_page_content`. |
| `mcp_safari_get_page_content` | Re-extract the current page (or another tab by handle). Annotates elements with `uid=N`. Supports `format` (`textTree` / `markdown` / `html` / `json`), `region` (`viewport` / `entire_page`), `savePath` for large output, and selective `nodeIds`. |
| `mcp_safari_page_interactions` | Sequence of `{type, node, purpose, value}` actions: `click`, `type`, `scroll`, `selectText`, `selectMenuItem`, `hover`, `keyPress`, `highlightText`. Reference elements by the `node` UID printed in the previous `get_page_content`. 400ms settle between actions. |
| `mcp_safari_screenshot` | Save a PNG to disk; always returns the file path, never inline base64. Optional `node` UID to scope the capture, plus `full_page`. |
| `mcp_safari_evaluate_javascript` | Run JS in the page. Supports a `$uid(N)` macro that expands to `document.querySelector('[data-pi-uid="N"]')`. |
| `mcp_safari_list_network_requests` / `_get_network_request` | Inspector log per tab, filterable by status / URL substring. |
| `mcp_safari_console_messages` | Read (and clear) the page console for the active tab. |
| `mcp_safari_set_viewport_size` / `_set_emulated_media` | Viewport size and CSS media type overrides. |
| `mcp_safari_create_tab` / `_close_tab` / `_switch_tab` | Open, close, jump between tabs (handle vs UUID depending on the call). |
| `mcp_safari_wait_for_navigation` | Block until the active page finishes loading. |
| `mcp_safari_page_info` | URL, title, loading state of the current tab. |
| `mcp_safari_browser_dialogs` | List or respond to JS `alert` / `confirm` / `prompt`. |

Apple revs the surface; treat this table as the recent stable subset, not the
full list.

## Example session

The realistic flow: list tabs, navigate (or open a fresh tab), read content
to extract UIDs, interact by UID, screenshot. The `node` UID you hand to
`page_interactions` / `screenshot` / `evaluate_javascript` always comes from a
prior `get_page_content` call. The bridge remembers the active tab across
calls until you `switch_tab`.

User prompt:

> Open the pi docs and tell me what the H1 says, plus save a full-page
> screenshot.

What pi ends up doing (approximate trace):

1. `list_tabs` — confirm there's nothing relevant open.
2. `navigate_to_url({ url: "https://pi.dev/docs" })` — auto-creates a tab and
   returns the extracted page text tree. The accessibility node for the H1
   carries `uid=42` (or whatever number).
3. Optionally `get_page_content({ format: "markdown", maxWordsPerParagraph: 40 })`
   for a tighter prose view.
4. `screenshot({ full_page: true, savePath: "/tmp/pi-docs.png" })` — bridge
   writes the PNG itself; pi gets back the path.
5. `evaluate_javascript({ expression: "document.querySelector('h1').innerText" })`
   for the exact heading string. (Or skip step 5: the text returned by step 2
   already contains the H1.)

What I do not do:

- No raw WebDriver calls. The bridge abstracts `find_element` / `click` /
  `send_keys` away entirely.
- No base64 inline screenshots. The MCP server writes to disk and returns
  the path.

## Pitfalls

- **UIDs are per-extraction, not persistent.** Re-run `get_page_content`
  after a navigation or heavy DOM mutation; old UIDs may refer to gone
  elements. Never reuse a UID across turns.
- **State loss on Safari quit.** Closing Safari T.P. mid-session drops the
  tab set. If a tool call returns empty mid-session, run `list_tabs` and
  re-`navigate_to_url` whichever tab you still need.
- **Large output goes to a temp file.** Both `get_page_content` and
  `navigate_to_url` auto-save outputs over ~32kB to a temp file and return
  the path instead of inline text. Pass `savePath` up front when you know
  you want it on disk.
- **Batch DOM mutations.** Prefer one `page_interactions` call with several
  actions over a sequence of single-action calls. The bridge settles
  400ms between actions inside a batch, which is faster and gives the
  diff-stable extraction a single source page.
- **Strict CSP pages.** Some pages with locked-down `Content-Security-Policy`
  reject `execute_script`. Fall back to `get_page_content` for read paths.
- **First-turn extraction format.** `navigate_to_url` reuses the last
  `get_page_content` `format` and `region`. Set those explicitly via
  `get_page_content` right after a navigate if the defaults don't fit.
