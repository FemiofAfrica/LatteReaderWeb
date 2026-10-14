import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { mkdir, writeFile } from 'node:fs/promises'
const url = process.env.LATTE_READER_URL ?? 'http://127.0.0.1:4188/'
const artifacts = 'tests/artifacts/reading-quality'
await mkdir(artifacts, { recursive: true })
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
await page.addInitScript(() => {
  window.__heldMessages = []; window.__holdExtraction = false
  const NativeWorker = window.Worker
  window.Worker = class extends NativeWorker {
    set onmessage(callback) {
      super.onmessage = event => {
        if (window.__holdExtraction && ((event.data.type === 'page' && event.data.pageNumber === 2) || event.data.type === 'complete')) {
          window.__heldMessages.push(() => callback(event))
        } else callback(event)
      }
    }
    get onmessage() { return super.onmessage }
  }
  window.__releaseExtraction = () => { window.__holdExtraction = false; window.__heldMessages.splice(0).forEach(fn => fn()) }
  window.__inputs = []; window.__cancels = 0; window.__current = null
  Object.defineProperty(window, 'SpeechSynthesisUtterance', { value: class { constructor(text) { this.text = text } } })
  Object.defineProperty(window, 'speechSynthesis', { value: {
    getVoices: () => [{ name: 'Test' }],
    cancel() { window.__cancels++ }, pause() {}, resume() {},
    speak(u) { window.__current = u; window.__inputs.push(u.text); u.onstart?.() },
  } })
})
const ready = () => page.waitForFunction(() => document.body.textContent.includes('Ready to read'))
const pageNumber = () => page.getByLabel('Current page').innerText()
await page.goto(url)
await page.locator('input[type=file]').setInputFiles('tests/fixtures/reading-quality.pdf')
await ready()
await page.getByRole('button', { name: 'Start reading' }).click()
const inputs = await page.evaluate(() => window.__inputs)
assert.deepEqual(inputs, ['f ff fi fl ffi ffl ff fi fl ffi ffl “fine” Five fine friends find fresh coffee. A well-known difference.'])
assert.match(await pageNumber(), /^1/)
await page.evaluate(() => window.__current.onboundary({ charIndex: window.__current.text.indexOf('find fresh') }))
assert.match(await pageNumber(), /^2/)
await page.getByRole('button', { name: 'Pause reading' }).click()
await page.getByRole('button', { name: 'Resume reading' }).click()
const beforeBrowse = await page.evaluate(() => window.__cancels)
await page.getByRole('button', { name: 'Previous page' }).click()
assert.match(await pageNumber(), /^1/)
assert.equal(await page.getByRole('button', { name: 'Pause reading' }).count(), 1)
await page.evaluate(() => window.__current.onboundary({ charIndex: 70 }))
assert.match(await pageNumber(), /^1/) // browsing suspends follow, not speech
assert.equal(await page.evaluate(() => window.__cancels), beforeBrowse)
await page.getByRole('button', { name: 'Follow reading' }).click()
assert.match(await pageNumber(), /^2/)
await page.getByRole('button', { name: 'Stop reading' }).click()
await page.getByLabel('Go to page').fill('1')
await page.getByRole('button', { name: 'Start reading' }).click()
const cancels = await page.evaluate(() => window.__cancels)
await page.evaluate(() => window.__current.onend())
assert.match(await pageNumber(), /^2/)
assert.equal(await page.evaluate(() => window.__cancels), cancels)
await page.getByLabel('Go to page').fill('1')
await page.getByRole('radio', { name: 'This page only' }).check()
await page.getByRole('button', { name: 'Start reading' }).click()
assert.equal(await page.evaluate(() => window.__inputs.at(-1)), 'f ff fi fl ffi ffl ff fi fl ffi ffl “fine” Five fine friends')
await page.getByRole('button', { name: 'Stop reading' }).click()
await page.getByRole('radio', { name: 'To the end' }).check()
const measurements = []
for (const width of [360, 390, 504, 768, 1440]) {
  await page.setViewportSize({ width, height: 1000 })
  await page.waitForTimeout(300)
  if (width < 781) {
    assert.equal(await page.getByRole('tab').count(), 3)
    assert.equal(await page.getByRole('tab', { name: 'Preview' }).count(), 0)
  }
  assert.equal(await page.getByRole('button', { name: 'Next page' }).isVisible(), true)
  assert.equal(await page.locator('canvas').isVisible(), true)
  const geometry = await page.evaluate(() => {
    const rect = s => { const r = document.querySelector(s).getBoundingClientRect(); return { top:r.top, bottom:r.bottom, left:r.left, right:r.right, height:r.height } }
    return { width: innerWidth, overflow: document.documentElement.scrollWidth - innerWidth, top:rect('.topbar'), header:rect('.preview-header'), canvas:rect('canvas'), bar: document.querySelector('.mobile-bar') ? rect('.mobile-bar') : null }
  })
  assert.equal(geometry.overflow, 0)
  if (geometry.bar) {
    assert.ok(geometry.header.bottom < geometry.bar.top, 'pinned header leaves room for visible page')
    await page.evaluate(() => scrollTo(0, 240))
    const pinned = await page.locator('.preview-header').boundingBox()
    assert.ok(Math.abs(pinned.y - geometry.top.height) < 2)
    await page.evaluate(() => scrollTo(0, 0))
  }
  measurements.push(geometry)
  await page.screenshot({ path: `${artifacts}/reader-${width}.png`, fullPage: true })
}
await page.locator('input[type=file]').setInputFiles('tests/fixtures/reading-quality-unmapped.pdf')
await ready()
await page.getByRole('alert').filter({ hasText:'Some letters cannot be read' }).waitFor()
assert.doesNotMatch(await page.getByRole('alert').filter({hasText:'Some letters cannot be read'}).innerText(), /extracted|OCR|worker/)
await page.getByRole('button', { name: 'Start reading' }).click()
assert.match(await page.evaluate(() => window.__inputs.at(-1)), /�/)
assert.doesNotMatch(await page.evaluate(() => window.__inputs.at(-1)), /\u0000/)
await page.getByRole('button', { name: 'Stop reading' }).click()
// Delay actual worker output, not fabricated text: a page split during extraction must
// not become a truncated utterance. Pause/resume retains this pending run.
await page.setViewportSize({ width: 390, height: 844 })
await page.evaluate(() => { window.__holdExtraction = true })
await page.locator('input[type=file]').setInputFiles('tests/fixtures/reading-quality.pdf')
await page.waitForFunction(() => window.__heldMessages.length >= 2)
const beforeWaiting = await page.evaluate(() => window.__inputs.length)
await page.getByRole('button', { name: 'Start reading' }).click()
assert.equal(await page.locator('.mobile-reading-status').innerText(), 'Waiting for text')
await page.waitForTimeout(350)
assert.equal(await page.evaluate(() => window.__inputs.length), beforeWaiting)
await page.getByRole('button', { name: 'Pause reading' }).click()
assert.equal(await page.locator('.mobile-reading-status').innerText(), 'Paused')
await page.evaluate(() => window.__releaseExtraction())
await ready(); await page.waitForTimeout(350)
assert.equal(await page.evaluate(() => window.__inputs.length), beforeWaiting)
await page.getByRole('button', { name: 'Resume reading' }).click()
await page.waitForFunction(n => window.__inputs.length === n + 1, beforeWaiting)
assert.equal(await page.evaluate(() => window.__inputs.at(-1)), inputs[0])
await page.getByRole('button', { name: 'Stop reading' }).click()
await page.evaluate(() => { window.__holdExtraction = true })
await page.locator('input[type=file]').setInputFiles('tests/fixtures/reading-quality.pdf')
await page.waitForFunction(() => window.__heldMessages.length >= 2)
const beforeJump = await page.evaluate(() => window.__inputs.length)
await page.getByRole('button', { name: 'Start reading' }).click()
await page.getByRole('button', { name: 'Next page' }).click()
await page.evaluate(() => window.__releaseExtraction())
await ready(); await page.waitForTimeout(350)
assert.equal(await page.evaluate(() => window.__inputs.length), beforeJump + 1)
assert.match(await pageNumber(), /^2/) // waiting run starts from its captured source page, without snapping back
await page.getByRole('button', { name: 'Stop reading' }).click()
await writeFile(`${artifacts}/evidence.json`, JSON.stringify({ fixtureInputs:inputs, measurements, speech:'Exact API inputs verified with synthesis harness, not audible output.', unmapped:'Owned damaged ToUnicode fixture detected; no guessed letters.' }, null, 2))
await browser.close()
console.log(JSON.stringify({ passed: true, fixtureInputs: inputs, widths: measurements.map(m => m.width), artifacts, audibleSpeechVerified: false }, null, 2))
