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
└── extensions/
    ├── exit-on-text.ts
    └── minimax-usage.ts
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
| `theme` | `light` | `dark` |
| `packages` | see below | `[]` |
| `hideThinkingBlock` | `true` | `false` |
| `terminal.showTerminalProgress` | `true` | `false` |
| `warnings.anthropicExtraUsage` | `false` | `true` |

## `packages.json`

npm packages I install into `~/.pi/agent/npm/` via `pi add-package <name>`.
Versions are pinned to what is currently running on my machine so the
reference is reproducible; bump them when upgrading pi.

| Package | Version | Purpose |
|---|---|---|
| `pi-web-access` | `0.10.7` | Web search and URL fetching |
| `@sinamtz/pi-minimax-provider` | `1.1.5` | Provider for the MiniMax Coding Plan API |

## `extensions/`

TypeScript extensions I wrote. They live at `~/.pi/agent/extensions/` and are
auto-loaded by pi on startup. Each one is a self-contained `default export`
function that calls `pi.on(...)` or `pi.registerCommand(...)`.

- **`exit-on-text.ts`**: Treats literal `exit` or `quit` in the editor as a
  REPL-style shutdown. Hooks the `input` event so the LLM is never called
  for that input.
- **`minimax-usage.ts`**: Polls the MiniMax Coding Plan `/remains` endpoint
  every 5 minutes and surfaces a low-quota warning in the status bar
  (`minimax 5h:75%(2h13m) · wk:20%(4d3h)`). Also exposes `/minimax-usage` to
  show a detailed quota panel on demand. Reads the API key from
  `~/.pi/agent/auth.json` first, then falls back to `MINIMAX_API_KEY`.

## What is NOT in this repo

- **`auth.json`**: Holds the actual API key. Never committed.
- **`sessions/`**: Conversation logs, can contain personal data.
- **`npm/`**: `node_modules` for the installed packages, ~285 MB, regenerated
  from `packages.json` on first run.
- **`bin/fd`, `bin/rg`**: Pre-built arm64 binaries, machine-specific.
- **`trust.json`**: Per-machine trust decisions for project directories.

## Status

Maintained by hand. I edit `settings.json` and the extension source files
directly, then commit the result. No automation, no installer.
