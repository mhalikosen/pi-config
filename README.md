# pi-config

Personal reference of the diff applied to [pi coding agent](https://pi.dev)
beyond its defaults. Not a starter template, not a turnkey installer: just
the exact knobs I changed, the extensions I wrote, and the npm packages I
install on top of a clean `pi` setup.

## Layout

```
pi-config/
├── README.md
├── settings.json       # fields I changed vs pi's defaults (delta only)
├── packages.json       # npm packages I install on top of pi
├── extensions/
│   ├── exit-on-text.ts
│   ├── model-tools-sync.ts
│   └── usage-tracker.ts
└── examples/
    └── safari-mcp.md   # end-to-end pi-mcp-extension + Safari sample
```

## `settings.json`

Only the fields that differ from pi's documented defaults. The full default
table lives in [the pi docs](https://pi.dev/docs/latest/settings). I keep this
file as a delta so that any new default pi introduces in a future release
takes effect on a fresh clone without me having to mirror the change here.

| Field | Value | pi default |
| --- | --- | --- |
| `defaultProvider` | `minimax` | unset |
| `defaultModel` | `MiniMax-M3` | unset |
| `defaultThinkingLevel` | `high` | unset |
| `compaction.enabled` | `true` | unset |
| `theme` | `light/dark` | `dark` |
| `packages` | see below | `[]` |
| `hideThinkingBlock` | `true` | `false` |
| `terminal.showTerminalProgress` | `true` | `false` |
| `steeringMode` | `one-at-a-time` | unset |
| `followUpMode` | `one-at-a-time` | unset |
| `transport` | `auto` | unset |
| `enableInstallTelemetry` | `true` | unset |
| `defaultProjectTrust` | `ask` | unset |
| `warnings.anthropicExtraUsage` | `false` | `true` |

### `packages`

Mixed npm and git pi-packages, referenced exactly as they appear in
`settings.json` (the source of truth). npm packages are also pinned in
`packages.json`; git packages are fetched on demand by pi from the URLs below.

| Package | Source | Purpose |
| --- | --- | --- |
| `@sinamtz/pi-minimax-provider` | `npm` (`1.1.5`) | Provider for the MiniMax Coding Plan API |
| `pi-zai-mcp` | `npm` (`0.1.15`) | Z.ai web/reader/zread/vision tools as MCP-backed provider tools |
| `pi-mcp-extension` | `npm` (`1.5.0`) | Generic MCP client (stdio / streamable-http / sse); required for the Safari example |
| `pi-mem` | `git` (`jo-inc/pi-mem`) | Persistent agent memory |
| `pi-reflect` | `git` (`jo-inc/pi-reflect`) | Self-improving behavioral files |
| `@tintinweb/pi-subagents` | `npm` (`0.21.0`) | Sub-agents and workflow orchestration: parallel background agents, mid-run steering, worktree isolation, scripted workflows |

`pi-boss` and its `pi-room` dependency were dropped on 2026-10-13. Both stopped
on 2026-04-25 and still declare the pre-rename `@mariozechner/pi-coding-agent`
peer; `@tintinweb/pi-subagents` does the same work without tmux.

## `packages.json`

npm packages installed into `~/.pi/agent/npm/` via `pi install npm:<name>`.
Versions are pinned to what is currently running on my machine so the
reference is reproducible; bump them when upgrading pi.

| Package | Version |
| --- | --- |
| `@sinamtz/pi-minimax-provider` | `1.1.5` |
| `@tintinweb/pi-subagents` | `0.21.0` |
| `pi-zai-mcp` | `0.1.15` |
| `pi-mcp-extension` | `1.5.0` |

## `extensions/`

TypeScript extensions I wrote. They live at `~/.pi/agent/extensions/` and are
auto-loaded by pi on startup. Each one is a self-contained `default export`
function that calls `pi.on(...)` or `pi.registerCommand(...)`.

- **`exit-on-text.ts`**: Treats literal `exit` or `quit` in the editor as a
  REPL-style shutdown. Hooks the `input` event so the LLM is never called
  for that input.
- **`model-tools-sync.ts`**: Activates each model's own provider tools
  automatically based on the active provider. When you switch models
  (minimax vs zai), provider-specific tools follow (`minimax_*` or `z_ai_*`);
  built-in tools and unrelated extension tools are left untouched. Listens to
  both `session_start` (covers first launch and `/reload`, since the model is
  loaded straight from settings there without a `model_select` event) and
  `model_select` (manual switches via `/model` or Ctrl+P). Both paths call the
  same idempotent sync helper. To wire a new provider, edit `PROVIDER_TOOLS`.
- **`usage-tracker.ts`**: Polls the active coding-plan provider's quota
  endpoint every 5 minutes and surfaces a low-quota warning in the status bar
  (`zai 5h:75%(2h13m) · wk:20%(4d3h)`). Also exposes `/usage` to show a
  detailed quota panel on demand. Multi-provider via an adapter pattern:
  MiniMax Coding Plan (`/coding_plan/remains`) and Z.ai GLM Coding Plan
  (`/monitor/usage/quota/limit`). Snapshot is normalized to a single polarity
  everywhere: `usedPercent` = CONSUMED percentage (0 = empty, 100 = exhausted),
  which is the opposite of MiniMax's raw "remaining" field, so the MiniMax
  adapter inverts it. Z.ai gotcha: it can return HTTP 200 with an error body
  (`{ success:false, msg, code }`); the adapter inspects the body, not just
  `ok`. Reads the API key from `~/.pi/agent/auth.json` first, then falls back
  to `MINIMAX_API_KEY` / `ZAI_API_KEY` (`GLM_API_KEY` as Zhipu legacy).
  Supersedes the single-provider `minimax-usage.ts`.

## `examples/`

Walk-throughs that stitch the pieces above together. Pure documentation, no
code executed by pi at startup.

- **`safari-mcp.md`**: Connect `pi-mcp-extension` to Safari via the
  WebDriver `--mcp` flag, list the bridged tools, and drive a real page from a
  pi session.
