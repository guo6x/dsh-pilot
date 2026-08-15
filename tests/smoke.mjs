/**
 * dsh-pilot host smoke test: real headless Edge end-to-end, v0.2.
 * Run: node tests/smoke.mjs
 */
import { Pilot, PilotPool } from '../lib/index.js'
import { tmpdir } from 'node:os'

let failed = 0
const check = (label, condition, extra = '') => {
  const ok = Boolean(condition)
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? ` — ${extra}` : ''}`)
}

const pilot = new Pilot()
try {
  const snapshot = await pilot.navigate('https://example.com')
  check('navigate: status ready', pilot.status === 'ready')
  check('navigate: url', snapshot.url === 'https://example.com/', snapshot.url)
  check('navigate: title', /Example/i.test(snapshot.title), snapshot.title)
  check('navigate: has body text', snapshot.text.includes('Example Domain'))
  check('navigate: numbered elements', Array.isArray(snapshot.elements) && snapshot.elements.length > 0, `${snapshot.elements.length} elements`)
  check('navigate: first element ref is 1', snapshot.elements[0].ref === 1)

  const learnMore = snapshot.elements.find(el => el.href.includes('iana.org'))
  check('elements: href captured', learnMore !== undefined)

  const clicked = await pilot.click(learnMore.ref)
  check('click by ref: ok', clicked.ok === true && clicked.ref === learnMore.ref, JSON.stringify(clicked).slice(0, 120))
  check('click: waits for navigation', /iana\.org/.test(clicked.url), clicked.url)
  check('click: title settled after load', typeof clicked.title === 'string' && clicked.title.length > 0, clicked.title)

  const wentBack = await pilot.back()
  check('back: returns to previous page', /example\.com/.test(wentBack.url), wentBack.url)

  const reloaded = await pilot.reload()
  check('reload: keeps url', reloaded.url === wentBack.url, reloaded.url)

  const waited = await pilot.wait(150)
  check('wait: ok', waited.ok === true && waited.waited === 150, JSON.stringify(waited))

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
} catch (error) {
  failed++
  console.error('FATAL', error)
} finally {
  await pilot.dispose()
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
