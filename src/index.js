/**
 * dsh-pilot host plugin.
 *
 * Owns a pool of headless Edge/Chrome instances (one per agent session),
 * talks CDP over the native Node >= 22 WebSocket (zero runtime dependencies),
 * serves a loopback JSON/PNG API for the client cockpit panel, and registers
 * pilot_* tools for the agent.
 *
 * Agent-facing design: the model reads STRUCTURED text snapshots (title, url,
 * body text, links, and a numbered element list) instead of screenshots, so
 * text-only models can drive the browser without spending vision tokens.
 * Every interactive element gets a stable ref; click/type take that ref
 * instead of a guessed CSS selector. Screenshots exist for the human panel
 * and for vision-capable models via pilot_screenshot.
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join } from 'node:path'

export const name = 'dsh-pilot'
export const inject = ['webServer', 'tools']

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
const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024
const MAX_LOG = 200
const MAX_ELEMENTS = 200
const MAX_FILL_FIELDS = 20
const MAX_UPLOAD_FILES = 10
const NAV_TIMEOUT_MS = 20000
const POOL_CAP = 8

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
    this.lastUsedAt = Date.now()
    this.edgePath = options.edgePath ?? null
    this.lastSnapshot = null // descriptors of the previous snapshot, for diffs
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
    for (let port = base; port < base + 40; port++) {
      try {
        await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(400) })
        continue // occupied — try the next port
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
    if (port === null) throw new Error('pilot: no free debugging port in 9222..9262')
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
      await this.cdp.call('DOM.enable')
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
    await Promise.race([this.cdp.once('Page.loadEventFired', NAV_TIMEOUT_MS).catch(() => {}), sleep(NAV_TIMEOUT_MS)])
    this.url = url
    this.title = await this.readTitle()
    this.note('nav', url)
    this.lastSnapshot = null // a new page starts a fresh diff window
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

  /** Walk interactive elements and pin numbered refs on the page. */
  async snapshot() {
    await this.ensure()
    const { result } = await this.cdp.call('Runtime.evaluate', {
      expression: `JSON.stringify((() => {
        const text = document.body ? document.body.innerText : ''
        const links = Array.from(document.querySelectorAll('a')).slice(0, 50).map(a => ({
          t: (a.innerText || a.title || a.getAttribute('aria-label') || '').trim().slice(0, 80),
          h: a.href,
        })).filter(l => l.h)
        const selectors = 'a,button,input,textarea,select,summary,[role="button"],[role="link"],[role="textbox"],[role="checkbox"],[role="combobox"],[role="option"],[role="tab"]'
        const els = []
        const seen = new Set()
        for (const el of document.querySelectorAll(selectors)) {
          if (seen.has(el)) continue
          seen.add(el)
          const r = el.getBoundingClientRect()
          if (r.width === 0 && r.height === 0) continue
          const tag = el.tagName.toLowerCase()
          const label = (el.innerText || el.value || el.getAttribute('aria-label') || el.title || el.name || el.placeholder || '').trim().slice(0, 100)
          els.push({ el, ref: els.length + 1, tag, type: el.getAttribute('type') || '', label, href: el.href || '' })
          if (els.length >= ${MAX_ELEMENTS}) break
        }
        window.__pilotEls = els
        return {
          title: document.title,
          url: location.href,
          text: text.slice(0, ${MAX_TEXT}),
          textLength: text.length,
          links,
          buttons: document.querySelectorAll('button').length,
          inputs: document.querySelectorAll('input,textarea,select').length,
          elements: els.map(({ el, ...d }) => d),
        }
      })())`,
      returnByValue: true,
    }, NAV_TIMEOUT_MS)
    const data = JSON.parse(result.value)
    this.url = data.url
    this.title = data.title
    const changed = diffSnapshots(this.lastSnapshot, data)
    this.lastSnapshot = {
      url: data.url,
      title: data.title,
      textLength: data.textLength,
      elements: data.elements,
    }
    return { ...data, changed }
  }

  /** Wait for the next load event or the timeout — lets navigations settle. Never rejects. */
  async waitForLoad(timeoutMs = 3000) {
    if (this.cdp === null) return
    await Promise.race([
      this.cdp.once('Page.loadEventFired', timeoutMs).catch(() => {}),
      sleep(timeoutMs),
    ])
  }

  /** Pause for async page content to settle. */
  async wait(ms) {
    const clamped = Math.max(0, Math.min(30000, Math.round(ms)))
    await sleep(clamped)
    this.note('wait', `${clamped}ms`)
    return { ok: true, waited: clamped }
  }

  /**
   * Poll the live page until every supplied condition is true. This is more
   * reliable than sleeping blindly after an action on a JavaScript-heavy page.
   */
  async waitFor(options = {}) {
    await this.ensure()
    const text = typeof options.text === 'string' && options.text.length > 0 ? options.text.slice(0, 2000) : null
    const selector = typeof options.selector === 'string' && options.selector.length > 0 ? options.selector.slice(0, 1000) : null
    const urlIncludes = typeof options.urlIncludes === 'string' && options.urlIncludes.length > 0 ? options.urlIncludes.slice(0, 2000) : null
    if (text === null && selector === null && urlIncludes === null) {
      return { ok: false, error: 'provide at least one of text, selector, or urlIncludes' }
    }

    const timeoutMs = Math.max(0, Math.min(30000, Math.round(options.timeoutMs ?? 10000)))
    const pollMs = Math.max(50, Math.min(2000, Math.round(options.pollMs ?? 250)))
    const startedAt = Date.now()
    const deadline = startedAt + timeoutMs
    const label = [
      text !== null ? `text=${JSON.stringify(text)}` : '',
      selector !== null ? `selector=${JSON.stringify(selector)}` : '',
      urlIncludes !== null ? `urlIncludes=${JSON.stringify(urlIncludes)}` : '',
    ].filter(Boolean).join(', ')
    let last = null

    while (true) {
      const { result, exceptionDetails } = await this.cdp.call('Runtime.evaluate', {
        expression: `(() => {
          const bodyText = document.body ? document.body.innerText : ''
          const el = ${selector === null ? 'null' : `document.querySelector(${JSON.stringify(selector)})`}
          const rect = el ? el.getBoundingClientRect() : null
          const selectorVisible = Boolean(el && rect && rect.width > 0 && rect.height > 0)
          return {
            url: location.href,
            title: document.title,
            textMatched: ${text === null ? 'true' : `bodyText.includes(${JSON.stringify(text)})`},
            selectorMatched: ${selector === null ? 'true' : 'selectorVisible'},
            urlMatched: ${urlIncludes === null ? 'true' : `location.href.includes(${JSON.stringify(urlIncludes)})`},
          }
        })()`,
        returnByValue: true,
      }, 10000)
      if (exceptionDetails) return { ok: false, error: exceptionDetails.text ?? 'wait condition failed' }
      last = result.value
      this.url = last.url
      this.title = last.title
      if (last.textMatched && last.selectorMatched && last.urlMatched) {
        const waited = Date.now() - startedAt
        this.note('waitFor', `${label} (${waited}ms)`)
        await this.captureShot()
        return { ok: true, waited, ...last }
      }
      if (Date.now() >= deadline) {
        return { ok: false, waited: Date.now() - startedAt, error: `timed out waiting for ${label}`, ...last }
      }
      await sleep(Math.min(pollMs, Math.max(1, deadline - Date.now())))
    }
  }

  /** Evaluate the same page conditions once, without waiting. */
  async assert(options = {}) {
    const result = await this.waitFor({ ...options, timeoutMs: 0 })
    if (result.ok) {
      this.note('assert', 'passed')
      return result
    }
    return {
      ...result,
      error: result.error?.startsWith('timed out waiting for')
        ? result.error.replace('timed out waiting for', 'assertion failed:')
        : result.error,
    }
  }

  async readUrl() {
    try {
      const { result } = await this.cdp.call('Runtime.evaluate', {
        expression: 'location.href',
        returnByValue: true,
      })
      return typeof result.value === 'string' ? result.value : this.url
    } catch {
      return this.url
    }
  }

  async back() {
    await this.ensure()
    const settling = this.waitForLoad(3000)
    await this.cdp.call('Runtime.evaluate', { expression: 'history.back()' }, 10000)
    await settling
    await sleep(300)
    this.url = await this.readUrl()
    this.title = await this.readTitle()
    this.note('back', this.url)
    await this.captureShot()
    return { ok: true, url: this.url, title: this.title }
  }

  async reload() {
    await this.ensure()
    const settling = this.waitForLoad(8000)
    await this.cdp.call('Page.reload', {}, 15000)
    await settling
    await sleep(300)
    this.url = await this.readUrl()
    this.title = await this.readTitle()
    this.note('reload', this.url)
    await this.captureShot()
    return { ok: true, url: this.url, title: this.title }
  }

  async click(target) {
    await this.ensure()
    const settling = this.waitForLoad(2500) // register before the click — the load event may beat us
    const expression = typeof target === 'number'
      ? `(() => {
          const entry = window.__pilotEls && window.__pilotEls[${target} - 1]
          if (!entry) return { ok: false, error: 'stale or unknown ref ' + ${JSON.stringify(String(target))} + ' — run pilot_snapshot for the current numbered list' }
          const el = entry.el
          el.scrollIntoView({ block: 'center' })
          el.click()
          return { ok: true, ref: ${target}, tag: el.tagName.toLowerCase(), text: (el.innerText || el.value || '').slice(0, 120) }
        })()`
      : `(() => {
          const el = document.querySelector(${JSON.stringify(target)})
          if (!el) return { ok: false, error: 'no element matches selector' }
          el.scrollIntoView({ block: 'center' })
          el.click()
          return { ok: true, tag: el.tagName.toLowerCase(), text: (el.innerText || el.value || '').slice(0, 120) }
        })()`
    const { result, exceptionDetails } = await this.cdp.call('Runtime.evaluate', {
      expression,
      returnByValue: true,
    })
    if (exceptionDetails) return { ok: false, error: exceptionDetails.text ?? 'evaluate failed' }
    this.note('click', String(target))
    await settling
    await sleep(300)
    this.url = await this.readUrl()
    this.title = await this.readTitle()
    await this.captureShot()
    return { ...result.value, url: this.url, title: this.title }
  }

  async type(target, text) {
    await this.ensure()
    const resolve = typeof target === 'number'
      ? `(window.__pilotEls && window.__pilotEls[${target} - 1] && window.__pilotEls[${target} - 1].el) || null`
      : `document.querySelector(${JSON.stringify(target)})`
    const expression = `(() => {
        const el = ${resolve}
        if (!el) return { ok: false, error: 'no element matches the given ref or selector — run pilot_snapshot first' }
        el.focus()
        const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
        Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(text)})
        el.dispatchEvent(new Event('input', { bubbles: true }))
        el.dispatchEvent(new Event('change', { bubbles: true }))
        return { ok: true }
      })()`
    const { result, exceptionDetails } = await this.cdp.call('Runtime.evaluate', {
      expression,
      returnByValue: true,
    })
    if (exceptionDetails) return { ok: false, error: exceptionDetails.text ?? 'evaluate failed' }
    this.note('type', `${String(target)} <= ${text.slice(0, 60)}`)
    await this.captureShot()
    return result.value
  }

  /**
   * Fill multiple controls by their user-facing label, aria-label, placeholder,
   * name, or id. Values stay inside the page and are never put in the action log.
   */
  async fill(fields) {
    await this.ensure()
    const requested = []
    const failed = []
    for (const field of Array.isArray(fields) ? fields.slice(0, MAX_FILL_FIELDS) : []) {
      if (typeof field?.label !== 'string' || field.label.trim().length === 0 || typeof field?.value !== 'string') {
        failed.push({ label: String(field?.label ?? ''), error: 'each field needs a non-empty label and a string value' })
      } else {
        requested.push({ label: field.label.trim().slice(0, 500), value: field.value.slice(0, 20000) })
      }
    }
    if (requested.length === 0) return { ok: false, filled: [], failed: failed.length > 0 ? failed : [{ label: '', error: 'provide 1-20 fields' }] }

    const { result, exceptionDetails } = await this.cdp.call('Runtime.evaluate', {
      expression: `JSON.stringify((() => {
        const requested = ${JSON.stringify(requested)}
        const normalize = value => String(value || '').toLocaleLowerCase().replace(/\\s+/g, ' ').trim()
        const editable = el => {
          const tag = el.tagName.toLowerCase()
          if (tag === 'textarea' || tag === 'select') return !el.disabled && !el.readOnly
          if (tag !== 'input') return false
          const type = (el.type || 'text').toLocaleLowerCase()
          return !el.disabled && !el.readOnly && !['hidden', 'button', 'submit', 'reset', 'image', 'checkbox', 'radio', 'file'].includes(type)
        }
        const labelsFor = el => {
          const values = [el.getAttribute('aria-label'), el.getAttribute('placeholder'), el.name, el.id, el.autocomplete]
          for (const label of Array.from(el.labels || [])) values.push(label.textContent)
          for (const id of (el.getAttribute('aria-labelledby') || '').split(/\\s+/)) {
            if (id) values.push(document.getElementById(id)?.textContent)
          }
          return values.map(normalize).filter(Boolean)
        }
        const controls = Array.from(document.querySelectorAll('input, textarea, select')).filter(editable)
        const filled = []
        const failed = []
        for (const field of requested) {
          const wanted = normalize(field.label)
          let chosen = null
          let best = 0
          for (const control of controls) {
            for (const candidate of labelsFor(control)) {
              const score = candidate === wanted ? 3 : (candidate.includes(wanted) || wanted.includes(candidate) ? 1 : 0)
              if (score > best) {
                chosen = control
                best = score
              }
            }
          }
          if (!chosen) {
            failed.push({ label: field.label, error: 'no editable control matches this label' })
            continue
          }
          const tag = chosen.tagName.toLowerCase()
          if (tag === 'select') {
            const value = normalize(field.value)
            const option = Array.from(chosen.options).find(item => normalize(item.value) === value || normalize(item.textContent) === value)
            if (!option) {
              failed.push({ label: field.label, error: 'no select option matches this value' })
              continue
            }
            chosen.value = option.value
          } else {
            const proto = tag === 'textarea' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
            const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
            if (!setter) {
              failed.push({ label: field.label, error: 'this control does not support text entry' })
              continue
            }
            setter.call(chosen, field.value)
          }
          chosen.focus()
          chosen.dispatchEvent(new Event('input', { bubbles: true }))
          chosen.dispatchEvent(new Event('change', { bubbles: true }))
          filled.push({ label: field.label, tag, type: chosen.getAttribute('type') || '' })
        }
        return { filled, failed }
      })())`,
      returnByValue: true,
    }, NAV_TIMEOUT_MS)
    if (exceptionDetails) return { ok: false, filled: [], failed: [...failed, { label: '', error: exceptionDetails.text ?? 'form fill failed' }] }
    const outcome = JSON.parse(result.value)
    const allFailed = [...failed, ...outcome.failed]
    this.note('fill', `${outcome.filled.length} filled, ${allFailed.length} failed`)
    await this.captureShot()
    return { ok: allFailed.length === 0, filled: outcome.filled, failed: allFailed }
  }

  /** Upload existing absolute paths to an <input type=file> selected by ref or CSS. */
  async upload(target, paths) {
    await this.ensure()
    const files = Array.isArray(paths) ? paths.slice(0, MAX_UPLOAD_FILES) : []
    if (files.length === 0) return { ok: false, error: 'provide 1-10 absolute file paths' }
    let bytes = 0
    for (const path of files) {
      if (typeof path !== 'string' || !isAbsolute(path)) return { ok: false, error: 'every upload path must be absolute' }
      try {
        const info = await stat(path)
        if (!info.isFile()) return { ok: false, error: `not a regular file: ${path}` }
        bytes += info.size
      } catch {
        return { ok: false, error: `cannot read file: ${path}` }
      }
    }
    if (bytes > MAX_UPLOAD_BYTES) return { ok: false, error: `upload is ${bytes} bytes (cap ${MAX_UPLOAD_BYTES})` }

    const resolve = typeof target === 'number'
      ? `(window.__pilotEls && window.__pilotEls[${target} - 1] && window.__pilotEls[${target} - 1].el) || null`
      : `document.querySelector(${JSON.stringify(target)})`
    const { result, exceptionDetails } = await this.cdp.call('Runtime.evaluate', {
      expression: `(() => { const input = ${resolve}; return input instanceof HTMLInputElement && input.type === 'file' ? input : null })()`,
      returnByValue: false,
    })
    if (exceptionDetails) return { ok: false, error: exceptionDetails.text ?? 'file input lookup failed' }
    if (!result.objectId) return { ok: false, error: 'no file input matches the given ref or selector — run pilot_snapshot first' }
    try {
      await this.cdp.call('DOM.setFileInputFiles', { files, objectId: result.objectId }, NAV_TIMEOUT_MS)
    } catch (error) {
      return { ok: false, error: String(error.message ?? error) }
    }
    const verify = await this.cdp.call('Runtime.evaluate', {
      expression: `(() => { const input = ${resolve}; return input ? { count: input.files?.length || 0, names: Array.from(input.files || []).map(file => file.name) } : null })()`,
      returnByValue: true,
    })
    const uploaded = verify.result.value ?? { count: 0, names: [] }
    this.note('upload', `${files.length} file(s) -> ${String(target)}`)
    await this.captureShot()
    return { ok: uploaded.count === files.length, count: uploaded.count, files: uploaded.names.length > 0 ? uploaded.names : files.map(path => basename(path)) }
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

  /**
   * Download a resource (default: the current page) through the page's own
   * fetch — inherits cookies/session — and persist it to `path`.
   */
  async download(url, path) {
    await this.ensure()
    const target = url ?? this.url
    if (!/^https?:\/\//.test(target)) return { ok: false, error: 'url must be an http(s) URL' }
    const { result, exceptionDetails } = await this.cdp.call('Runtime.evaluate', {
      expression: `(async () => {
        try {
          const res = await fetch(${JSON.stringify(target)}, { credentials: 'include' })
          if (!res.ok) return { ok: false, error: 'http ' + res.status }
          const buf = await res.arrayBuffer()
          if (buf.byteLength > ${MAX_DOWNLOAD_BYTES}) return { ok: false, error: 'too large: ' + buf.byteLength + ' bytes (cap ${MAX_DOWNLOAD_BYTES})' }
          const bytes = new Uint8Array(buf)
          let bin = ''
          for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000))
          return { ok: true, base64: btoa(bin), bytes: buf.byteLength, type: res.headers.get('content-type') || '' }
        } catch (err) {
          return { ok: false, error: String(err && err.message || err) }
        }
      })()`,
      awaitPromise: true,
      returnByValue: true,
    }, 90000)
    if (exceptionDetails) return { ok: false, error: exceptionDetails.text ?? 'evaluate failed' }
    const data = result.value
    if (!data.ok) return data
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, Buffer.from(data.base64, 'base64'))
    this.note('download', `${target} -> ${path} (${data.bytes} bytes)`)
    return { ok: true, path, bytes: data.bytes, type: data.type }
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

/** Session-keyed browser pool: one Pilot per agent session, LRU-capped. */
export class PilotPool {
  constructor() {
    this.pilots = new Map()
    this.primary = null
  }

  for(sessionKey) {
    let pilot = this.pilots.get(sessionKey)
    if (pilot === undefined) {
      pilot = new Pilot()
      this.pilots.set(sessionKey, pilot)
      this.gc()
    }
    pilot.lastUsedAt = Date.now()
    this.primary = sessionKey
    return pilot
  }

  panelPilot() {
    if (this.primary !== null && this.pilots.has(this.primary)) return this.pilots.get(this.primary)
    return this.for('default')
  }

  gc() {
    if (this.pilots.size <= POOL_CAP) return
    const candidates = [...this.pilots.entries()]
      .filter(([key]) => key !== this.primary)
      .sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt)
    const [key, pilot] = candidates[0]
    this.pilots.delete(key)
    void pilot.dispose()
  }

  async disposeAll() {
    const pilots = [...this.pilots.values()]
    this.pilots.clear()
    this.primary = null
    for (const pilot of pilots) await pilot.dispose()
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

/** Render a numbered element list for the model (refs match pilot_click/pilot_type). */
function renderElements(elements, cap = 60) {
  const lines = (elements ?? []).slice(0, cap).map(el =>
    `[${el.ref}] <${el.tag}${el.type ? ` type="${el.type}"` : ''}> ${el.label || el.href || ''}`)
  const out = lines.join('\n')
  if ((elements ?? []).length > cap) return `${out}\n…(${elements.length - cap} more elements)`
  return out
}

/** Element fingerprint for cross-snapshot matching (heuristic, not DOM identity). */
function elementKey(el) {
  return `${el.tag}|${el.type ?? ''}|${el.label ?? ''}|${el.href ?? ''}`
}

/** Diff two snapshots into a compact change summary (null when no baseline exists). */
function diffSnapshots(prev, next) {
  if (prev === null) return null
  const prevCounts = new Map()
  for (const el of prev.elements ?? []) {
    const key = elementKey(el)
    prevCounts.set(key, (prevCounts.get(key) ?? 0) + 1)
  }
  const nextCounts = new Map()
  for (const el of next.elements ?? []) {
    const key = elementKey(el)
    nextCounts.set(key, (nextCounts.get(key) ?? 0) + 1)
  }
  const added = []
  const removed = []
  for (const el of next.elements ?? []) {
    if (!prevCounts.has(elementKey(el))) added.push({ ref: el.ref, tag: el.tag, label: el.label ?? el.href ?? '', type: el.type ?? '' })
  }
  for (const el of prev.elements ?? []) {
    if (!nextCounts.has(elementKey(el))) removed.push({ tag: el.tag, label: el.label ?? el.href ?? '', type: el.type ?? '' })
  }
  return {
    urlChanged: prev.url !== next.url,
    titleChanged: prev.title !== next.title,
    textDelta: (next.textLength ?? 0) - (prev.textLength ?? 0),
    added: added.slice(0, 10),
    removed: removed.slice(0, 10),
  }
}

/** Render a change summary for the model. */
function renderChanged(changed) {
  if (changed === null || changed === undefined) return 'no baseline yet (navigate first)'
  const parts = [
    `url: ${changed.urlChanged ? 'CHANGED' : 'same'}`,
    `title: ${changed.titleChanged ? 'CHANGED' : 'same'}`,
    `text: ${changed.textDelta >= 0 ? '+' : ''}${changed.textDelta} chars`,
    `elements: +${changed.added.length} added, -${changed.removed.length} removed`,
  ]
  const out = parts.join(' | ')
  if (changed.added.length === 0 && changed.removed.length === 0) return out
  const lines = [out]
  for (const el of changed.added.slice(0, 5)) {
    lines.push(`  + [${el.ref}] <${el.tag}${el.type ? ` type="${el.type}"` : ''}> ${(el.label || '').slice(0, 60)}`)
  }
  for (const el of changed.removed.slice(0, 5)) {
    lines.push(`  - <${el.tag}${el.type ? ` type="${el.type}"` : ''}> ${(el.label || '').slice(0, 60)}`)
  }
  return lines.join('\n')
}

/** Capture and persist a screenshot, creating parent directories as needed. */
export async function saveScreenshot(pilot, path) {
  await pilot.ensure()
  const shot = await pilot.captureShot()
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, shot)
  return { ok: true, path, bytes: shot.length }
}

export function apply(ctx) {
  const pool = new PilotPool()

  // ---- loopback HTTP API for the cockpit panel (shows the most recent pilot) ----
  const webServer = ctx.webServer
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
        const pilot = pool.panelPilot()
        try {
          if (req.method === 'GET' && suffix === '/state') {
            sendJson(res, 200, { ...pilot.state(), session: pool.primary ?? 'default', sessions: pool.pilots.size })
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
  const tools = ctx.tools
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
        return execute(args, exec)
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
        'Open a URL in your session\'s controlled browser (launches a headless Edge/Chrome if needed). Returns a text snapshot: title, URL, visible text, links, and a numbered element list. Prefer this over web_fetch when the page needs JavaScript or interaction.',
        obj({ url: str('Full http(s) URL to open.') }, ['url']),
        async (args, exec) => {
          const pilot = pool.for(exec.agent?.session?.id ?? 'default')
          return pilot.withOp(() => pilot.navigate(args.url))
        },
        value => [{ type: 'text', text: `[${value.title}](${value.url})\n${value.text.slice(0, 1500)}\n\nelements:\n${renderElements(value.elements, 40)}` }],
      ),
      define(
        'pilot_snapshot',
        'Read the current page of your session\'s browser as text: title, URL, visible text (up to 8000 chars), links, a NUMBERED list of interactive elements, and a change summary versus the previous snapshot. Use the element numbers (refs) with pilot_click/pilot_type — never guess CSS selectors. Re-run after navigation; refs go stale when the page changes.',
        obj({}),
        async (_args, exec) => {
          const pilot = pool.for(exec.agent?.session?.id ?? 'default')
          return pilot.withOp(() => pilot.snapshot())
        },
        value => [{ type: 'text', text: `[${value.title}](${value.url})\n${value.text.slice(0, 4000)}${value.textLength > 4000 ? `\n…(text truncated, ${value.textLength} chars total)` : ''}\n\nchanged:\n${renderChanged(value.changed)}\n\nelements:\n${renderElements(value.elements)}` }],
      ),
      define(
        'pilot_diff',
        'Compare the current page of your session\'s browser against the previous snapshot and report ONLY what changed: URL/title changes, text length delta, and elements that appeared or disappeared. Use it after an action (click/type/press) to judge whether the action had the intended effect, without re-reading the whole page.',
        obj({}),
        async (_args, exec) => {
          const pilot = pool.for(exec.agent?.session?.id ?? 'default')
          return pilot.withOp(() => pilot.snapshot())
        },
        value => [{ type: 'text', text: renderChanged(value.changed) }],
      ),
      define(
        'pilot_click',
        'Click an element in your session\'s browser by its snapshot ref (number) or a CSS selector. Scrolls it into view first. Returns ok plus the clicked element tag/text and the new page title.',
        obj({
          ref: { type: 'number', description: 'Element ref from the numbered list in pilot_snapshot/pilot_open. Takes precedence over selector.' },
          selector: str('CSS selector of the element to click (fallback when you have no ref).'),
        }),
        async (args, exec) => {
          const pilot = pool.for(exec.agent?.session?.id ?? 'default')
          const target = typeof args.ref === 'number' ? args.ref : args.selector
          if (target === undefined) throw new Error('provide ref or selector')
          return pilot.withOp(() => pilot.click(target))
        },
        value => [{ type: 'text', text: value.ok ? `clicked ${value.ref !== undefined ? `ref ${value.ref} ` : ''}<${value.tag}> "${value.text}" — title now: ${value.title}` : `click failed: ${value.error}` }],
      ),
      define(
        'pilot_type',
        'Type text into an input/textarea in your session\'s browser by snapshot ref (number) or CSS selector. Sets the value through the native setter and fires input/change events, so framework-managed forms (React/Vue) observe it.',
        obj({
          ref: { type: 'number', description: 'Element ref from the numbered list in pilot_snapshot/pilot_open. Takes precedence over selector.' },
          selector: str('CSS selector of the input or textarea (fallback when you have no ref).'),
          text: str('Text to type.'),
        }, ['text']),
        async (args, exec) => {
          const pilot = pool.for(exec.agent?.session?.id ?? 'default')
          const target = typeof args.ref === 'number' ? args.ref : args.selector
          if (target === undefined) throw new Error('provide ref or selector')
          return pilot.withOp(() => pilot.type(target, args.text))
        },
        value => [{ type: 'text', text: value.ok ? 'typed' : `type failed: ${value.error}` }],
      ),
      define(
        'pilot_fill',
        'Fill several text inputs, textareas, or selects by their human-facing label, aria-label, placeholder, name, or id. Use this for a normal form instead of calling pilot_type repeatedly. Values are applied through native setters with input/change events; file, checkbox, and radio inputs are intentionally excluded.',
        obj({
          fields: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                label: str('The user-facing field label, aria-label, placeholder, name, or id.'),
                value: str('The text to enter, or the exact visible/value choice for a select.'),
              },
              required: ['label', 'value'],
              additionalProperties: false,
            },
            description: 'One to twenty fields to fill. Password values are accepted but never written to the action log.',
          },
        }, ['fields']),
        async (args, exec) => {
          const pilot = pool.for(exec.agent?.session?.id ?? 'default')
          return pilot.withOp(() => pilot.fill(args.fields))
        },
        value => [{ type: 'text', text: value.ok
          ? `filled ${value.filled.length} field(s): ${value.filled.map(field => field.label).join(', ')}`
          : `filled ${value.filled.length} field(s); ${value.failed.length} failed: ${value.failed.map(field => `${field.label || 'field'} (${field.error})`).join('; ')}` }],
      ),
      define(
        'pilot_upload',
        'Upload one to ten existing files to a file input by its snapshot ref (number) or CSS selector. Paths must be absolute regular files and total upload size is capped at 100 MB. Upload only files the user has authorized for the current site.',
        obj({
          ref: { type: 'number', description: 'File-input ref from pilot_snapshot. Takes precedence over selector.' },
          selector: str('CSS selector for an <input type="file"> (fallback when you have no ref).'),
          paths: { type: 'array', items: { type: 'string' }, description: 'One to ten absolute file paths to upload.' },
        }, ['paths']),
        async (args, exec) => {
          const pilot = pool.for(exec.agent?.session?.id ?? 'default')
          const target = typeof args.ref === 'number' ? args.ref : args.selector
          if (target === undefined) throw new Error('provide ref or selector')
          return pilot.withOp(() => pilot.upload(target, args.paths))
        },
        value => [{ type: 'text', text: value.ok ? `uploaded ${value.count} file(s): ${value.files.join(', ')}` : `upload failed: ${value.error}` }],
      ),
      define(
        'pilot_press',
        'Press a keyboard key in your session\'s browser (Enter, Tab, Escape, Backspace, arrows, or a single character). Use Enter to submit forms, Tab to move focus.',
        obj({ key: str('Key to press, e.g. Enter.') }, ['key']),
        async (args, exec) => {
          const pilot = pool.for(exec.agent?.session?.id ?? 'default')
          return pilot.withOp(() => pilot.press(args.key))
        },
        value => [{ type: 'text', text: `pressed ${value.key}` }],
      ),
      define(
        'pilot_back',
        'Go back to the previous page in your session\'s browser history. Returns the resulting URL and title once the page settles.',
        obj({}),
        async (_args, exec) => {
          const pilot = pool.for(exec.agent?.session?.id ?? 'default')
          return pilot.withOp(() => pilot.back())
        },
        value => [{ type: 'text', text: `back to [${value.title}](${value.url})` }],
      ),
      define(
        'pilot_reload',
        'Reload the current page in your session\'s browser. Returns the URL and title once the page settles.',
        obj({}),
        async (_args, exec) => {
          const pilot = pool.for(exec.agent?.session?.id ?? 'default')
          return pilot.withOp(() => pilot.reload())
        },
        value => [{ type: 'text', text: `reloaded [${value.title}](${value.url})` }],
      ),
      define(
        'pilot_wait',
        'Wait for the page to settle before the next action: async content, animations, or slow JavaScript. Takes milliseconds (1-30000, default 1000).',
        obj({ ms: { type: 'number', description: 'Milliseconds to wait (1-30000, default 1000).' } }),
        async (args, exec) => {
          const pilot = pool.for(exec.agent?.session?.id ?? 'default')
          return pilot.withOp(() => pilot.wait(args.ms ?? 1000))
        },
        value => [{ type: 'text', text: `waited ${value.waited}ms` }],
      ),
      define(
        'pilot_wait_for',
        'Wait until all supplied page conditions are true: visible body text, a visible CSS selector, or part of the URL. Prefer this to a blind pilot_wait after an interaction on an asynchronous page.',
        obj({
          text: str('Optional visible page text that must appear.'),
          selector: str('Optional CSS selector that must exist and be visible.'),
          url_includes: str('Optional URL substring that must be present.'),
          timeout_ms: { type: 'number', description: 'Maximum wait in milliseconds (0-30000, default 10000).' },
        }),
        async (args, exec) => {
          if (![args.text, args.selector, args.url_includes].some(value => typeof value === 'string' && value.length > 0)) {
            throw new Error('provide at least one of text, selector, or url_includes')
          }
          const pilot = pool.for(exec.agent?.session?.id ?? 'default')
          return pilot.withOp(() => pilot.waitFor({
            text: args.text,
            selector: args.selector,
            urlIncludes: args.url_includes,
            timeoutMs: args.timeout_ms,
          }))
        },
        value => [{ type: 'text', text: value.ok ? `condition met after ${value.waited}ms: [${value.title}](${value.url})` : `wait failed after ${value.waited ?? 0}ms: ${value.error}` }],
      ),
      define(
        'pilot_assert',
        'Check immediately whether all supplied page conditions are true: visible body text, a visible CSS selector, or part of the URL. Use after pilot_wait_for or an action to verify the expected result.',
        obj({
          text: str('Optional visible page text that must be present.'),
          selector: str('Optional CSS selector that must exist and be visible.'),
          url_includes: str('Optional URL substring that must be present.'),
        }),
        async (args, exec) => {
          if (![args.text, args.selector, args.url_includes].some(value => typeof value === 'string' && value.length > 0)) {
            throw new Error('provide at least one of text, selector, or url_includes')
          }
          const pilot = pool.for(exec.agent?.session?.id ?? 'default')
          return pilot.withOp(() => pilot.assert({
            text: args.text,
            selector: args.selector,
            urlIncludes: args.url_includes,
          }))
        },
        value => [{ type: 'text', text: value.ok ? `assertion passed: [${value.title}](${value.url})` : `assertion failed: ${value.error}` }],
      ),
      define(
        'pilot_screenshot',
        'Capture a PNG screenshot of your session\'s browser page. Returns the absolute path to the saved file; a vision-capable model (or the user in the cockpit panel) can then view it.',
        obj({ path: str('Optional absolute path ending in .png; default is a timestamped file in the OS temp directory.') }),
        async (args, exec) => {
          const pilot = pool.for(exec.agent?.session?.id ?? 'default')
          const target = args.path ?? join(tmpdir(), `dsh-pilot-${Date.now()}.png`)
          return pilot.withOp(() => saveScreenshot(pilot, target))
        },
        value => [{ type: 'text', text: `screenshot saved: ${value.path} (${value.bytes} bytes)` }],
      ),
      define(
        'pilot_eval',
        'Evaluate a JavaScript expression in your session\'s browser page and return the result as JSON. Use for reading state that is not in the text snapshot. The expression runs in page context.',
        obj({ expression: str('JavaScript expression to evaluate in the page.') }, ['expression']),
        async (args, exec) => {
          const pilot = pool.for(exec.agent?.session?.id ?? 'default')
          return pilot.withOp(() => pilot.evalJs(args.expression))
        },
        value => [{ type: 'text', text: value.ok ? `type=${value.type} value=${value.text}` : `eval failed: ${value.error}` }],
      ),
      define(
        'pilot_download',
        'Download a resource (default: the current page URL) through the page\'s own fetch — it inherits cookies/session auth — and save it to disk. Default path is the session workspace with the URL basename; cap 20 MB. Use for PDFs/CSVs/files behind the current session.',
        obj({
          url: str('Optional http(s) URL; defaults to the current page.'),
          path: str('Optional absolute target path; default is the session workspace + URL basename.'),
        }),
        async (args, exec) => {
          const pilot = pool.for(exec.agent?.session?.id ?? 'default')
          const target = args.url ?? pilot.url
          let path = args.path
          if (path === undefined) {
            let name = ''
            try { name = new URL(target).pathname.split('/').pop() ?? '' } catch {}
            if (name === '' || !/\.[A-Za-z0-9]{1,8}$/.test(name)) name = `pilot-download-${Date.now()}`
            const base = exec.agent?.session?.cwd ?? tmpdir()
            path = join(base, name)
          }
          return pilot.withOp(() => pilot.download(target, path))
        },
        value => [{ type: 'text', text: value.ok ? `downloaded: ${value.path} (${value.bytes} bytes, ${value.type || 'unknown type'})` : `download failed: ${value.error}` }],
      ),
      define(
        'pilot_close',
        'Stop and clean up your session\'s browser process. The next pilot_* call relaunches it automatically.',
        obj({}),
        async (_args, exec) => {
          const pilot = pool.for(exec.agent?.session?.id ?? 'default')
          await pilot.withOp(() => pilot.stop())
          return { ok: true, status: pilot.status }
        },
        value => [{ type: 'text', text: `browser stopped (${value.status})` }],
      ),
    ]
    for (const def of defs) {
      ctx.effect(() => tools.register(def), 'dsh-pilot: tool ' + def.name)
    }
  }

  ctx.effect(() => () => pool.disposeAll(), 'dsh-pilot: browser pool cleanup')
}
