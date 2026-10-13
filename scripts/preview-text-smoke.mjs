// Selectable text panel smoke.
//
// The transcript panel is a disclosure, closed by default, so the PDF page leads the preview.
// Expanded, mobile bounds it to half the viewport; desktop uses the sole preview scrollport,
// and selecting text inside it still reads only the selection. Uses a long-text fixture so the
// bound is exercised against a genuinely long wall of text.
import { chromium } from 'playwright'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const longFixture = path.join(root, 'tests/fixtures/latte-reader-long-text-fixture.pdf')
const baseURL = process.env.LATTE_READER_URL ?? 'http://127.0.0.1:4176/'
const VIEWPORTS = [
  { width: 390, height: 844, label: 'phone' },
  { width: 1440, height: 1000, label: 'desktop' },
]

const browser = await chromium.launch({ headless: true })
const failures = []
const check = (condition, message) => { if (!condition) failures.push(message) }
const results = []

for (const viewport of VIEWPORTS) {
  const page = await browser.newPage({ viewport })
  page.on('pageerror', (error) => failures.push(`${viewport.label}: uncaught browser error: ${error.message}`))
  await page.addInitScript(() => {
    class TestUtterance {
      constructor(text) { this.text = text; this.rate = 1; this.voice = null; this.onend = null; this.onerror = null }
    }
    Object.defineProperty(window, 'SpeechSynthesisUtterance', { value: TestUtterance })
    Object.defineProperty(window, 'speechSynthesis', {
      value: {
        paused: false,
        cancel() {},
        pause() {},
        resume() {},
        getVoices() { return [{ name: 'Fixture Voice' }] },
        speak(utterance) {
          window.__utterances.push(utterance.text)
          window.setTimeout(() => { if (utterance.onend) utterance.onend() }, 60)
        },
      },
    })
    window.__utterances = []
  })

  await page.goto(baseURL, { waitUntil: 'networkidle' })
  await page.getByRole('heading', { name: 'Choose a PDF to begin' }).waitFor()
  await page.locator('input[type=file]').setInputFiles(longFixture)
  await page.waitForFunction(() => document.body.textContent?.includes('Extraction complete'), undefined, { timeout: 20000 })
  await page.locator('.page-stage canvas').waitFor({ timeout: 20000 })
  await page.waitForTimeout(400)

  const disclosure = page.locator('.page-text-disclosure')
  const summary = disclosure.locator('summary')
  check(await disclosure.count() === 1, `${viewport.label}: selectable text disclosure is missing`)
  check(await disclosure.evaluate((node) => !node.hasAttribute('open')), `${viewport.label}: transcript panel is open by default`)
  check((await summary.innerText()).trim() === 'Select text to read only that part', `${viewport.label}: disclosure says "${(await summary.innerText()).trim()}"`)

  const collapsed = await page.evaluate(() => {
    const details = document.querySelector('.page-text-disclosure').getBoundingClientRect()
    const canvas = document.querySelector('.page-stage canvas').getBoundingClientRect()
    return { panelHeight: Math.round(details.height), canvasTop: Math.round(canvas.top), panelTop: Math.round(details.top), viewportHeight: window.innerHeight }
  })
  check(collapsed.canvasTop < collapsed.panelTop, `${viewport.label}: transcript panel precedes the PDF page`)
  check(collapsed.panelHeight <= 0.12 * collapsed.viewportHeight, `${viewport.label}: collapsed panel is ${collapsed.panelHeight}px tall`)

  await summary.click()
  check(await disclosure.evaluate((node) => node.hasAttribute('open')), `${viewport.label}: disclosure did not expand on click`)

  const expanded = await page.evaluate(() => {
    const region = document.querySelector('.page-text')
    return { height: Math.round(region.getBoundingClientRect().height), scrollHeight: region.scrollHeight, clientHeight: region.clientHeight, viewportHeight: window.innerHeight }
  })
  // Natural height with the bound removed, for an honest before/after number.
  const unbounded = await page.evaluate(() => {
    const region = document.querySelector('.page-text')
    const previous = { maxHeight: region.style.maxHeight, overflow: region.style.overflow }
    region.style.maxHeight = 'none'
    region.style.overflow = 'visible'
    const height = Math.round(region.getBoundingClientRect().height)
    region.style.maxHeight = previous.maxHeight
    region.style.overflow = previous.overflow
    return height
  })
  results.push({ ...viewport, collapsedPanelHeight: collapsed.panelHeight, expandedRegionHeight: expanded.height, unboundedRegionHeight: unbounded, bound: Math.round(expanded.viewportHeight / 2), scrollsInside: expanded.scrollHeight > expanded.clientHeight + 1 })

  if (viewport.width < 781) {
    check(expanded.height <= expanded.viewportHeight / 2 + 1, `${viewport.label}: expanded transcript is ${expanded.height}px of a ${expanded.viewportHeight}px viewport`)
    check(expanded.scrollHeight > expanded.clientHeight + 1, `${viewport.label}: expanded transcript does not scroll internally`)
    check(unbounded > expanded.height + 40, `${viewport.label}: the bound is not limiting anything (${unbounded}px natural vs ${expanded.height}px)`)
    check(expanded.height < unbounded, `${viewport.label}: expanded transcript is not bounded`)
  } else {
    const scroll = await page.evaluate(() => {
      const viewer=document.querySelector('.preview-scroll'), header=document.querySelector('.preview-header'), text=document.querySelector('.page-text')
      const top=header.getBoundingClientRect().top
      viewer.scrollTop=viewer.scrollHeight
      const end=viewer.scrollTop
      viewer.scrollTop=0
      return { bodyScroll:document.documentElement.scrollHeight-innerHeight, viewerHeight:viewer.clientHeight, contentHeight:viewer.scrollHeight, end, headerDelta:header.getBoundingClientRect().top-top, nestedOverflow:getComputedStyle(text).overflow }
    })
    check(scroll.bodyScroll===0 && scroll.end>100 && scroll.contentHeight>scroll.viewerHeight, 'desktop: long transcript must scroll inside the viewer, not grow the body')
    check(scroll.headerDelta===0 && scroll.nestedOverflow==='visible', 'desktop: transcript created another document scrollport or moved chrome')
    results.at(-1).viewerScroll=scroll
  }

  // Selecting text inside the open panel still reads only the selection.
  {
    await page.evaluate(() => {
      const paragraph = document.querySelector('.page-text p')
      const range = document.createRange()
      range.setStart(paragraph.firstChild, 0)
      range.setEnd(paragraph.firstChild, 12)
      const selection = window.getSelection()
      selection.removeAllRanges()
      selection.addRange(range)
    })
    await page.getByRole('button', { name: 'Start reading' }).click()
    await page.waitForFunction(() => (window.__utterances ?? []).length >= 1, undefined, { timeout: 10000 })
    const spoken = await page.evaluate(() => window.__utterances.at(-1))
    check(spoken.length < 40, `${viewport.label}: selection reading read more than the selection ("${spoken}")`)
    check(!spoken.includes('transcript line'), `${viewport.label}: selection reading escaped the selection ("${spoken}")`)
    results.at(-1).selectionRead = spoken
    await page.getByRole('button', { name: 'Stop reading' }).click()
  }

  await summary.click()
  check(!(await disclosure.evaluate((node) => node.hasAttribute('open'))), `${viewport.label}: disclosure did not collapse on click`)
  await page.close()
}

await browser.close()
if (failures.length) {
  console.error(JSON.stringify({ status: 'failed', failures, results }, null, 2))
  process.exit(1)
}
console.log(JSON.stringify({ status: 'passed', results }, null, 2))
