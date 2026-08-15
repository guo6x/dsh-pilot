/**
 * dsh-pilot host plugin.
 *
 * Owns a headless Edge/Chrome instance, talks CDP over the native Node >= 22
 * WebSocket (zero runtime dependencies), serves a loopback JSON/PNG API for
 * the client cockpit panel, and registers pilot_* tools for the agent.
 *
 * Agent-facing design: the model reads STRUCTURED text snapshots (title, url,
 * body text, links) instead of screenshots, so text-only models can drive the
 * browser without spending vision tokens. Screenshots exist for the human
 * panel and for vision-capable models via pilot_screenshot.
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const name = 'dsh-pilot'
export const inject = []

const LOOPBACKS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])
const EDGE_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'D:\\environment\\edge\\msedge.exe',
  '/usr/bin/microsoft-edge',
  '/usr/bin/microsoft-edge-stable',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
]
const MAX_TEXT = 8000
const MAX_EVAL = 20000
const MAX_LOG = 200
const NAV_TIMEOUT_MS = 20000

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/** Minimal CDP client over the native WebSocket. */
export class Cdp {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl)
    this.nextId = 1
    this.pending = new Map()
    this.events = new Map()
    this.ready = new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, { once: true })
      this.ws.addEventListener('error', () => reject(new Error('pilot: websocket connect failed')), { once: true })
    })
    this.ws.addEventListener('message', event => {
      let msg
      try { msg = JSON.parse(event.data) } catch { return }
      if (msg.id !== undefined) {
        const pending = this.pending.get(msg.id)
        if (pending === undefined) return
        this.pending.delete(msg.id)
        if (msg.error) pending.reject(new Error(`pilot: cdp ${msg.error.code} ${msg.error.message}`))
        else pending.resolve(msg.result)
      } else if (msg.method !== undefined) {
        for (const listener of this.events.get(msg.method) ?? []) listener(msg.params)
      }
    })
  }

  async call(method, params = {}, timeoutMs = 15000) {
    await this.ready
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`pilot: cdp timeout ${method}`))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: value => { clearTimeout(timer); resolve(value) },
        reject: error => { clearTimeout(timer); reject(error) },
      })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }

  once(method, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const list = this.events.get(method) ?? []
        const at = list.indexOf(listener)
        if (at !== -1) list.splice(at, 1)
        reject(new Error(`pilot: event timeout ${method}`))
      }, timeoutMs)
      const listener = params => {
        clearTimeout(timer)
        const list = this.events.get(method) ?? []
        const at = list.indexOf(listener)
        if (at !== -1) list.splice(at, 1)
        resolve(params)
      }
      const list = this.events.get(method) ?? []
      list.push(listener)
      this.events.set(method, list)
    })
  }

  close() {
    try { this.ws.close() } catch {}
  }
}

/** One headless browser session: launch, CDP page target, page operations. */
export class Pilot {
  constructor(options = {}) {
    this.status = 'stopped' // stopped | starting | ready | error
    this.url = ''
    this.title = ''
    this.lastShot = null
    this.lastShotAt = 0
    this.lastError = ''
    this.log = []
    this.child = null
    this.cdp = null
    this.port = 0
    this.profileDir = null
    this.opLock = Promise.resolve()
    this.stopping = false
    this.edgePath = options.edgePath ?? null
  }

  note(type, msg) {
    this.log.push({ t: Date.now(), type, msg: String(msg).slice(0, 500) })
    if (this.log.length > MAX_LOG) this.log.splice(0, this.log.length - MAX_LOG)
  }

  state() {
    return {
      status: this.status,
      url: this.url,
      title: this.title,
      error: this.lastError,
      pid: this.child?.pid ?? null,
      port: this.port,
      shotAt: this.lastShotAt,
      log: this.log.slice(-50),
    }
  }

  findEdge() {
    if (this.edgePath && existsSync(this.edgePath)) return this.edgePath
    const found = EDGE_CANDIDATES.find(path => existsSync(path))
    if (found === undefined) throw new Error('pilot: no Edge/Chrome executable found; install one or set edgePath')
    return found
  }

  async pickPort(base = 9222) {
    for (let port = base; port < base + 20; port++) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(400) })
        if (!res.ok) continue
        return null
      } catch {
        return port
      }
    }
    return null
  }

  async withOp(operation) {
    const run = this.opLock.then(operation, operation)
    this.opLock = run.catch(() => {})
    return run
  }

  async ensure() {
    if (this.status === 'ready' && this.cdp !== null) return
    if (this.status === 'starting') throw new Error('pilot: browser still starting, retry shortly')
    this.status = 'starting'
    this.note('info', 'launching browser')
    const edge = this.findEdge()
    const port = await this.pickPort()
    if (port === null) throw new Error('pilot: no free debugging port in 9222..9241')
    this.port = port
    this.profileDir = await mkdtemp(join(tmpdir(), 'dsh-pilot-'))
    const argv = [
      '--headless=new',
      '--disable-gpu',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${this.profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-features=Translate',
      'about:blank',
    ]
    this.child = spawn(edge, argv, { stdio: 'ignore', windowsHide: true })
    this.child.once('exit', (code, signal) => {
      const wasStopping = this.stopping
      this.child = null
      this.cdp?.close()
      this.cdp = null
      this.status = 'stopped'
      if (!wasStopping) {
        this.lastError = `browser exited (code=${code} signal=${signal ?? 'none'})`
        this.note('error', this.lastError)
      }
    })
    try {
      await this.waitForVersion(port)
      const tab = await this.newTab(port, 'about:blank')
      this.cdp = new Cdp(tab.webSocketDebuggerUrl)
      await this.cdp.call('Page.enable')
      await this.cdp.call('Runtime.enable')
      this.status = 'ready'
      this.lastError = ''
      this.note('info', `browser ready on port ${port}`)
    } catch (error) {
      this.status = 'error'
      this.lastError = String(error.message ?? error)
      this.note('error', this.lastError)
      await this.stop()
      throw error
    }
  }

  async waitForVersion(port) {
    for (let i = 0; i < 60; i++) {
      await sleep(500)
      try {
        const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500) })
        if (res.ok) return res.json()
      } catch {}
    }
    throw new Error('pilot: browser did not expose the debugging endpoint in time')
  }

  async newTab(port, url) {
    const res = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' })
    if (!res.ok) throw new Error(`pilot: could not create tab (http ${res.status})`)
    return res.json()
  }

  async navigate(url) {
    await this.ensure()
    await this.cdp.call('Page.navigate', { url }, NAV_TIMEOUT_MS)
    await Promise.race([this.cdp.once('Page.loadEventFired', NAV_TIMEOUT_MS), sleep(NAV_TIMEOUT_MS)])
    this.url = url
    this.title = await this.readTitle()
    this.note('nav', url)
    await this.captureShot()
    return this.snapshot()
  }

  async readTitle() {
    try {
      const { result } = await this.cdp.call('Runtime.evaluate', {
        expression: 'document.title',
        returnByValue: true,
      })
      return typeof result.value === 'string' ? result.value : ''
    } catch {
      return ''
    }
  }

  async snapshot() {
    await this.ensure()
    const { result } = await this.cdp.call('Runtime.evaluate', {
      expression: `JSON.stringify((() => {
        const text = document.body ? document.body.innerText : ''
        const links = Array.from(document.querySelectorAll('a')).slice(0, 50).map(a => ({
          t: (a.innerText || a.title || a.getAttribute('aria-label') || '').trim().slice(0, 80),
          h: a.href,
        })).filter(l => l.h)
        return {
          title: document.title,
          url: location.href,
          text: text.slice(0, ${MAX_TEXT}),
          textLength: text.length,
          links,
          buttons: document.querySelectorAll('button').length,
          inputs: document.querySelectorAll('input,textarea,select').length,
        }
      })())`,
      returnByValue: true,
    }, NAV_TIMEOUT_MS)
    const data = JSON.parse(result.value)
    this.url = data.url
    this.title = data.title
    return data
  }

  async click(selector) {
    await this.ensure()
    const { result, exceptionDetails } = await this.cdp.call('Runtime.evaluate', {
      expression: `(() => {
        const el = document.querySelector(${JSON.stringify(selector)})
        if (!el) return { ok: false, error: 'no element matches selector' }
        el.scrollIntoView({ block: 'center' })
        el.click()
        return { ok: true, tag: el.tagName.toLowerCase(), text: (el.innerText || el.value || '').slice(0, 120) }
      })()`,
      returnByValue: true,
    })
    if (exceptionDetails) return { ok: false, error: exceptionDetails.text ?? 'evaluate failed' }
    this.note('click', selector)
    await sleep(400)
    await this.captureShot()
    return { ...result.value, title: await this.readTitle() }
  }

  async type(selector, text) {
    await this.ensure()
    const { result, exceptionDetails } = await this.cdp.call('Runtime.evaluate', {
      expression: `(() => {
        const el = document.querySelector(${JSON.stringify(selector)})
        if (!el) return { ok: false, error: 'no element matches selector' }
        el.focus()
        const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
        Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(text)})
        el.dispatchEvent(new Event('input', { bubbles: true }))
        el.dispatchEvent(new Event('change', { bubbles: true }))
        return { ok: true }
      })()`,
      returnByValue: true,
    })
    if (exceptionDetails) return { ok: false, error: exceptionDetails.text ?? 'evaluate failed' }
    this.note('type', `${selector} <= ${text.slice(0, 60)}`)
    await this.captureShot()
    return result.value
  }

  async press(key) {
    await this.ensure()
    const code = KEY_CODES[key] ?? key
    const virtualKeyCode = KEY_VK[key] ?? 0
    await this.cdp.call('Input.dispatchKeyEvent', {
      type: 'rawKeyDown',
      key,
      code,
      windowsVirtualKeyCode: virtualKeyCode,
      nativeVirtualKeyCode: virtualKeyCode,
    })
    if (key.length === 1) {
      await this.cdp.call('Input.dispatchKeyEvent', { type: 'char', text: key, key })
    }
    await this.cdp.call('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key,
      code,
      windowsVirtualKeyCode: virtualKeyCode,
      nativeVirtualKeyCode: virtualKeyCode,
    })
    this.note('key', key)
    await sleep(200)
    await this.captureShot()
    return { ok: true, key }
  }

  async captureShot() {
    if (this.cdp === null) return null
    try {
      const shot = await this.cdp.call('Page.captureScreenshot', { format: 'png' }, 15000)
      this.lastShot = Buffer.from(shot.data, 'base64')
      this.lastShotAt = Date.now()
      return this.lastShot
    } catch (error) {
      this.note('warn', `screenshot failed: ${error.message}`)
      return this.lastShot
    }
  }

  async evalJs(expression) {
    await this.ensure()
    const { result, exceptionDetails } = await this.cdp.call('Runtime.evaluate', {
      expression,
      returnByValue: true,
    }, NAV_TIMEOUT_MS)
    if (exceptionDetails) return { ok: false, error: exceptionDetails.text ?? 'evaluate failed' }
    let value = result.value
    if (value === undefined) return { ok: true, value: undefined }
    let text
    try { text = JSON.stringify(value) } catch { text = String(value) }
    if (text !== undefined && text.length > MAX_EVAL) text = `${text.slice(0, MAX_EVAL)}…(truncated)`
    return { ok: true, type: result.type, value, text }
  }

  async stop() {
    this.stopping = true
    this.cdp?.close()
    this.cdp = null
    const child = this.child
    this.child = null
    if (child !== null) {
      try {
        if (process.platform === 'win32') {
          await new Promise(resolve => {
            const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
            killer.once('exit', resolve)
            killer.once('error', resolve)
          })
        } else {
          child.kill('SIGKILL')
        }
      } catch {}
    }
    if (this.profileDir !== null) {
      await rm(this.profileDir, { recursive: true, force: true }).catch(() => {})
      this.profileDir = null
    }
    this.status = 'stopped'
    this.url = ''
    this.title = ''
    this.note('info', 'browser stopped')
    this.stopping = false
  }

  async dispose() {
    await this.stop()
  }
}

const KEY_CODES = {
  Enter: 'Enter', Tab: 'Tab', Escape: 'Escape', Backspace: 'Backspace', ArrowUp: 'ArrowUp',
  ArrowDown: 'ArrowDown', ArrowLeft: 'ArrowLeft', ArrowRight: 'ArrowRight', PageUp: 'PageUp',
  PageDown: 'PageDown', Home: 'Home', End: 'End', Delete: 'Delete', ' ': 'Space',
}
const KEY_VK = {
  Enter: 13, Tab: 9, Escape: 27, Backspace: 8, ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37,
  ArrowRight: 39, PageUp: 33, PageDown: 34, Home: 36, End: 35, Delete: 46, ' ': 32,
}

/** JSON body of an incoming POST, capped at 64 KiB. */
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', chunk => {
      size += chunk.length
      if (size > 65536) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(body)
}

export function apply(ctx) {
  const pilot = new Pilot()

  // ---- loopback HTTP API for the cockpit panel ----
  const webServer = ctx.get('webServer')
  if (webServer !== undefined) {
    ctx.effect(() => webServer.register({
      kind: 'prefix',
      path: '/dsh-pilot',
      handler: async (req, res) => {
        const remote = req.socket.remoteAddress ?? ''
        if (!LOOPBACKS.has(remote)) {
          sendJson(res, 403, { error: 'loopback only' })
          return
        }
        const pathname = new URL(req.url ?? '/', 'http://x').pathname
        const suffix = pathname.slice('/dsh-pilot'.length) || '/'
        try {
          if (req.method === 'GET' && suffix === '/state') {
            sendJson(res, 200, pilot.state())
          } else if (req.method === 'GET' && suffix === '/shot.png') {
            if (pilot.lastShot === null) {
              res.writeHead(204, { 'cache-control': 'no-store' })
              res.end()
            } else {
              res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' })
              res.end(pilot.lastShot)
            }
          } else if (req.method === 'POST' && suffix === '/start') {
            await pilot.withOp(() => pilot.ensure())
            sendJson(res, 200, pilot.state())
          } else if (req.method === 'POST' && suffix === '/stop') {
            await pilot.withOp(() => pilot.stop())
            sendJson(res, 200, pilot.state())
          } else if (req.method === 'POST' && suffix === '/navigate') {
            const body = JSON.parse(await readBody(req) || '{}')
            if (typeof body.url !== 'string' || !/^https?:\/\//.test(body.url)) {
              sendJson(res, 400, { error: 'url must be an http(s) URL' })
              return
            }
            await pilot.withOp(() => pilot.navigate(body.url))
            sendJson(res, 200, pilot.state())
          } else {
            sendJson(res, 404, { error: 'no such endpoint' })
          }
        } catch (error) {
          sendJson(res, 500, { error: String(error.message ?? error) })
        }
      },
    }), 'dsh-pilot: web routes')
  }

  // ---- agent tools ----
  const tools = ctx.get('tools')
  if (tools !== undefined) {
    const define = (nameValue, description, parameters, execute, render) => ({
      name: nameValue,
      description,
      parameters,
      timeoutMs: 60000,
      output: {
        schema: { type: 'object' },
        render(_args, value) {
          const blocks = render(value)
          return blocks.length > 0 ? blocks : [{ type: 'text', text: JSON.stringify(value) }]
        },
      },
      async execute(args, exec) {
        if (exec?.signal?.aborted) throw new Error('aborted')
        return execute(args)
      },
    })

    const obj = (properties, required = []) => ({
      type: 'object',
      properties,
      required,
      additionalProperties: false,
    })
    const str = description => ({ type: 'string', description })

    const defs = [
      define(
        'pilot_open',
        'Open a URL in the controlled browser (launches a headless Edge/Chrome if needed). Returns a text snapshot: title, URL, visible text, and links. Prefer this over web_fetch when the page needs JavaScript or interaction.',
        obj({ url: str('Full http(s) URL to open.') }, ['url']),
        async args => pilot.withOp(() => pilot.navigate(args.url)),
        value => [{ type: 'text', text: `[${value.title}](${value.url})\n${value.text.slice(0, 2000)}` }],
      ),
      define(
        'pilot_snapshot',
        'Read the current page state of the controlled browser as text: title, URL, visible text (up to 8000 chars), links, and form element counts. Use this to understand the current page without spending vision tokens.',
        obj({}),
        async () => pilot.withOp(() => pilot.snapshot()),
        value => [{ type: 'text', text: `[${value.title}](${value.url})\n${value.text.slice(0, 4000)}${value.textLength > 4000 ? '\n…(text truncated, ' + value.textLength + ' chars total)' : ''}\nlinks: ${value.links.length}, buttons: ${value.buttons}, inputs: ${value.inputs}` }],
      ),
      define(
        'pilot_click',
        'Click an element in the controlled browser by CSS selector. Scrolls it into view first. Returns ok plus the clicked element tag/text and the new page title.',
        obj({ selector: str('CSS selector of the element to click.') }, ['selector']),
        async args => pilot.withOp(() => pilot.click(args.selector)),
        value => [{ type: 'text', text: value.ok ? `clicked <${value.tag}> "${value.text}" — title now: ${value.title}` : `click failed: ${value.error}` }],
      ),
      define(
        'pilot_type',
        'Type text into an input/textarea in the controlled browser by CSS selector. Sets the value through the native setter and fires input/change events, so framework-managed forms (React/Vue) observe it.',
        obj({
          selector: str('CSS selector of the input or textarea.'),
          text: str('Text to type.'),
        }, ['selector', 'text']),
        async args => pilot.withOp(() => pilot.type(args.selector, args.text)),
        value => [{ type: 'text', text: value.ok ? 'typed' : `type failed: ${value.error}` }],
      ),
      define(
        'pilot_press',
        'Press a keyboard key in the controlled browser (Enter, Tab, Escape, Backspace, arrows, or a single character). Use Enter to submit forms, Tab to move focus.',
        obj({ key: str('Key to press, e.g. Enter.') }, ['key']),
        async args => pilot.withOp(() => pilot.press(args.key)),
        value => [{ type: 'text', text: `pressed ${value.key}` }],
      ),
      define(
        'pilot_screenshot',
        'Capture a PNG screenshot of the controlled browser page. Returns the absolute path to the saved file; a vision-capable model (or the user in the cockpit panel) can then view it.',
        obj({ path: str('Optional absolute path ending in .png; default is a timestamped file in the OS temp directory.') }),
        async args => pilot.withOp(async () => {
          await pilot.ensure()
          const shot = await pilot.captureShot()
          const target = args.path ?? join(tmpdir(), `dsh-pilot-${Date.now()}.png`)
          await writeFile(target, shot)
          return { ok: true, path: target, bytes: shot.length }
        }),
        value => [{ type: 'text', text: `screenshot saved: ${value.path} (${value.bytes} bytes)` }],
      ),
      define(
        'pilot_eval',
        'Evaluate a JavaScript expression in the controlled browser page and return the result as JSON. Use for reading state that is not in the text snapshot. The expression runs in page context.',
        obj({ expression: str('JavaScript expression to evaluate in the page.') }, ['expression']),
        async args => pilot.withOp(() => pilot.evalJs(args.expression)),
        value => [{ type: 'text', text: value.ok ? `type=${value.type} value=${value.text}` : `eval failed: ${value.error}` }],
      ),
      define(
        'pilot_close',
        'Stop and clean up the controlled browser process. The next pilot_* call relaunches it automatically.',
        obj({}),
        async () => pilot.withOp(() => pilot.stop()),
        () => [{ type: 'text', text: 'browser stopped' }],
      ),
    ]
    for (const def of defs) {
      ctx.effect(() => tools.register(def), 'dsh-pilot: tool ' + def.name)
    }
  }

  ctx.effect(() => () => pilot.dispose(), 'dsh-pilot: browser cleanup')
}
