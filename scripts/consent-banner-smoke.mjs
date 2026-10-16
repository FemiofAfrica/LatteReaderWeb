// The analytics consent banner never covers the app's controls, on mobile or desktop.
// The banner is left open (no stored choice) for the whole run.
//   LATTE_READER_URL=http://127.0.0.1:4173/ node scripts/consent-banner-smoke.mjs
import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { mkdir } from 'node:fs/promises'
const url = process.env.LATTE_READER_URL ?? 'http://127.0.0.1:4173/'
const out = process.env.LATTE_EVIDENCE || 'tests/artifacts/consent-banner'
await mkdir(out, { recursive: true })
const browser = await chromium.launch()
let failures = 0
const sizes = [[390, 844], [360, 640], [768, 1024], [1440, 900], [1024, 700], [960, 540]]

// Every visible control, scrolled into view, must be the element a tap at its centre hits,
// and the banner must never be what's on top of it.
const audit = p => p.evaluate(async () => {
  const banner = document.querySelector('[data-consent-banner]')
  if (!banner) return { banner: false, blocked: [] }
  const controls = [...document.querySelectorAll('button, input:not([type=file]), select, summary, a[href], [role=tab]')]
    .filter(el => !banner.contains(el) && el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden' && !el.closest('[hidden], .visually-hidden'))
  const blocked = []
  for (const el of controls) {
    el.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    await new Promise(r => requestAnimationFrame(() => r()))
    const r = el.getBoundingClientRect()
    if (!r.width || !r.height) continue
    const x = r.left + r.width / 2, y = r.top + r.height / 2
    if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) continue
    const hit = document.elementFromPoint(x, y)
    if (hit && banner.contains(hit)) blocked.push((el.getAttribute('aria-label') || el.textContent || el.tagName).trim().slice(0, 40))
  }
  return { banner: true, checked: controls.length, blocked }
})

for (const [width, height] of sizes) {
  const mobile = width < 781 || height <= 600
  const context = await browser.newContext({ viewport: { width, height }, hasTouch: width < 781, isMobile: width < 781, deviceScaleFactor: width < 781 ? 2 : 1 })
  const p = await context.newPage()
  const tagRequests = []; p.on('request', r => { if (/googletagmanager|google-analytics/.test(r.url())) tagRequests.push(r.url()) })
  await p.goto(url)
  await p.locator('[data-consent-banner]').waitFor()
  const empty = await audit(p)
  await p.locator('input[type=file]').setInputFiles('tests/fixtures/selection-quality.pdf')
  await p.waitForFunction(() => document.body.textContent.includes('Ready to read'))
  await p.getByRole('button', { name: 'Read-along text', exact: true }).click()
  const results = { empty: empty.blocked, read: (await audit(p)).blocked }
  if (mobile) for (const tab of ['Voices', 'Read']) {
    const t = p.getByRole('tab', { name: tab, exact: true })
    if (await t.count()) { await t.click(); results[tab.toLowerCase()] = (await audit(p)).blocked }
  }
  // Select text so the selection actions are live, then tap "Read from selection" for real.
  await p.locator('.read-along-text').evaluate(el => {
    const node = document.createTreeWalker(el, NodeFilter.SHOW_TEXT).nextNode()
    const range = document.createRange(); range.setStart(node, 0); range.setEnd(node, Math.min(10, node.textContent.length))
    const s = getSelection(); s.removeAllRanges(); s.addRange(range); document.dispatchEvent(new Event('selectionchange'))
  })
  const button = p.locator('.preview-scroll > .selection-actions').getByRole('button', { name: 'Read from selection', exact: true })
  await button.scrollIntoViewIfNeeded()
  await button.click({ timeout: 5000, trial: true })
  if (width === 390) await p.screenshot({ path: `${out}/mobile-390x844-banner-and-read-from-selection.png` })
  await p.screenshot({ path: `${out}/${width}x${height}.png` })
  const stillOpen = await p.locator('[data-consent-banner]').isVisible()
  const blocked = Object.entries(results).filter(([, list]) => list.length)
  // Consent behaviour is unchanged: nothing from Google before a choice, Reject keeps it
  // that way and is remembered, and the reserved room is released.
  const noTagBeforeChoice = tagRequests.length === 0
  await p.getByRole('button', { name: 'Reject', exact: true }).click()
  const released = await p.evaluate(() => !document.documentElement.style.getPropertyValue('--consent-space') && !document.querySelector('[data-consent-banner]') && localStorage.getItem('latte-analytics-consent') === 'denied')
  await p.reload(); await p.waitForTimeout(500)
  const remembered = (await p.locator('[data-consent-banner]').count()) === 0 && tagRequests.length === 0
  const ok = stillOpen && !blocked.length && noTagBeforeChoice && released && remembered
  console.log(`[consent-banner] ${width}x${height}: banner open ${stillOpen}, blocked ${blocked.length ? JSON.stringify(Object.fromEntries(blocked)) : 'none'}, no tag before choice ${noTagBeforeChoice}, reject released+remembered ${released && remembered} ${ok ? 'PASS' : 'FAIL'}`)
  if (!ok) failures++
  await context.close()
}
await browser.close()
if (failures) { console.log(`[consent-banner] ${failures} failing size(s)`); process.exit(1) }
console.log('[consent-banner] PASS')
