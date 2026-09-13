# Changelog

All notable changes to dsh-pilot. Versions follow the running history of the GitHub repo; installs pin to `master` (or a specific version once npm publishing is enabled).

## [0.7.2] - 2026-09-13

### Fixed

- Browser profiles are no longer orphaned in the temp directory ([#6](https://github.com/guo6x/dsh-pilot/issues/6)). `stop()` swallowed a failed removal in an empty `catch` and forgot the path anyway, an unexpected browser exit never cleaned up at all, and a force-killed host left its profile behind forever. Removal now waits for the browser process, retries while Windows releases crashpad/GPU handles, reports a failure instead of hiding it, and keeps the path until the directory is confirmed gone.
- Every launch sweeps the temp directory for abandoned `dsh-pilot-*` profiles: first whatever this process queued after a failed removal, then any profile older than an hour that no live launch owns. A directory name must match `mkdtemp`'s exact shape, so unrelated fixtures under the same prefix are never touched.
- A browser that fails to spawn is handled (`child` `error`) instead of skipping profile cleanup.
- A debugging port is chosen by binding it instead of probing it over HTTP, and a pilot only drives a browser whose endpoint reports that same port. A busy browser could miss the old 400 ms probe, which let a new pilot take an occupied port and drive another session's browser.

### Tests

- The smoke suite now asserts that a stopped browser's profile is gone, that an externally killed browser's profile is reclaimed, and that the start-up sweep removes a stale profile while leaving a fresh one and unrelated fixtures alone.

## [0.7.1] - 2026-08-25

### Changed

- Put a real cockpit recording and a copy-paste first-run path above the fold in both READMEs: install, restart, visible success signal, first safe task, and recovery steps.
- Extend the demo recorder to show pinning a cockpit session and returning to automatic following when a multi-session fixture is available.

## [0.7.0] - 2026-08-25

### Added

- A cockpit session switcher: choose any live agent session to inspect its isolated browser, or choose **Latest activity** to follow the most recently active one automatically.
- The cockpit state endpoint now provides lightweight session metadata and accepts a loopback-only session-selection request. Existing `sessions` and `session` fields remain available for older clients.

## [0.6.1] - 2026-08-25

### Fixed

- Make GitHub installation the primary documented command while npm publishing remains unavailable.
- Verify the packed release contents in the standard test command, so every installable entrypoint is checked in CI.

### Changed

- Add copyable 60-second browser and bounded form-workflow prompts, plus an at-a-glance comparison of the ref-driven, human-visible control model.

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
