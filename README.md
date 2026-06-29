# pi-config

Personal reference of the diff applied to [pi coding agent](https://pi.dev)
beyond its defaults. Not a starter template, not a turnkey installer: just
the exact knobs I changed, the extensions I wrote, and the packages I
install on top of a clean `pi` setup.

## Layout

```
pi-config/
├── README.md
├── settings.json       # fields I changed vs pi's defaults (delta only)
├── packages.json       # npm packages I install on top of pi (versions)
└── extensions/
    ├── exit-on-text.ts
    └── usage-tracker.ts
```

## `settings.json`

Only the fields that differ from pi's documented defaults. The full default
table lives in [the pi docs](https://pi.dev/docs/latest/settings). I keep this
file as a delta so that any new default pi introduces in a future release
takes effect on a fresh clone without me having to mirror the change here.

| Field | Value | pi default |
|---|---|---|
| `defaultProvider` | `minimax` | unset |
| `defaultModel` | `MiniMax-M3` | unset |
| `defaultThinkingLevel` | `high` | unset |
| `theme` | `light/dark` | `dark` |
| `packages` | see below | `[]` |
| `hideThinkingBlock` | `true` | `false` |
| `terminal.showTerminalProgress` | `true` | `false` |
| `warnings.anthropicExtraUsage` | `false` | `true` |

Other settings I use (`compaction.enabled`, `steeringMode`, `followUpMode`,
`transport`, `enableInstallTelemetry`, `defaultProjectTrust`) happen to match
pi's defaults, so they are intentionally absent from the delta.

## `packages.json`

npm packages installed under `~/.pi/agent/npm/` via `pi add-package <name>`.
Versions are pinned to what is currently running on my machine so the
reference is reproducible; bump them when upgrading pi.

| Package | Version | Purpose |
|---|---|---|
| `@sinamtz/pi-minimax-provider` | `1.1.5` | Provider for the MiniMax Coding Plan API |

## Git packages

Tracked via the `packages` array in `settings.json` with the `git:` prefix
and cloned under `~/.pi/agent/git/`. They follow `main`, so for
reproducibility the pinned commit (as of the last sync) is recorded below;
refresh these when you update.

| Package | Commit | Purpose |
|---|---|---|
| `git:github.com/jo-inc/pi-mem` | `f324d0c` | Plain-Markdown memory system (long-term memory, daily logs, scratchpad) |
| `git:github.com/jo-inc/pi-reflect` | `197c210` | Self-improving behavioral files; analyzes session transcripts for correction patterns |
| `git:github.com/skyfallsin/pi-room` | `1ff91e5` | Multi-agent awareness; agents discover peers and steer each other via tmux |
| `git:github.com/skyfallsin/pi-boss` | `303f7d1` | Spawn and manage sub-agents in visible tmux panes (boss mode orchestrator) |

## `extensions/`

TypeScript extensions I wrote. They live at `~/.pi/agent/extensions/` and are
auto-loaded by pi on startup. Each one is a self-contained `default export`
function that calls `pi.on(...)` or `pi.registerCommand(...)`.

- **`exit-on-text.ts`**: Treats literal `exit` or `quit` in the editor as a
  REPL-style shutdown. Hooks the `input` event so the LLM is never called
  for that input.
- **`usage-tracker.ts`**: Polls coding-plan quota endpoints every 5 minutes
  and surfaces a low-quota warning in the status bar when any window crosses
  75% used. Covers two providers through a shared adapter core:
  - MiniMax Coding Plan (`/coding_plan/remains`): 5-hour and weekly windows
    (`minimax 5h:75%(2h13m) · wk:20%(4d3h)`).
  - Z.ai GLM Coding Plan (`/monitor/usage/quota/limit`): `TOKENS_LIMIT`
    windows, classified as `5h`/`wk` by their reset delta, plus the plan
    `level` (e.g. `lite`).

  Only the active provider's quota is shown; switching to an unrelated model
  clears the status. `/usage` shows a detailed quota panel on demand. API
  keys are read from `~/.pi/agent/auth.json` first, then the matching env
  var (`MINIMAX_API_KEY`, `ZAI_API_KEY`, or legacy `GLM_API_KEY`).
