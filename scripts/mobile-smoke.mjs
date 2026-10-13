// Real-browser smoke for the mobile bottom bar and continuous playback.
// Runs at a phone viewport (390x844): the bar must expose all four panels plus play/stop,
// only one panel renders at a time, and one press of play must read from the current page
// to the end of the document while the preview follows. Desktop must show no bottom bar.
import { chromium } from 'playwright'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const fixture = path.join(root, 'tests/fixtures/latte-reader-text-fixture.pdf')
const baseURL = process.env.LATTE_READER_URL ?? 'http://127.0.0.1:4176/'
const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
const failures = []
const check = (condition, message) => { if (!condition) failures.push(message) }
page.on('pageerror', (error) => failures.push(`Uncaught browser error: ${error.message}`))

// Every utterance completes on its own after a short delay, so a continuous run advances
// without any further taps. Speech is mocked; audibility is not claimed.
await page.addInitScript(() => {
  class TestUtterance {
    constructor(text) { this.text = text; this.rate = 1; this.voice = null; this.onend = null; this.onerror = null }
  }
  const synthesis = {
    paused: false,
    cancel() { this.speaking = false },
    pause() { this.paused = true },
    resume() { this.paused = false },
    getVoices() { return [{ name: 'Fixture Voice' }, { name: 'Character Voice' }] },
    speak(utterance) {
      window.__spoken = (window.__spoken ?? 0) + 1
      window.__utterances.push(utterance.text)
      window.setTimeout(() => { if (utterance.onend) utterance.onend() }, 60)
    },
  }
  window.__spoken = 0
  window.__utterances = []
  Object.defineProperty(window, 'SpeechSynthesisUtterance', { value: TestUtterance })
  Object.defineProperty(window, 'speechSynthesis', { value: synthesis })
})

const bar = () => page.locator('.mobile-bar')
const playButton = () => bar().getByRole('button', { name: /^(Start|Pause|Resume) reading$/ })
const stopButton = () => bar().getByRole('button', { name: 'Stop reading' })
const statusText = () => page.locator('.visually-hidden[role=status]').innerText()
const textPanel = () => page.locator('.page-text-disclosure')
const textSummary = () => page.locator('.page-text-disclosure summary')

await page.goto(baseURL, { waitUntil: 'networkidle' })
await page.getByRole('heading', { name: 'Choose a PDF to begin' }).waitFor()
await page.locator('input[type=file]').setInputFiles(fixture)
// Extraction status lives in the Document panel, which is hidden while Preview is the
// default mobile panel, so read the document text rather than a visible label.
await page.waitForFunction(() => document.body.textContent?.includes('Extraction complete'), undefined, { timeout: 20000 })
await page.locator('.page-text').getByText('LATTEREADER TEST STORY').waitFor({ timeout: 20000, state: 'attached' })

// 1. The bar exists with all four panels and a pinned transport.
check(await bar().isVisible(), 'Mobile bottom bar is not visible at 390x844')
const tabs = page.getByRole('tab')
check(await tabs.count() === 4, `Expected four panel selectors, saw ${await tabs.count()}`)
for (const name of ['Document', 'Read', 'Voices', 'Preview']) {
  check(await page.getByRole('tab', { name }).count() === 1, `Panel selector "${name}" is missing`)
}
check(await playButton().isVisible(), 'Play control is not visible in the bar')
check(await stopButton().isVisible(), 'Stop control is not visible in the bar')

// 2. Preview is the default panel, so page and play are together, and only it renders.
check(await page.getByRole('tab', { name: 'Preview' }).getAttribute('aria-selected') === 'true', 'Preview is not the default panel')
check(await page.locator('#panel-preview').isVisible(), 'Preview panel is not visible by default')
check(!(await page.locator('#panel-document').isVisible()), 'Document panel rendered alongside the default panel')
await page.screenshot({ path: path.join(root, 'tests/artifacts/mobile-panel-preview.png') })

// 2b. The selectable text is a disclosure: closed by default so the PDF page leads the
// preview, labelled with one plain line, and bounded while open.
check(await textPanel().count() === 1, 'The selectable text disclosure is missing')
check(await textPanel().evaluate((node) => !node.hasAttribute('open')), 'The selectable text panel is open by default')
check((await textSummary().innerText()).trim() === 'Select text to read only that part', `The disclosure label reads "${(await textSummary().innerText()).trim()}"`)
const previewOrder = await page.evaluate(() => {
  const canvas = document.querySelector('.page-stage canvas').getBoundingClientRect()
  const panel = document.querySelector('.page-text-disclosure').getBoundingClientRect()
  return { canvasTop: Math.round(canvas.top), panelTop: Math.round(panel.top), collapsedHeight: Math.round(panel.height), viewportHeight: window.innerHeight }
})
check(previewOrder.canvasTop < previewOrder.panelTop, 'The text panel does not follow the PDF page in the mobile preview')
check(previewOrder.collapsedHeight <= 0.12 * previewOrder.viewportHeight, `The collapsed text panel is ${previewOrder.collapsedHeight}px tall`)

// Pointer opens it, and the open region stays inside half the viewport.
await textSummary().click()
check(await textPanel().evaluate((node) => node.hasAttribute('open')), 'Clicking the disclosure did not expand it')
const openPanel = await page.evaluate(() => {
  const region = document.querySelector('.page-text')
  return { height: Math.round(region.getBoundingClientRect().height), viewportHeight: window.innerHeight }
})
check(openPanel.height <= openPanel.viewportHeight / 2 + 1, `The expanded text region is ${openPanel.height}px of a ${openPanel.viewportHeight}px viewport`)

// Keyboard closes and reopens it: Enter and Space both toggle the disclosure.
await textSummary().focus()
await page.keyboard.press('Enter')
check(!(await textPanel().evaluate((node) => node.hasAttribute('open'))), 'Enter did not collapse the disclosure')
await page.keyboard.press('Space')
check(await textPanel().evaluate((node) => node.hasAttribute('open')), 'Space did not expand the disclosure')
await page.keyboard.press('Space')
check(!(await textPanel().evaluate((node) => node.hasAttribute('open'))), 'Space did not collapse the disclosure again')

// 3. Each panel switches in turn; only the selected one renders.
await page.getByRole('tab', { name: 'Document' }).click()
check(await page.locator('#panel-document').isVisible(), 'Document panel did not open')
check(!(await page.locator('#panel-preview').isVisible()), 'Preview stayed visible while Document was selected')
await page.screenshot({ path: path.join(root, 'tests/artifacts/mobile-panel-document.png') })

await page.getByRole('tab', { name: 'Read' }).click()
check(await page.locator('#panel-read').isVisible(), 'Read panel did not open')
check(await page.getByText('To the end', { exact: true }).isVisible(), 'Continuous reading scope option is missing')
check(await page.getByRole('radio').count() === 2, 'Reading scope control is not available on mobile')
await page.screenshot({ path: path.join(root, 'tests/artifacts/mobile-panel-read.png') })

await page.getByRole('tab', { name: 'Voices' }).click()
check(await page.getByText('Browser voice', { exact: true }).isVisible(), 'Voices panel did not open')
check(await page.getByRole('button', { name: 'Analyze Characters' }).isVisible(), 'Character voices are missing from the Voices panel')
await page.screenshot({ path: path.join(root, 'tests/artifacts/mobile-panel-voices.png') })
await page.getByRole('tab', { name: 'Preview' }).click()

// 4. One press of play reads continuously to the end of the document.
await page.getByRole('tab', { name: 'Document' }).click()
await page.getByLabel('Go to page').fill('1')
await page.getByRole('tab', { name: 'Preview' }).click()
await page.waitForFunction(() => document.querySelector('.preview-header')?.textContent?.includes('Page 1'))
await playButton().click()
await page.waitForFunction(() => (window.__spoken ?? 0) >= 2, undefined, { timeout: 15000 })
await page.waitForFunction(() => document.querySelector('.mobile-bar .play-button')?.getAttribute('aria-label') === 'Start reading', undefined, { timeout: 15000 })
const spoken = await page.evaluate(() => window.__spoken)
const readTexts = await page.evaluate(() => window.__utterances.join(' | '))
check(spoken >= 2, `Continuous reading stopped after ${spoken} page(s)`)
check(readTexts.includes('LATTEREADER TEST STORY'), 'First page text was never read')
check(readTexts.includes('SECOND PAGE'), 'Reading did not continue onto the second page')
check((await statusText()).includes('Finished the document'), 'Playback did not report the end of the document')
check(await page.locator('.preview-header').innerText().then(text => text.includes('Page 2')), 'The preview did not follow playback to the last page')

// The stored reading position must follow playback, not just the on-screen preview.
// The position is written on a short debounce, so poll briefly for it to land.
const readStoredPage = () => page.evaluate(async () => {
  const database = await new Promise((resolve, reject) => {
    const request = indexedDB.open('latte-reader-local', 1)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  const transaction = database.transaction('current-document', 'readonly')
  const request = transaction.objectStore('current-document').get('current')
  const record = await new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  database.close()
  return record?.reader?.currentPage
})
let storedPage = await readStoredPage()
for (let attempt = 0; attempt < 20 && storedPage !== 2; attempt += 1) {
  await page.waitForTimeout(200)
  storedPage = await readStoredPage()
}
check(storedPage === 2, `Stored reading position did not follow playback (saw page ${storedPage})`)

// 5. Stop cancels immediately: no utterance starts after stop.
await page.getByRole('tab', { name: 'Document' }).click()
await page.getByLabel('Go to page').fill('1')
await page.getByRole('tab', { name: 'Preview' }).click()
await page.waitForFunction(() => document.querySelector('.preview-header')?.textContent?.includes('Page 1'))
await playButton().click()
await page.waitForFunction(() => (window.__spoken ?? 0) >= 1, undefined, { timeout: 10000 })
await stopButton().click()
const spokenAtStop = await page.evaluate(() => window.__spoken)
await page.waitForTimeout(600)
check(await page.evaluate(() => window.__spoken) === spokenAtStop, 'An utterance started after Stop was pressed')
check(await playButton().getAttribute('aria-label') === 'Start reading', 'Stop did not return playback to the ready state')

// 5b. Selection reading still reads only the selection. The transcript is behind a
// disclosure, so open it before selecting, as a reader would.
await page.getByRole('tab', { name: 'Preview' }).click()
await page.waitForFunction(() => document.querySelector('.preview-header')?.textContent?.includes('Page 1'))
if (!(await textPanel().evaluate((node) => node.hasAttribute('open')))) await textSummary().click()
await page.evaluate(() => {
  const paragraph = document.querySelector('.page-text p')
  const range = document.createRange()
  range.setStart(paragraph.firstChild, 0)
  range.setEnd(paragraph.firstChild, 12)
  const selection = window.getSelection()
  selection.removeAllRanges()
  selection.addRange(range)
})
const spokenBeforeSelection = await page.evaluate(() => window.__spoken)
await playButton().click()
await page.waitForFunction((before) => (window.__spoken ?? 0) > before, spokenBeforeSelection, { timeout: 10000 })
const selectionRead = await page.evaluate(() => window.__utterances.at(-1))
check(selectionRead.length < 40 && !selectionRead.includes('ALICE'), `Selection reading read more than the selection: "${selectionRead}"`)
await stopButton().click()
await page.evaluate(() => window.getSelection().removeAllRanges())
await textSummary().click()

// 6. No horizontal overflow at the phone width.
const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
check(overflow <= 0, `Mobile layout overflowed horizontally by ${overflow}px`)

// 6b. The preview fits the page to the container, so a line is readable without sideways
// scrolling at the default mobile view.
const fit = await page.evaluate(() => {
  const scroller = document.querySelector('.preview-scroll')
  const canvas = document.querySelector('.page-stage canvas')
  const style = getComputedStyle(scroller)
  const readout = document.querySelector('.preview-zoom output')
  return {
    readout: (readout?.textContent ?? '').trim(),
    contentWidth: scroller.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
    canvasWidth: Math.round(canvas.getBoundingClientRect().width),
    scrollsSideways: scroller.scrollWidth > scroller.clientWidth,
  }
})
check(!fit.scrollsSideways, 'The mobile preview still scrolls sideways to read a line')
check(fit.canvasWidth <= fit.contentWidth, `The page (${fit.canvasWidth}px) is wider than the preview content (${fit.contentWidth}px)`)
check(fit.readout !== '100%', `The mobile zoom readout still reads ${fit.readout} instead of a fitted value`)

// 7. Desktop keeps the console and has no bottom bar.
await page.setViewportSize({ width: 1440, height: 1000 })
await page.waitForTimeout(250)
check(await page.locator('.mobile-bar').count() === 0, 'Bottom bar is present in the desktop layout')
check(await page.locator('.transport').isVisible(), 'Desktop transport footer is missing')
check(await page.locator('.control-rail').isVisible(), 'Desktop control rail is missing')
await page.screenshot({ path: path.join(root, 'tests/artifacts/desktop-view.png'), fullPage: true })

await browser.close()
if (failures.length) {
  console.error(JSON.stringify({ status: 'failed', failures }, null, 2))
  process.exit(1)
}
console.log(JSON.stringify({
  status: 'passed',
  spoken,
  readTexts,
  previewOrder,
  openPanel,
  fit,
  verified: [
    'mobile bottom bar with four panel selectors plus play and stop',
    'only one panel renders at a time, preview by default',
    'all four panels switchable',
    'selectable text is a disclosure, closed by default, labelled with one plain line',
    'the disclosure opens and closes by pointer and by keyboard (Enter and Space)',
    'the PDF page leads the preview and the collapsed panel stays under 12% of the viewport',
    'the expanded transcript stays inside half the viewport',
    'one play press reads continuously to the end of the document',
    'preview follows the page being read',
    'the stored reading position follows playback',
    'stop cancels with no further utterances',
    'selection reading inside the open disclosure still reads only the selection',
    'the preview opens fitted to the container, so no sideways scrolling is needed',
    'no horizontal overflow at 390x844',
    'desktop keeps the console with no bottom bar',
  ],
  speech: 'mocked synthesis; audibility is not claimed',
}, null, 2))
