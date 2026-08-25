# 🛩️ dsh-pilot — give your DSH agent hands

[![Awesome DSH Plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com) [![dsh-recommend](https://img.shields.io/endpoint?url=https%3A%2F%2Fraw.githubusercontent.com%2Fzp-home%2Fdsh-recommend%2Fmain%2Fdata%2Fbadges%2Fguo6x__dsh-pilot.certified.json)](https://github.com/zp-home/dsh-recommend) [![dsh score](https://img.shields.io/endpoint?url=https%3A%2F%2Fraw.githubusercontent.com%2Fzp-home%2Fdsh-recommend%2Fmain%2Fdata%2Fbadges%2Fguo6x__dsh-pilot.json)](https://github.com/zp-home/dsh-recommend) [![ci](https://github.com/guo6x/dsh-pilot/actions/workflows/ci.yml/badge.svg)](https://github.com/guo6x/dsh-pilot/actions/workflows/ci.yml) [中文说明](README.zh.md) · [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin

Drive a **real browser** from the DeepSeek Harness chat: the agent opens pages, reads them as structured text with a **numbered element list**, clicks and types **by ref** (no CSS guessing), presses keys, navigates back/reload, waits, evaluates JS, and takes screenshots — while you watch a live draggable **cockpit panel** in the Web GUI and can take over at any time.

- 🚀 **One command install** — `dsh plugin --profile web add github:guo6x/dsh-pilot`
- ⚡ **Zero runtime dependencies** — talks CDP over the native Node ≥ 22 WebSocket, uses the Edge/Chrome already on your machine
- 🔑 **No API key** — nothing leaves your machine; no vision model required
- 📖 **Text-first by design** — the agent reads DOM snapshots (title/URL/text/links + numbered elements), so **text-only models** browse without burning vision tokens
- 🎯 **Ref-driven interaction** — every click/type targets a snapshot ref, not a guessed selector; stale refs fail loudly with a hint
- 📝 **Human-named forms** — fill several fields by label, aria-label, placeholder, name, or id, and upload files by ref
- 🧭 **Full navigation set** — back, reload, and wait tools for real browsing flows, with page-settling waits built in
- 👀 **Human in the loop** — live screenshot, URL bar, action log, and a session switcher in the cockpit; you see everything the agent does
- 🧩 **Per-session isolation** — every agent session gets its own browser instance; parallel sessions never fight over one page

## Install

```sh
# Install from GitHub — this is the supported release channel.
dsh plugin --profile web add github:guo6x/dsh-pilot

# From a local checkout while developing the plugin:
# dsh plugin --profile web add .
```

Restart `dsh web`, refresh the page. A ✈️ button appears at the sidebar foot — that opens the cockpit.

Requirements: DeepSeek Harness web profile, Node ≥ 22, and Edge or Chrome installed.

![demo](docs/demo.gif)

## See it work in 60 seconds

After restarting `dsh web`, start a chat and ask in plain language:

> Open `https://example.com`, tell me what the page says, then verify that the “Learn more” link is visible.

For a real staging form, give the agent one bounded task:

> Open our staging application form. Fill the contact fields, upload the approved resume at `C:\\path\\to\\resume.pdf`, verify the entered values, and **stop before final submission**.

The agent gets structured page evidence, uses labels and snapshot refs instead of brittle guesses, and the cockpit lets you watch or stop the browser at any time.

## Why it feels different

| What usually goes wrong | What dsh-pilot does instead |
|---|---|
| Agents guess CSS selectors that silently hit the wrong element | Returns a numbered, visible-element snapshot; actions use those refs and stale refs fail loudly |
| Form tasks take many fragile one-field calls | `pilot_fill` resolves human-facing labels and fills text fields, textareas, and selects in one action |
| Browser automation disappears into a black box | Shows a live cockpit with the current page, URL, status, and recent actions |
| Adding browser control pulls in a browser framework and a cloud account | Uses Node 22’s native WebSocket plus the Edge/Chrome already on your machine — no runtime dependency or API key |

## What the agent gets

| Tool | What it does |
|---|---|
| `pilot_open` | Open a URL (launches the browser on first use), return title/URL/text snapshot |
| `pilot_snapshot` | Read the current page as text: title, URL, visible text (8k chars), links, a **numbered element list** (refs), and a **change summary** vs the previous snapshot |
| `pilot_diff` | Report ONLY what changed since the last snapshot (URL/title/text delta, elements added/removed) — judge whether an action worked without re-reading the page |
| `pilot_click` | Click an element **by its snapshot ref** (or CSS selector); scrolls into view first |
| `pilot_type` | Type into an input **by its snapshot ref** (or selector) via the native value setter — React/Vue forms observe it |
| `pilot_fill` | Fill text inputs, textareas, and selects in one call by label/aria-label/placeholder/name/id |
| `pilot_upload` | Upload 1–10 absolute-path files to a file input **by its snapshot ref** (or selector); 100 MB total cap |
| `pilot_press` | Press a key (Enter/Tab/Escape/arrows/single chars) |
| `pilot_back` | Go back in history, waits for the page to settle, returns URL/title |
| `pilot_reload` | Reload the current page, waits for it to settle |
| `pilot_wait` | Wait N ms (1–30000) for async content before the next action |
| `pilot_wait_for` | Wait until page text, a visible element, or a URL condition is met instead of sleeping blindly |
| `pilot_assert` | Immediately verify page text, a visible element, or a URL condition |
| `pilot_screenshot` | Save a PNG and return its path (for vision-capable models or the human) |
| `pilot_download` | Download a resource (default: current page) through the page's own fetch — inherits session cookies; cap 20 MB |
| `pilot_eval` | Evaluate JS in the page, get JSON back |
| `pilot_close` | Stop the browser; the next call relaunches it |

The agent just says what it needs: *"open the login page, fill the form, click submit, and read the result"* — the tools are the same verbs.

## What the human gets

A draggable cockpit overlay: live screenshot (2 s refresh), current URL + title, start/stop buttons, an address bar, and the recent action log. When several sessions are browsing, choose one to inspect or leave it on **Latest activity** to follow the agent automatically. Everything the agent does is visible; close the browser or take over whenever you like.

## Known limitations

- **One tab per session.** Refs are pinned to the current page, so a tab switcher would invalidate them. Need a second context? Spawn a subagent — each agent session gets its own browser.
- **Headless only.** The cockpit shows the headless view; there is no headed mode (a human driving the same browser is a different product).
- **The panel follows the most recently used session by default.** When several sessions exist, you can pin the cockpit to any one of them; switch back to **Latest activity** to resume automatic following.

## How it works

```
DSH chat ──pilot_* tools──▶ host plugin ──CDP (native WebSocket)──▶ headless Edge/Chrome
    ▲                              │
    └── structured text snapshots ◀┘
GUI cockpit ◀──/dsh-pilot/state + /dsh-pilot/shot.png (loopback)──┘
```

- Launches `msedge`/`chrome` headless with an isolated `--user-data-dir` under the OS temp dir and a dynamically picked debugging port (9222+); the whole tree is killed and the profile removed on stop.
- The host registers 17 tools plus a loopback-only HTTP API (`/dsh-pilot/*`, 403 for non-loopback clients).
- The client is a small overlay panel registered in `sidebar.footer.action` + `shell.overlay`.

## Security

- Browser runs **headless with an isolated profile**; it never touches your real browser session.
- The HTTP API binds to the DSH server (loopback by default) and rejects non-loopback clients explicitly.
- `pilot_open` accepts http(s) URLs only; `pilot_eval` runs page-context JS (same trust as opening DevTools yourself — do not point the agent at pages you don't trust).
- `pilot_upload` accepts existing absolute regular files only; upload only files the user has authorized for the current site.
- No telemetry, no network calls to third parties, no API keys.

## Develop

```sh
pnpm install
pnpm test             # build, real-headless-Edge flow, and package-content check
```

MIT licensed. Found a bug or an idea? Open an issue.

## Related

- Chinese dev log (掘金): [我给我的 agent 装了双手：零依赖浏览器操控插件开发记](https://juejin.cn/post/7674905370994982927)
