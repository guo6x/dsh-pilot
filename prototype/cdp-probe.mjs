// dsh-pilot prototype: zero-dependency CDP probe.
// Launches headless Edge, connects over native WebSocket (Node >= 22),
// navigates, extracts title/text, captures a screenshot.
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const TMP = join(ROOT, '.tmp')
mkdirSync(TMP, { recursive: true })

const EDGE_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'D:\\environment\\edge\\msedge.exe',
]
const edge = EDGE_CANDIDATES.find(p => existsSync(p))
if (!edge) {
  console.error('NO_EDGE: no msedge.exe found')
  process.exit(2)
}
console.log('edge:', edge)

const sleep = ms => new Promise(r => setTimeout(r, ms))

async function pickPort(base = 9222) {
  for (let port = base; port < base + 20; port++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`)
      if (!res.ok) continue
      return null // someone already owns it
    } catch {
      return port // nothing listening — take it
    }
  }
  return null
}

// --- minimal CDP client over native WebSocket ---
class Cdp {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl)
    this.nextId = 1
    this.pending = new Map()
    this.events = new Map()
    this.ready = new Promise((resolve, reject) => {
      this.ws.onopen = resolve
      this.ws.onerror = e => reject(new Error('ws error'))
    })
    this.ws.onmessage = ev => {
      const msg = JSON.parse(ev.data)
      if (msg.id !== undefined) {
        const p = this.pending.get(msg.id)
        if (!p) return
        this.pending.delete(msg.id)
        if (msg.error) p.reject(new Error(`${msg.error.code}: ${msg.error.message}`))
        else p.resolve(msg.result)
      } else if (msg.method) {
        const list = this.events.get(msg.method)
        if (list) for (const fn of list) fn(msg.params)
      }
    }
  }
  async call(method, params = {}) {
    await this.ready
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }
  on(method, fn) {
    const list = this.events.get(method) ?? []
    list.push(fn)
    this.events.set(method, list)
  }
  close() {
    try { this.ws.close() } catch {}
  }
}

const port = await pickPort()
if (port === null) {
  console.error('NO_PORT: 9222-9241 all busy')
  process.exit(2)
}
console.log('port:', port)

const profileDir = join(TMP, `edge-profile-${port}`)
mkdirSync(profileDir, { recursive: true })

const child = spawn(edge, [
  '--headless=new',
  '--disable-gpu',
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${profileDir}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-features=Translate',
  'about:blank',
], { stdio: 'ignore', windowsHide: true })

let version = null
for (let i = 0; i < 60; i++) {
  await sleep(500)
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`)
    if (res.ok) { version = await res.json(); break }
  } catch {}
}
if (!version) {
  console.error('TIMEOUT: browser did not expose /json/version')
  try { child.kill() } catch {}
  process.exit(2)
}
console.log('browser:', version.Browser)

// Create a target (tab) and get its page-level WebSocket.
const tab = await (await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent('https://example.com')}`, { method: 'PUT' })).json()
console.log('tab:', tab.type, tab.url)

const cdp = new Cdp(tab.webSocketDebuggerUrl)
const loaded = new Promise(resolve => cdp.on('Page.loadEventFired', resolve))
await cdp.call('Page.enable')
await cdp.call('Runtime.enable')
await cdp.call('Page.navigate', { url: 'https://example.com' })
await Promise.race([loaded, sleep(15000)])

const title = (await cdp.call('Runtime.evaluate', { expression: 'document.title', returnByValue: true })).result.value
const text = (await cdp.call('Runtime.evaluate', {
  expression: 'document.body ? document.body.innerText.slice(0, 500) : ""',
  returnByValue: true,
})).result.value
const shot = await cdp.call('Page.captureScreenshot', { format: 'png' })

const shotPath = join(TMP, 'probe.png')
writeFileSync(shotPath, Buffer.from(shot.data, 'base64'))
console.log('TITLE:', title)
console.log('TEXT:', JSON.stringify(text))
console.log('SHOT:', shotPath, `(${Buffer.from(shot.data, 'base64').length} bytes)`)

cdp.close()
try { child.kill() } catch {}
process.exit(0)
