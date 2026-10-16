// The visible page follows the narration across pages, in Browser and Natural voice.
//
//   python3 tests/fixtures/generate_page_follow_fixture.py
//   LATTE_READER_URL=http://127.0.0.1:4173 node scripts/page-follow-smoke.mjs [browser] [local]
//
// Browser voice: headless Chromium has no voices, so a fake speechSynthesis speaks at
// 2 ms per character, once WITH word boundary events (desktop system voices) and once
// WITHOUT (Chrome's online Google voices, Android), and records which page's text it is
// actually saying. Every 100 ms the displayed page counter is compared with that page.
// Natural voice runs the real on-device model on a short fixture.
// Each mode is checked from page 1, from page 2, and with a pause/resume on page 2.
import assert from 'node:assert/strict'
import { chromium } from 'playwright'
const base = process.env.LATTE_READER_URL; assert(base, 'LATTE_READER_URL')
const modes = process.argv.slice(2).length ? process.argv.slice(2) : ['browser', 'local']
const MAX_LAG_MS = 600
const log = (...a) => console.log('[page-follow]', ...a)
const browser = await chromium.launch()
let failures = 0

const fakeSpeech = withBoundaries => {
  const MS_PER_CHAR = 2
  const queue = []
  let current = null, elapsed = 0, resumedAt = 0, paused = false, timers = []
  const clear = () => { timers.forEach(clearTimeout); timers = [] }
  const at = () => elapsed + (paused || !current ? 0 : performance.now() - resumedAt)
  // Text spoken so far in the current utterance, for the test to read the real page.
  window.__spoken = () => current ? current.text.slice(0, Math.min(current.text.length, Math.floor(at() / MS_PER_CHAR))) : null
  const schedule = () => {
    clear(); resumedAt = performance.now()
    const u = current, done = elapsed
    if (withBoundaries) for (const m of u.text.matchAll(/\S+/g)) {
      const due = m.index * MS_PER_CHAR - done
      if (due >= 0) timers.push(setTimeout(() => { if (current === u) u.onboundary?.({ charIndex: m.index, name: 'word' }) }, due))
    }
    timers.push(setTimeout(() => { if (current !== u) return; current = null; clear(); u.onend?.({}); pump() }, Math.max(0, u.text.length * MS_PER_CHAR - done)))
  }
  const pump = () => {
    if (current || !queue.length || paused) return
    current = queue.shift(); elapsed = 0; current.onstart?.({}); schedule()
  }
  Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: {
    get speaking() { return !!current }, get paused() { return paused }, pending: false,
    getVoices: () => [], addEventListener() {}, removeEventListener() {},
    speak(u) { queue.push(u); pump() },
    cancel() { queue.length = 0; current = null; paused = false; clear() },
    pause() { if (paused) return; if (current) elapsed = at(); paused = true; clear() },
    resume() { if (!paused) return; paused = false; if (current) schedule(); else pump() },
  } })
}

async function run(mode, { startPage = 1, pauseResume = false, boundaries = true } = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  await context.addInitScript(() => localStorage.setItem('latte-analytics-consent', 'denied'))
  if (mode === 'browser') await context.addInitScript(fakeSpeech, boundaries)
  const p = await context.newPage()
  const errors = []; p.on('pageerror', e => errors.push(e.message))
  const shown = async () => Number((await p.locator('output[aria-label="Current page"]').first().textContent()).match(/\d+/)[0])
  await p.goto(base)
  await p.locator('input[type=file]').setInputFiles(mode === 'local' ? 'tests/fixtures/page-follow-short.pdf' : 'tests/fixtures/page-follow.pdf')
  await p.waitForFunction(() => document.body.textContent.includes('Ready to read'), null, { timeout: 60000 })
  await p.getByLabel('To the end').check()
  if (mode === 'local') {
    await p.locator('.local-narrator-controls select').selectOption('local')
    await p.getByRole('button', { name: /^(Download|Turn on) voice$/ }).click()
    await p.locator('[data-local-status=ready]').waitFor({ timeout: 240000 })
  }
  if (startPage > 1) { await p.getByLabel('Go to page').first().fill(String(startPage)); await p.waitForTimeout(300) }
  const seen = [await shown()]
  let lagMs = 0, worstLag = 0, paused = false, lastPercent = 0, sliderBack = false, jumpMismatch = false
  const percent = async () => Number((await p.locator('.reading-progress-label').first().textContent()).match(/(\d+)%/)[1])
  await p.locator('.play-button').click()
  const deadline = Date.now() + (mode === 'local' ? 240000 : 60000)
  while (Date.now() < deadline) {
    const now = await shown()
    if (seen.at(-1) !== now) seen.push(now)
    // 'Go to page' and the reading position slider move with it.
    if (Number(await p.getByLabel('Go to page').first().inputValue()) !== now) jumpMismatch = true
    const pct = await percent(); if (pct < lastPercent) sliderBack = true; lastPercent = pct
    if (mode === 'browser') {
      // Which page is the voice actually saying? The last "Page N" tag it has passed.
      const spoken = await p.evaluate(() => window.__spoken?.())
      const tag = spoken && [...spoken.matchAll(/Page (\d+) paragraph/g)].at(-1)
      if (tag && Number(tag[1]) !== now) { lagMs += 100; worstLag = Math.max(worstLag, lagMs) } else lagMs = 0
    }
    if (pauseResume && !paused && now === startPage + 1) {
      paused = true
      await p.locator('.play-button').click(); await p.waitForTimeout(700)
      assert.equal(await shown(), now, 'page holds while paused')
      await p.locator('.play-button').click()
    }
    if (/Finished/i.test(await p.locator('.playback-readout').innerText())) break
    await p.waitForTimeout(100)
  }
  const expected = Array.from({ length: 4 - startPage }, (_, i) => startPage + i)
  const finished = /Finished/i.test(await p.locator('.playback-readout').innerText())
  const ok = finished && JSON.stringify(seen) === JSON.stringify(expected) && worstLag <= MAX_LAG_MS && !errors.length && !jumpMismatch && !sliderBack && (await percent()) === 100
  const name = `${mode}${mode === 'browser' ? (boundaries ? ' (word boundaries)' : ' (no boundary events)') : ''} from page ${startPage}${pauseResume ? ' with pause/resume' : ''}`
  log(`${name}: displayed ${JSON.stringify(seen)}, expected ${JSON.stringify(expected)}${mode === 'browser' ? `, worst page lag ${worstLag} ms` : ''}${finished ? '' : ', did not finish'}${jumpMismatch ? ', Go to page out of step' : ''}${sliderBack ? ', slider went backwards' : ''}${errors.length ? `, errors ${errors}` : ''} ${ok ? 'PASS' : 'FAIL'}`)
  if (!ok) failures++
  await context.close()
}

for (const mode of modes) {
  for (const boundaries of mode === 'browser' ? [true, false] : [true]) {
    await run(mode, { boundaries })
    await run(mode, { boundaries, startPage: 2 })
    await run(mode, { boundaries, pauseResume: true })
  }
}
await browser.close()
if (failures) { log(`${failures} failing case(s)`); process.exit(1) }
log('PASS')
