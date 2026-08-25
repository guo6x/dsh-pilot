/**
 * dsh-pilot host smoke test: real headless Edge end-to-end, v0.2.
 * Run: node tests/smoke.mjs
 */
import { Pilot, PilotPool } from '../lib/index.js'
import { rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failed = 0
const check = (label, condition, extra = '') => {
  const ok = Boolean(condition)
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? ` — ${extra}` : ''}`)
}

const pilot = new Pilot()
let formServer = null
let formBase = ''
let uploadFixture = null
try {
  const snapshot = await pilot.navigate('https://example.com')
  check('navigate: status ready', pilot.status === 'ready')
  check('navigate: url', snapshot.url === 'https://example.com/', snapshot.url)
  check('navigate: title', /Example/i.test(snapshot.title), snapshot.title)
  check('navigate: has body text', snapshot.text.includes('Example Domain'))
  check('navigate: numbered elements', Array.isArray(snapshot.elements) && snapshot.elements.length > 0, `${snapshot.elements.length} elements`)
  check('navigate: first element ref is 1', snapshot.elements[0].ref === 1)
  check('snapshot: no baseline on first snapshot', snapshot.changed === null)

  const learnMore = snapshot.elements.find(el => el.href.includes('iana.org'))
  check('elements: href captured', learnMore !== undefined)

  const clicked = await pilot.click(learnMore.ref)
  check('click by ref: ok', clicked.ok === true && clicked.ref === learnMore.ref, JSON.stringify(clicked).slice(0, 120))
  check('click: waits for navigation', /iana\.org/.test(clicked.url), clicked.url)
  check('click: title settled after load', typeof clicked.title === 'string' && clicked.title.length > 0, clicked.title)

  const snapAfter = await pilot.snapshot()
  check('snapshot: urlChanged after click', snapAfter.changed !== null && snapAfter.changed.urlChanged === true, JSON.stringify(snapAfter.changed).slice(0, 160))

  const wentBack = await pilot.back()
  check('back: returns to previous page', /example\.com/.test(wentBack.url), wentBack.url)

  const reloaded = await pilot.reload()
  check('reload: keeps url', reloaded.url === wentBack.url, reloaded.url)

  const waited = await pilot.wait(150)
  check('wait: ok', waited.ok === true && waited.waited === 150, JSON.stringify(waited))

  const waitForText = await pilot.waitFor({ text: 'Example Domain', timeoutMs: 1000 })
  check('waitFor: matches visible text', waitForText.ok === true && waitForText.textMatched === true, JSON.stringify(waitForText))

  const asserted = await pilot.assert({ selector: 'a[href*="iana.org"]', urlIncludes: 'example.com' })
  check('assert: matches selector and url', asserted.ok === true && asserted.selectorMatched && asserted.urlMatched, JSON.stringify(asserted))

  const timedOut = await pilot.waitFor({ text: 'this text is not on example.com', timeoutMs: 100 })
  check('waitFor: reports a timeout', timedOut.ok === false && /timed out/.test(timedOut.error), JSON.stringify(timedOut))

  // A real local form exercises label-driven fill and CDP file upload end-to-end.
  formServer = createServer((_req, res) => {
    if (_req.url === '/download') {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('pilot download fixture\n'.repeat(40))
      return
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(`<!doctype html><title>Pilot form</title>
      <label for="email">Email address</label><input id="email" type="email">
      <label>Display name <input name="display-name"></label>
      <label for="role">Role</label><select id="role"><option value="member">Member</option><option value="admin">Admin</option></select>
      <label for="resume">Resume</label><input id="resume" name="resume" type="file">
      <script>window.__uploadEvents = 0; document.querySelector('#resume').addEventListener('change', () => window.__uploadEvents++)</script>`)
  })
  formServer.listen(0, '127.0.0.1')
  await once(formServer, 'listening')
  const formPort = formServer.address().port
  formBase = `http://127.0.0.1:${formPort}`
  const form = await pilot.navigate(`${formBase}/form`)
  check('form: local page loaded', form.title === 'Pilot form' && form.url.includes(String(formPort)), form.url)

  const filled = await pilot.fill([
    { label: 'Email address', value: 'agent@example.com' },
    { label: 'Display name', value: 'Harness Agent' },
    { label: 'Role', value: 'Admin' },
  ])
  check('fill: labels and select values', filled.ok === true && filled.filled.length === 3, JSON.stringify(filled))
  const formValues = await pilot.evalJs(`({ email: document.querySelector('#email').value, name: document.querySelector('[name="display-name"]').value, role: document.querySelector('#role').value })`)
  check('fill: values reached DOM', formValues.ok && formValues.value.email === 'agent@example.com' && formValues.value.name === 'Harness Agent' && formValues.value.role === 'admin', JSON.stringify(formValues))
  const unmatched = await pilot.fill([{ label: 'No such field', value: 'x' }])
  check('fill: unmatched label is explicit', unmatched.ok === false && unmatched.failed.length === 1, JSON.stringify(unmatched))

  uploadFixture = join(tmpdir(), `dsh-pilot-upload-${process.pid}.txt`)
  await writeFile(uploadFixture, 'pilot upload fixture')
  const formSnapshot = await pilot.snapshot()
  const fileInput = formSnapshot.elements.find(element => element.type === 'file')
  check('upload: file input has a snapshot ref', fileInput?.ref > 0, JSON.stringify(fileInput))
  const uploaded = await pilot.upload(fileInput.ref, [uploadFixture])
  check('upload: assigns the selected file', uploaded.ok === true && uploaded.count === 1 && uploaded.files[0] === `dsh-pilot-upload-${process.pid}.txt`, JSON.stringify(uploaded))
  const uploadEvents = await pilot.evalJs('window.__uploadEvents')
  check('upload: dispatches change event', uploadEvents.ok && uploadEvents.value >= 1, JSON.stringify(uploadEvents))

  // stale ref after navigation
  const stale = await pilot.click(999)
  check('click: stale ref fails gracefully', stale.ok === false && /stale|unknown/.test(stale.error), stale.error)

  const evaluated = await pilot.evalJs('1 + 1')
  check('eval: value', evaluated.ok && evaluated.value === 2, JSON.stringify(evaluated))

  const pressed = await pilot.press('Escape')
  check('press: ok', pressed.ok === true)

  const state1 = pilot.state()
  check('state: log populated', state1.log.length >= 4, `${state1.log.length} entries`)

  // screenshot into a nested, non-existent directory — mkdir -p regression
  const { saveScreenshot } = await import('../lib/index.js')
  const nested = await saveScreenshot(pilot, `${tmpdir()}/dsh-pilot-nested/a/b/shot.png`)
  check('screenshot: creates parent dirs', nested.ok === true && nested.bytes > 1000, nested.path)

  // download through the page's own fetch (session cookies apply)
  const dl = await pilot.download(`${formBase}/download`, `${tmpdir()}/dsh-pilot-dl-test.txt`)
  check('download: saves file with bytes', dl.ok === true && dl.bytes > 500, JSON.stringify(dl))
} catch (error) {
  failed++
  console.error('FATAL', error)
} finally {
  await pilot.dispose()
  if (formServer !== null) await new Promise(resolve => formServer.close(resolve))
  if (uploadFixture !== null) await rm(uploadFixture, { force: true })
}

// ---- pool: per-session isolation ----
const pool = new PilotPool()
try {
  const a = pool.for('session-a')
  const b = pool.for('session-b')
  check('pool: distinct pilots per session', a !== b)
  await a.navigate('https://example.com')
  await b.navigate('https://en.wikipedia.org/wiki/DeepSeek')
  check('pool: a independent', a.url.includes('example.com'), a.url)
  check('pool: b independent', b.url.includes('DeepSeek'), b.url)
  check('pool: distinct ports', a.port !== b.port, `${a.port} vs ${b.port}`)
  check('pool: primary tracks last use', pool.panelPilot() === b)
  check('pool: can pin cockpit to a session', pool.selectPanelSession('session-a') === true && pool.panelPilot() === a)
  pool.for('session-b')
  check('pool: pin survives newer activity', pool.panelPilot() === a)
  check('pool: latest restores automatic following', pool.selectPanelSession('latest') === true && pool.panelPilot() === b)
  check('pool: rejects unknown cockpit session', pool.selectPanelSession('missing-session') === false && pool.panelPilot() === b)
  await a.stop()
  check('pool: stopping a leaves b ready', b.status === 'ready')
} catch (error) {
  failed++
  console.error('FATAL pool', error)
} finally {
  await pool.disposeAll()
}

console.log(`\n${failed === 0 ? 'ALL PASS' : `${failed} FAILURES`}`)
process.exit(failed === 0 ? 0 : 1)
