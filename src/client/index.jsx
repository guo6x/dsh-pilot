/**
 * dsh-pilot client: sidebar entry + draggable cockpit overlay.
 * Talks to the host over same-origin fetch to /dsh-pilot/* (no RPC bridge).
 */
import React, { useEffect, useRef, useState } from 'react'

export const name = 'dsh-pilot'
export const inject = ['slots']

const POLL_MS = 2000

/**
 * i18n for the bundled cockpit. The client runs in the browser via the web
 * app's ModuleLoader — cordis/i18n are not available here, so we ship a small
 * self-contained map keyed per-locale. Every visible string is stored under
 * both `en` and `zh`; Chinese literals stay verbatim in `zh`, never translated.
 */
const STRINGS = {
  en: {
    cockpit: "Browser cockpit",
    sessionTip: "Pick the session to watch in the cockpit; 'Most recently active' follows the agent automatically",
    latest: "Most recently active",
    collapse: "Collapse",
    starting: "Browser starting...",
    notStarted: "Not started - click 'Start browser' below",
    startBtn: "Start browser",
    startShort: "\u25B6 Start",
    stopBtn: "Stop browser",
    stopShort: "\u25A0 Stop",
    addrTip: "Address bar",
    go: "Go"
  },
  zh: {
    cockpit: "\u6D4F\u89C8\u5668\u9A7E\u9A76\u8231",
    sessionTip: "\u9009\u62E9\u8981\u5728\u9A7E\u9A76\u8231\u4E2D\u67E5\u770B\u7684\u4F1A\u8BDD\uFF1B\u201C\u6700\u8FD1\u6D3B\u8DC3\u201D\u4F1A\u81EA\u52A8\u8DDF\u968F agent",
    latest: "\u6700\u8FD1\u6D3B\u8DC3",
    collapse: "\u6536\u8D77",
    starting: "\u6D4F\u89C8\u5668\u542F\u52A8\u4E2D\u2026",
    notStarted: "\u672A\u542F\u52A8\uFF0C\u70B9\u4E0B\u65B9\u300C\u542F\u52A8\u6D4F\u89C8\u5668\u300D",
    startBtn: "\u542F\u52A8\u6D4F\u89C8\u5668",
    startShort: "\u25B6 \u542F\u52A8",
    stopBtn: "\u5173\u95ED\u6D4F\u89C8\u5668",
    stopShort: "\u25A0 \u5173\u95ED",
    addrTip: "\u5730\u5740\u680F",
    go: "\u524D\u5F80"
  }
}

/** Current locale: `window.dsh.locale` if present, else navigator.language, else 'en'. */
function getLocale() {
  try {
    const p = (typeof window !== 'undefined' && window.dsh && window.dsh.locale) || '';
    if (/^zh/i.test(p)) return 'zh';
  } catch {}
  try {
    if (/^zh/i.test(navigator.language)) return 'zh';
  } catch {}
  return 'en';
}

/** Resolve a string key for the current locale, falling back to English. */
function t(key) {
  return STRINGS[getLocale()][key] || STRINGS.en[key];
}

/** Tiny module store so the sidebar button and the overlay share open state. */
const store = { open: false, listeners: new Set() }
function setOpen(open) {
  store.open = open
  for (const listener of store.listeners) listener()
}
function useOpen() {
  const [open, setOpenState] = useState(store.open)
  useEffect(() => {
    const listener = () => setOpenState(store.open)
    store.listeners.add(listener)
    return () => { store.listeners.delete(listener) }
  }, [])
  return [open, setOpen]
}

const panelStyle = {
  position: 'fixed',
  top: '4.5rem',
  left: '20rem',
  zIndex: 1200,
  width: 340,
  borderRadius: 12,
  overflow: 'hidden',
  background: 'rgba(24, 26, 32, 0.96)',
  border: '1px solid rgba(255, 255, 255, 0.14)',
  boxShadow: '0 12px 40px rgba(0, 0, 0, 0.45)',
  fontFamily: 'system-ui, sans-serif',
  color: '#e8eaf0',
  userSelect: 'none',
}
const barStyle = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '8px 10px',
  cursor: 'move',
  background: 'rgba(255, 255, 255, 0.06)',
}
const btnStyle = {
  background: 'rgba(255, 255, 255, 0.12)',
  color: '#e8eaf0',
  border: 'none',
  borderRadius: 6,
  padding: '4px 10px',
  cursor: 'pointer',
  fontSize: 12,
}
const shotWrapStyle = {
  height: 220,
  background: '#101218',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  overflow: 'hidden',
}
const shotStyle = { maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }

async function post(path, body) {
  const res = await fetch(`/dsh-pilot/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  })
  if (!res.ok) throw new Error(`pilot: http ${res.status}`)
  return res.json()
}

function PilotPanel() {
  const [open] = useOpen()
  const [state, setState] = useState(null)
  const [tick, setTick] = useState(0)
  const [busy, setBusy] = useState(false)
  const [navUrl, setNavUrl] = useState('')
  const [pos, setPos] = useState({ x: null, y: null })
  const drag = useRef(null)

  useEffect(() => {
    if (!open) return
    let alive = true
    const poll = async () => {
      try {
        const res = await fetch('/dsh-pilot/state', { cache: 'no-store' })
        if (res.ok && alive) {
          setState(await res.json())
          setTick(t => t + 1)
        }
      } catch {}
    }
    poll()
    const timer = setInterval(poll, POLL_MS)
    return () => { alive = false; clearInterval(timer) }
  }, [open])

  if (!open) return null

  const run = async (action, body) => {
    setBusy(true)
    try {
      const next = await post(action, body)
      setState(next)
      if (action === 'navigate') setNavUrl('')
      setTick(t => t + 1)
    } catch (error) {
      console.error('[dsh-pilot]', error)
    } finally {
      setBusy(false)
    }
  }

  const onPointerDown = event => {
    drag.current = { startX: event.clientX, startY: event.clientY, baseX: pos.x ?? 0, baseY: pos.y ?? 0 }
    const move = moveEvent => {
      const d = drag.current
      if (d === null) return
      setPos({ x: d.baseX + moveEvent.clientX - d.startX, y: d.baseY + moveEvent.clientY - d.startY })
    }
    const up = () => {
      drag.current = null
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const style = pos.x === null ? panelStyle : { ...panelStyle, left: pos.x, top: pos.y }

  return React.createElement('div', { style, onPointerDown },
    React.createElement('div', { style: barStyle },
      React.createElement('span', { style: { fontSize: 16, lineHeight: 1, whiteSpace: 'nowrap' }, title: t('cockpit') }, '🛩️'),
      React.createElement('span', { style: { flex: 1 } }),
      state?.sessionOptions?.length > 1
        ? React.createElement('select', {
            style: { width: 160, minWidth: 0, background: 'rgba(255,255,255,0.08)', color: '#e8eaf0', border: '1px solid rgba(255,255,255,0.15)', borderRadius: 5, padding: '3px 5px', fontSize: 11 },
            value: state.selectedSession ?? 'latest',
            disabled: busy,
            title: t('sessionTip'),
            onPointerDown: event => event.stopPropagation(),
            onChange: event => run('select-session', { session: event.target.value }),
          }, [
            React.createElement('option', { key: 'latest', value: 'latest' }, t('latest')),
            ...state.sessionOptions.map(option => React.createElement(
              'option',
              { key: option.id, value: option.id },
              `${option.primary ? '● ' : ''}${option.id}${option.title ? ` — ${option.title.slice(0, 40)}` : ''}`,
            )),
          ])
        : null,
      React.createElement('span', { style: { fontSize: 11, opacity: 0.7 } }, state?.status ?? '…'),
      React.createElement('button', { style: btnStyle, onClick: () => setOpen(false), title: t('collapse') }, '×'),
    ),
    React.createElement('div', { style: shotWrapStyle },
      state?.status === 'ready' && tick > 0
        ? React.createElement('img', { src: `/dsh-pilot/shot.png?t=${tick}`, style: shotStyle, draggable: false })
        : React.createElement('span', { style: { fontSize: 12, opacity: 0.55 } },
            state?.status === 'starting' ? t('starting') : t('notStarted')),
    ),
    React.createElement('div', { style: { padding: '8px 10px', display: 'flex', gap: 6, flexWrap: 'wrap' } },
      React.createElement('button', { style: btnStyle, disabled: busy, title: t('startBtn'), onClick: () => run('start') }, t('startShort')),
      React.createElement('button', { style: btnStyle, disabled: busy, title: t('stopBtn'), onClick: () => run('stop') }, t('stopShort')),
      React.createElement('input', {
        style: { flex: 1, minWidth: 120, background: 'rgba(255,255,255,0.08)', color: '#e8eaf0', border: '1px solid rgba(255,255,255,0.15)', borderRadius: 6, padding: '4px 8px', fontSize: 12 },
        placeholder: 'https://…',
        title: t('addrTip'),
        value: navUrl,
        onChange: event => setNavUrl(event.target.value),
        onKeyDown: event => { if (event.key === 'Enter') run('navigate', { url: navUrl }) },
      }),
      React.createElement('button', { style: btnStyle, disabled: busy || !/^https?:\/\//.test(navUrl), title: t('go'), onClick: () => run('navigate', { url: navUrl }) }, t('go')),
    ),
    state?.title || state?.url
      ? React.createElement('div', { style: { padding: '0 10px 6px', fontSize: 11, opacity: 0.75, wordBreak: 'break-all' } },
          `${state.title || ''} ${state.url || ''}`)
      : null,
    state?.log?.length
      ? React.createElement('div', { style: { padding: '0 10px 10px', fontSize: 10, opacity: 0.6, maxHeight: 72, overflow: 'hidden' } },
          state.log.slice(-4).map(entry => `${new Date(entry.t).toLocaleTimeString()} ${entry.msg}`).join('\n'))
      : null,
  )
}

function PilotButton() {
  const [open, openSet] = useOpen()
  return React.createElement('button', {
    title: t('cockpit'),
    style: { background: 'none', border: 'none', cursor: 'pointer', fontSize: 15, padding: 4 },
    onClick: () => openSet(!open),
  }, open ? '🛩️' : '✈️')
}

export function apply(ctx) {
  const slots = ctx.slots
  if (slots === undefined) return
  slots.inject('sidebar.footer.action', () => slots.register(
    { name: 'sidebar.footer.action', id: 'dsh-pilot', order: 900, label: t('cockpit') },
    () => React.createElement(PilotButton),
  ))
  slots.inject('shell.overlay', () => slots.register(
    { name: 'shell.overlay', id: 'dsh-pilot-panel', order: 200, label: t('cockpit') },
    () => React.createElement(PilotPanel),
  ))
}
