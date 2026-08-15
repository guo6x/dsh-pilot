/**
 * dsh-pilot host smoke test: real headless Edge end-to-end.
 * Run: node tests/smoke.mjs
 */
import { Pilot } from '../lib/index.js'

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
  check('navigate: has link', snapshot.links.some(link => /iana\.org/.test(link.h)))
  check('navigate: screenshot captured', pilot.lastShot !== null && pilot.lastShot.length > 1000, `${pilot.lastShot?.length ?? 0} bytes`)

  const clicked = await pilot.click('a')
  check('click: ok', clicked.ok === true, JSON.stringify(clicked).slice(0, 120))

  const evaluated = await pilot.evalJs('1 + 1')
  check('eval: value', evaluated.ok && evaluated.value === 2, JSON.stringify(evaluated))

  const typed = await pilot.type('input', 'hello')
  // example.com has no input — this must fail gracefully, not throw
  check('type: graceful no-match', typed.ok === false && /no element/.test(typed.error), typed.error)

  const pressed = await pilot.press('Escape')
  check('press: ok', pressed.ok === true)

  const state1 = pilot.state()
  check('state: log populated', state1.log.length >= 4, `${state1.log.length} entries`)
} catch (error) {
  failed++
  console.error('FATAL', error)
} finally {
  await pilot.dispose()
}
console.log(`\n${failed === 0 ? 'ALL PASS' : `${failed} FAILURES`}`)
process.exit(failed === 0 ? 0 : 1)
