/**
 * dsh-pilot demo recorder: cockpit-only story, all through the REAL plugin.
 * A headless GUI instance opens the DSH Web app, clicks the sidebar entry,
 * and drives the panel's own buttons — the host plugin's browser is the one
 * being controlled, so every frame shows the product working end-to-end.
 * Run: node demo/record-demo.mjs
 */
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Pilot } from '../lib/index.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const FRAMES = join(ROOT, '.tmp', 'frames')
rmSync(FRAMES, { recursive: true, force: true })
mkdirSync(FRAMES, { recursive: true })

const sleep = ms => new Promise(r => setTimeout(r, ms))
let frameNo = 0

async function snap(pilot, name) {
  const shot = await pilot.captureShot()
  const file = join(FRAMES, `f${String(frameNo++).padStart(3, '0')}.png`)
  writeFileSync(file, shot)
  console.log('frame', String(frameNo).padStart(3, '0'), name, shot.length)
}

async function mustClick(pilot, selector, label) {
  const res = await pilot.click(selector)
  if (!res.ok) throw new Error(`click failed at ${label}: ${res.error}`)
  console.log('click', label, res.tag, JSON.stringify(res.text).slice(0, 60))
}

async function mustType(pilot, selector, text, label) {
  const res = await pilot.type(selector, text)
  if (!res.ok) throw new Error(`type failed at ${label}: ${res.error}`)
  console.log('type', label, JSON.stringify(text).slice(0, 60))
}

/**
 * The regular demo still works with one session. When the fixture has several
 * sessions, briefly pin an older one and return to automatic following so the
 * recording also tells the cockpit-switcher story.
 */
async function switchCockpitSession(pilot, mode) {
  const result = await pilot.evalJs(`(() => {
    const select = document.querySelector('select[title*="会话"]')
    if (!select) return null
    const values = [...select.options].map(option => option.value)
    const next = ${JSON.stringify(mode)} === 'latest'
      ? 'latest'
      : values.filter(value => value !== 'latest').at(-1)
    if (!next || !values.includes(next)) return null
    select.value = next
    select.dispatchEvent(new Event('change', { bubbles: true }))
    return next
  })()`)
  if (!result.ok) throw new Error(`session switch failed: ${result.error}`)
  return typeof result.value === 'string' ? result.value : null
}

const gui = new Pilot()
try {
  await gui.ensure()
  await gui.navigate('http://127.0.0.1:3080/')
  await sleep(7000) // SPA boot

  const probe = await gui.evalJs(`!!document.querySelector('button[title="浏览器驾驶舱"]')`)
  if (!probe.value) throw new Error('cockpit sidebar button not found in GUI')
  console.log('cockpit button found')

  // 1. open the panel (host browser state: stopped)
  await mustClick(gui, 'button[title="浏览器驾驶舱"]', 'open panel')
  await sleep(2500)
  await snap(gui, 'panel-open')

  // 2. press the panel's own start button
  await mustClick(gui, 'button[title="启动浏览器"]', 'start browser')
  await sleep(5000)
  await snap(gui, 'browser-started')

  // 3. type a URL into the panel address bar
  await mustType(gui, 'input[title="地址栏"]', 'https://www.wikipedia.org/', 'address bar')
  await sleep(1200)
  await snap(gui, 'url-typed')

  // 4. go — the live view appears
  await mustClick(gui, 'button[title="前往"]', 'go wikipedia')
  await sleep(6000)
  await snap(gui, 'wiki-live')

  // 5. second site to show the live view refreshing
  await mustType(gui, 'input[title="地址栏"]', 'https://en.wikipedia.org/wiki/DeepSeek', 'address bar 2')
  await sleep(1000)
  await mustClick(gui, 'button[title="前往"]', 'go deepseek')
  await sleep(6000)
  await snap(gui, 'deepseek-live')
  await sleep(2000)
  await snap(gui, 'deepseek-live-2')

  // 6. A multi-session fixture adds the switcher; normal one-session demos
  // simply skip these two frames.
  const pinned = await switchCockpitSession(gui, 'older')
  if (pinned !== null) {
    await sleep(1500)
    await snap(gui, `session-pinned-${pinned}`)
    await switchCockpitSession(gui, 'latest')
    await sleep(1500)
    await snap(gui, 'session-following-latest')
  }

  console.log(`\nDONE: ${frameNo} frames in ${FRAMES}`)
} finally {
  await gui.dispose()
}
