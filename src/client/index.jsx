/**
 * dsh-pilot client: sidebar entry + draggable cockpit overlay.
 * Talks to the host over same-origin fetch to /dsh-pilot/* (no RPC bridge).
 */
import React, { useEffect, useRef, useState } from 'react'

export const name = 'dsh-pilot'
export const inject = ['slots']

const POLL_MS = 2000

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
      React.createElement('span', { style: { fontSize: 13, fontWeight: 700 } }, '🛩️ 浏览器驾驶舱'),
      React.createElement('span', { style: { flex: 1 } }),
      React.createElement('span', { style: { fontSize: 11, opacity: 0.7 } }, state?.status ?? '…'),
      React.createElement('button', { style: btnStyle, onClick: () => setOpen(false), title: '收起' }, '×'),
    ),
    React.createElement('div', { style: shotWrapStyle },
      state?.status === 'ready' && tick > 0
        ? React.createElement('img', { src: `/dsh-pilot/shot.png?t=${tick}`, style: shotStyle, draggable: false })
        : React.createElement('span', { style: { fontSize: 12, opacity: 0.55 } },
            state?.status === 'starting' ? '浏览器启动中…' : '未启动，点下方「启动浏览器」'),
    ),
    React.createElement('div', { style: { padding: '8px 10px', display: 'flex', gap: 6, flexWrap: 'wrap' } },
      React.createElement('button', { style: btnStyle, disabled: busy, onClick: () => run('start') }, '▶ 启动'),
      React.createElement('button', { style: btnStyle, disabled: busy, onClick: () => run('stop') }, '■ 关闭'),
      React.createElement('input', {
        style: { flex: 1, minWidth: 120, background: 'rgba(255,255,255,0.08)', color: '#e8eaf0', border: '1px solid rgba(255,255,255,0.15)', borderRadius: 6, padding: '4px 8px', fontSize: 12 },
        placeholder: 'https://…',
        value: navUrl,
        onChange: event => setNavUrl(event.target.value),
        onKeyDown: event => { if (event.key === 'Enter') run('navigate', { url: navUrl }) },
      }),
      React.createElement('button', { style: btnStyle, disabled: busy || !/^https?:\/\//.test(navUrl), onClick: () => run('navigate', { url: navUrl }) }, '前往'),
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
    title: '浏览器驾驶舱',
    style: { background: 'none', border: 'none', cursor: 'pointer', fontSize: 15, padding: 4 },
    onClick: () => openSet(!open),
  }, open ? '🛩️' : '✈️')
}

export function apply(ctx) {
  const slots = ctx.slots
  if (slots === undefined) return
  slots.inject('sidebar.footer.action', () => slots.register(
    { name: 'sidebar.footer.action', id: 'dsh-pilot', order: 900, label: '浏览器驾驶舱' },
    () => React.createElement(PilotButton),
  ))
  slots.inject('shell.overlay', () => slots.register(
    { name: 'shell.overlay', id: 'dsh-pilot-panel', order: 200, label: '浏览器驾驶舱' },
    () => React.createElement(PilotPanel),
  ))
}
