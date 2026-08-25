# Changelog

All notable changes to dsh-pilot. Versions follow the running history of the GitHub repo; installs pin to `master` (or a specific version once npm publishing is enabled).

## [0.6.0] - 2026-08-25

### Added

- `pilot_fill` — fills up to 20 text inputs, textareas, and selects in one call by their visible label, aria-label, placeholder, name, or id. Values go through native setters and input/change events without entering the action log.
- `pilot_upload` — assigns one to ten existing absolute-path files to a file input through CDP, by snapshot ref or CSS selector; regular files only, 100 MB total cap.
- End-to-end local-form coverage for label-driven filling, select choices, file-input assignment, and the resulting `change` event.

## [0.5.0] - 2026-08-25

### Added

- `pilot_wait_for` — polls until all supplied text, visible-selector, and/or URL conditions are met (up to 30 seconds), so agents can wait for asynchronous pages without guessing a sleep duration.
- `pilot_assert` — checks the same conditions exactly once and returns explicit evidence for the agent's next decision.

## [0.4.1] - 2026-08-15

### Added

- `pilot_download` — a 13th tool that downloads a resource (default: the current page) through the page's own `fetch`, inheriting cookies/session auth; saves to the session workspace by default, 20 MB cap.

## [0.4.0] - 2026-08-15

### Added

- **Snapshot diffing**: `pilot_snapshot` returns a `changed` summary versus the previous snapshot (URL/title changes, text length delta, elements added/removed by fingerprint match); the diff window resets on navigation.
- `pilot_diff` — a 12th tool that reports ONLY the change summary, so a text-only agent can judge whether an action worked without re-reading the whole page.

## [0.3.0] - 2026-08-15

### Added

- `pilot_back` — go back in history, waits for the page to settle
- `pilot_reload` — reload the current page, waits for it to settle
- `pilot_wait` — wait 1–30000 ms for async page content
- Cockpit panel shows a session indicator (`×N`) when several sessions are browsing

### Fixed

- Click now registers its load waiter **before** triggering the click, so the navigation settles correctly even when the load event fires faster than the listener registration (race condition in 0.2.x); click returns the settled URL and title
- `waitForLoad` never rejects on timeout

## [0.2.1] - 2026-08-15

### Fixed

- `pilot_screenshot` creates missing parent directories instead of failing with ENOENT
- `pilot_close` returns lossless JSON (`{ok, status}`) instead of `undefined`, which the harness rejected as "not lossless JSON"

## [0.2.0] - 2026-08-15

### Added

- **Element ref bridge**: `pilot_snapshot`/`pilot_open` return a numbered interactive-element list; `pilot_click`/`pilot_type` accept a `ref` (number) and no longer require CSS selectors. Stale refs fail loudly with a hint to re-snapshot.
- **Per-session browser pool**: each agent session gets its own browser (LRU-capped at 8); the cockpit panel follows the most recently active session.

### Fixed

- `pickPort` skips occupied debugging ports instead of giving up on the first one

## [0.1.4] - 2026-08-15

- npm-first install instructions (npm publishing pending 2FA)

## [0.1.3] - 2026-08-15

### Fixed

- Stripped a UTF-8 BOM from `package.json` that broke dsh profile boot

## [0.1.2] - 2026-08-15

### Added

- Panel buttons/inputs carry `title` attributes (accessibility + automation)
- Demo recorder script with per-step assertions

### Fixed

- `pickPort` bug (superseded by the 0.2.0 fix)

## [0.1.1] - 2026-08-15

### Fixed

- **inject timing**: declared `inject: ['webServer', 'tools']` so route/tool registration happens after those services activate; previously `ctx.get()` at apply time returned `undefined` and the plugin registered nothing

## [0.1.0] - 2026-08-15

### Added

- Zero-dependency CDP client over the native Node ≥ 22 WebSocket
- Headless Edge/Chrome controller with isolated profiles and dynamic debugging ports
- Loopback-only HTTP API (`/dsh-pilot/*`)
- First tool set: `pilot_open`, `pilot_snapshot`, `pilot_click`, `pilot_type`, `pilot_press`, `pilot_screenshot`, `pilot_eval`, `pilot_close`
- Draggable cockpit panel (sidebar entry + overlay), bilingual README, end-to-end smoke test
