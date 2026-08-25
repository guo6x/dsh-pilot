# Contributing

Thanks for taking an interest in dsh-pilot. It is a small, zero-runtime-dependency bundle plugin for DeepSeek Harness; contributions that keep it that way are welcome.

## Dev setup

Requirements: Node ≥ 22 (native WebSocket/fetch), pnpm, and Edge or Chrome on the machine.

```sh
pnpm install          # devDependency: esbuild only
node build.mjs        # lib/index.js (host ESM) + lib/client.js (ModuleLoader bundle)
node tests/smoke.mjs  # 25 end-to-end checks against a real headless Edge
```

## Repo layout

| Path | What it is |
|---|---|
| `src/index.js` | Host plugin: Cdp client, Pilot, PilotPool, routes, 17 tools |
| `src/client/index.jsx` | Cockpit panel (sidebar entry + draggable overlay) |
| `lib/` | Built artifacts — **committed** (installs run without build scripts) |
| `tests/smoke.mjs` | Real-browser end-to-end smoke test |
| `demo/record-demo.mjs` | Cockpit demo recorder with per-step assertions |
| `docs/demo.gif` | Generated demo animation |

## Conventions

- **Zero runtime dependencies is a hard rule.** Node ≥ 22 globals (WebSocket, fetch) only; no playwright/puppeteer/ws.
- **Text-first for the model.** Snapshots and render text are what a text-only model reads — keep the numbered-element contract stable.
- **Every new tool gets a smoke check** in `tests/smoke.mjs` and a row in both README tool tables.
- **Refs are page-scoped.** Anything that navigates invalidates them; new navigation paths must go through the settling pattern (register the load waiter before triggering the action).
- **JSON files must never be written through PowerShell** (BOM accidents break dsh boot); use node or an editor.
- Keep README.md / README.zh.md in sync, and add a CHANGELOG entry.

## Commit messages

`type: subject` — `feat:`, `fix:`, `docs:`, `test:`, `chore:`. Reference the version bump in the commit.

## Testing the plugin live

```sh
# link into the web profile (host code needs a dsh web restart)
dsh plugin --profile web add <path-to-repo>
```

Then drive it with the cockpit panel or let an agent session use the `pilot_*` tools.
