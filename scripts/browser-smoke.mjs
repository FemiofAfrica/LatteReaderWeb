import { chromium } from 'playwright'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const fixture = path.join(root, 'tests/fixtures/latte-reader-text-fixture.pdf')
const baseURL = process.env.LATTE_READER_URL ?? 'http://127.0.0.1:4173/'
const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
const fakeWorkerWarnings = []
const initialRequests = []
page.on('request', (request) => initialRequests.push(request.url()))
page.on('console', (message) => {
  console.log(`[browser:${message.type()}] ${message.text()}`)
  if (message.text().includes('Setting up fake worker')) fakeWorkerWarnings.push(message.text())
})
const failures = []
page.on('pageerror', (error) => {
  console.error(`[browser:error] ${error.message}`)
  failures.push(`Uncaught browser error: ${error.message}`)
})
const check = (condition, message) => {
  if (!condition) failures.push(message)
}

await page.addInitScript(() => {
  class TestUtterance {
    constructor(text) { this.text = text; this.rate = 1; this.voice = null; this.onend = null; this.onerror = null }
  }
  const synthesis = {
    paused: false,
    pending: false,
    speaking: false,
    cancel() { this.speaking = false },
    pause() { this.paused = true },
    resume() { this.paused = false },
    speak() { this.speaking = true },
    getVoices() { return [{ name: 'Fixture Voice' }, { name: 'Character Voice' }] },
  }
  Object.defineProperty(window, 'SpeechSynthesisUtterance', { value: TestUtterance })
  Object.defineProperty(window, 'speechSynthesis', { value: synthesis })
})

await page.goto(baseURL, { waitUntil: 'networkidle' })
await page.getByRole('heading', { name: 'Choose a PDF to begin' }).waitFor()
check(await page.getByText('Your current PDF is saved only in this browser', { exact: false }).isVisible(), 'Local persistence copy is not visible')

const initialPdfRequests = initialRequests.filter((url) => /pdfjs|\/assets\/(?:pdf[-.]|loadPdf[-.])|\/pdf\/loadPdf/.test(url))
check(initialPdfRequests.length === 0, `PDF modules loaded before opening a document: ${initialPdfRequests.join(', ')}`)
await page.locator('input[type=file]').setInputFiles(fixture)
try {
  await page.getByText('Extraction complete', { exact: true }).waitFor({ timeout: 15000 })
} catch (error) {
  console.error(await page.locator('body').innerText())
  throw error
}
// The transcript sits behind a disclosure now, so it is present but not visible until opened.
await page.getByText('LATTEREADER TEST STORY').waitFor({ timeout: 15000, state: 'attached' })

const metadata = await page.locator('.document-metrics').innerText()
check(metadata.includes('2'), 'Page count did not render as 2')
check(!metadata.endsWith('0'), 'Character count stayed at zero')
const canvasSize = await page.locator('canvas').evaluate((canvas) => ({ width: canvas.width, height: canvas.height }))
check(canvasSize.width > 0 && canvasSize.height > 0, 'PDF page canvas did not render')

await page.getByRole('button', { name: 'Next page' }).click()
check((await page.getByLabel('Current page').innerText()).startsWith('2'), 'Next page did not navigate to page 2')
await page.getByText('SECOND PAGE').waitFor({ state: 'attached' })
await page.getByRole('button', { name: 'Previous page' }).click()
check((await page.getByLabel('Current page').innerText()).startsWith('1'), 'Previous page did not return to page 1')

await page.getByLabel('Preview zoom').fill('120')
check((await page.locator('.zoom-readout').innerText()).includes('120%'), 'Zoom control did not update the preview')

await page.getByRole('button', { name: 'Analyze Characters' }).click()
await page.getByText('Alice', { exact: true }).waitFor()
await page.getByText('Bob', { exact: true }).waitFor()
check((await page.locator('.speaker-list').innerText()).includes('3 voices'), 'Voice plan did not include narrator plus two speakers')

await page.locator('input[type=file]').setInputFiles({ name: 'invalid.pdf', mimeType: 'application/pdf', buffer: Buffer.from('not a pdf') })
await page.getByRole('alert').waitFor()
check((await page.locator('.filename').innerText()) === 'latte-reader-text-fixture.pdf', 'Invalid upload replaced the working document')

await page.getByRole('button', { name: 'Next page' }).click()
await page.getByLabel('Reading speed').fill('1.25')
await page.waitForTimeout(350)
await page.reload({ waitUntil: 'networkidle' })
await page.getByText('Extraction complete', { exact: true }).waitFor({ timeout: 15000 })
check((await page.getByLabel('Current page').innerText()).startsWith('2'), 'Reload did not restore the reading page')
check((await page.locator('.zoom-readout').innerText()).includes('120%'), 'Reload did not restore zoom')
check(await page.getByText('Alice', { exact: true }).isVisible(), 'Reload did not restore the voice plan')

await page.getByRole('button', { name: 'Start reading' }).click()
check((await page.locator('.playback-readout strong').innerText()).toLowerCase() === 'playing', 'Playback did not enter playing state')
await page.getByRole('button', { name: 'Pause reading' }).click()
check((await page.locator('.playback-readout strong').innerText()).toLowerCase() === 'paused', 'Playback did not enter paused state')
await page.getByRole('button', { name: 'Stop reading' }).click()
check((await page.locator('.playback-readout strong').innerText()).toLowerCase() === 'ready', 'Playback did not return to ready state')

const desktopLayout = await page.evaluate(() => ({ body: document.body.scrollWidth, viewport: innerWidth }))
check(desktopLayout.body <= desktopLayout.viewport, `Desktop body overflowed: ${desktopLayout.body} > ${desktopLayout.viewport}`)
check(await page.locator('.mobile-bar').count() === 0, 'Mobile bottom bar is present in the desktop layout')
check(await page.locator('.transport').isVisible(), 'Desktop transport footer is missing')
await page.screenshot({ path: path.join(root, 'tests/artifacts/desktop-loaded.png'), fullPage: true })

await page.setViewportSize({ width: 1024, height: 768 })
await page.waitForTimeout(250)
const narrowLayout = await page.evaluate(() => ({
  body: document.body.scrollWidth,
  viewport: innerWidth,
  topbarRight: document.querySelector('.topbar')?.getBoundingClientRect().right ?? 0,
  transportRight: document.querySelector('.transport')?.getBoundingClientRect().right ?? 0,
}))
check(narrowLayout.body <= narrowLayout.viewport, `Narrow body overflowed: ${narrowLayout.body} > ${narrowLayout.viewport}`)
check(narrowLayout.topbarRight <= narrowLayout.viewport, 'Top bar is clipped at 1024px')
check(narrowLayout.transportRight <= narrowLayout.viewport, 'Transport is clipped at 1024px')
check(await page.locator('.mobile-bar').count() === 0, 'Mobile bottom bar is present at 1024px')
await page.screenshot({ path: path.join(root, 'tests/artifacts/tablet-loaded.png'), fullPage: true })

const storedDocument = await page.evaluate(async () => {
  const database = await new Promise((resolve, reject) => {
    const request = indexedDB.open('latte-reader-local', 1)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  const transaction = database.transaction('current-document', 'readonly')
  const store = transaction.objectStore('current-document')
  const recordRequest = store.get('current')
  const countRequest = store.count()
  const [record, count] = await Promise.all([
    new Promise((resolve, reject) => {
      recordRequest.onsuccess = () => resolve(recordRequest.result)
      recordRequest.onerror = () => reject(recordRequest.error)
    }),
    new Promise((resolve, reject) => {
      countRequest.onsuccess = () => resolve(countRequest.result)
      countRequest.onerror = () => reject(countRequest.error)
    }),
  ])
  database.close()
  return { name: record?.name, byteLength: record?.bytes?.byteLength, currentPage: record?.reader?.currentPage, count }
})
check(storedDocument.name === 'latte-reader-text-fixture.pdf', 'IndexedDB did not retain the current PDF')
check(storedDocument.byteLength > 0 && storedDocument.count === 1, 'IndexedDB did not contain exactly one PDF slot')
check(storedDocument.currentPage === 2, 'IndexedDB did not retain the current reading page')

page.once('dialog', (dialog) => dialog.accept())
await page.locator('.document-details summary').click()
await page.getByRole('button', { name: 'Delete local data' }).click()
await page.getByRole('heading', { name: 'Choose a PDF to begin' }).waitFor()

check(fakeWorkerWarnings.length === 0, 'PDF.js fell back to a fake worker')
await browser.close()
if (failures.length) {
  console.error(JSON.stringify({ status: 'failed', failures }, null, 2))
  process.exit(1)
}
console.log(JSON.stringify({
  status: 'passed',
  initialPdfRequests,
  fakeWorkerWarnings,
  fixture,
  metadata: metadata.replace(/\n/g, ' | '),
  canvasSize,
  desktopLayout,
  narrowLayout,
  storedDocument,
  verified: ['empty state', 'lazy PDF loading', 'no fake worker fallback', 'local PDF load', 'incremental extraction', 'canvas rendering', 'page navigation', 'zoom', 'speaker analysis', 'invalid upload preservation', 'reload restore', 'mocked playback states', 'desktop and tablet overflow', 'no mobile bottom bar on desktop', 'one IndexedDB current-document slot', 'local data deletion'],
}, null, 2))
