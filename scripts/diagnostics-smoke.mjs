import { chromium } from 'playwright'
import { readFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import assert from 'node:assert/strict'
import { resolve } from 'node:path'
const base = process.env.LATTE_READER_URL ?? 'http://127.0.0.1:4176/'
const origin = new URL(base).origin
const log = resolve('.runtime/diagnostics/events.jsonl')
const fixture = resolve('tests/fixtures/latte-reader-text-fixture.pdf')
const browser = await chromium.launch({ headless: true })
const readEvents = () => readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse)
const wait = ms => new Promise(r => setTimeout(r, ms))
async function waitEvents(predicate) {
  for (let i = 0; i < 50; i++) { const events = readEvents(); if (predicate(events)) return events; await wait(100) }
  throw new Error('Expected runtime diagnostics did not arrive')
}
let production
try {
  const before = readFileSync(log, 'utf8')
  const sample = readEvents()[0]
  const post = (body, requestOrigin = origin) => fetch(`${origin}/__latte_diagnostics/events`, { method: 'POST', headers: { Origin: requestOrigin, 'Content-Type': 'application/json' }, body })
  assert.equal((await post(JSON.stringify([{ ...sample, filename: 'PRIVATE' }]))).status, 400)
  assert.equal((await post(JSON.stringify([{ ...sample, event: 'PRIVATE' }]))).status, 400)
  assert.equal((await post(JSON.stringify([sample]), 'https://evil.example')).status, 403)
  assert.equal((await post('x'.repeat(17000))).status, 413)
  assert.equal(readFileSync(log, 'utf8'), before, 'Rejected ingestion changed log')
  // Server-side rejection diagnostics: status + fixed reason code only, never payload/url data.
  const rejectLog = resolve('.runtime/diagnostics/ingest-rejections.jsonl')
  const rejections = readFileSync(rejectLog, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
  assert(rejections.some(n => n.reason === 'invalid-batch' && n.status === 400), 'no invalid-batch rejection recorded')
  assert(rejections.some(n => n.reason === 'origin' && n.status === 403), 'no origin rejection recorded')
  assert(rejections.some(n => n.reason === 'too-large' && n.status === 413), 'no too-large rejection recorded')
  assert(rejections.every(n => Object.keys(n).every(k => ['timestamp', 'status', 'reason'].includes(k))), 'rejection has extra fields')
  assert(!/PRIVATE|evil\.example|filename/.test(readFileSync(rejectLog, 'utf8')), 'rejection log leaked payload data')
  const page = await browser.newPage()
  const requests = []
  page.on('request', r => { if (r.method() === 'POST') requests.push({ url: r.url(), body: r.postData() }) })
  await page.addInitScript(() => {
    class Utterance { constructor(text) { this.text = text } }
    Object.defineProperty(window, 'SpeechSynthesisUtterance', { value: Utterance })
    Object.defineProperty(window, 'speechSynthesis', { value: {
      getVoices: () => [], cancel() {}, pause() {}, resume() {},
      speak(utterance) { window.__testUtterance = utterance },
    } })
  })
  await page.goto(base)
  await page.getByRole('heading', { name: 'Choose a PDF to begin' }).waitFor()
  await page.locator('input[type=file]').setInputFiles(fixture)
  await page.getByText('Extraction complete', { exact: true }).waitFor()
  await page.getByRole('button', { name: 'Analyze Characters' }).click()
  await page.getByRole('button', { name: 'Start reading' }).click()
  await page.getByRole('button', { name: 'Pause reading' }).click()
  await page.getByRole('button', { name: 'Resume reading' }).click()
  await page.evaluate(() => window.__testUtterance.onerror({ error: 'PRIVATE' }))
  // Errors stop without skipping text. Explicitly retry before testing natural completion.
  await page.getByRole('button', { name: 'Start reading' }).click()
  // Advance all remaining mock utterances to cover natural completion.
  await page.evaluate(() => { for (let i = 0; i < 20; i++) window.__testUtterance.onend() })
  await page.getByRole('button', { name: 'Start reading' }).click()
  await page.getByRole('button', { name: 'Stop reading' }).click()
  await page.locator('input[type=file]').setInputFiles({ name: 'PRIVATE.pdf', mimeType: 'application/pdf', buffer: Buffer.from('PRIVATE invalid pdf') })
  await page.getByRole('alert').waitFor()
  await page.evaluate(() => {
    setTimeout(() => { throw new TypeError('PRIVATE filename.pdf https://private.test/?token=PRIVATE') }, 0)
    void Promise.reject(new Error('PRIVATE selected text Alice Bob credential'))
    window.__nativeGetContext = HTMLCanvasElement.prototype.getContext
    HTMLCanvasElement.prototype.getContext = () => { throw new Error('PRIVATE canvas.pdf') }
  })
  await page.getByLabel('Preview zoom').fill('130')
  await page.getByText('Page rendering failed. Try another page or zoom level.').waitFor()
  await page.evaluate(() => { HTMLCanvasElement.prototype.getContext = window.__nativeGetContext })
  await page.getByLabel('Preview zoom').fill('120')
  await page.waitForFunction(() => !document.querySelector('.page-stage .error-copy') && document.querySelector('canvas')?.width > 0)
  await page.getByText('Diagnostics · private live', { exact: false }).waitFor()
  const visibleStatus = await page.locator('.diagnostics-panel summary').innerText()
  await page.locator('.diagnostics-panel summary').click()
  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Export diagnostics' }).click()
  const download = await downloadPromise
  const stream = await download.createReadStream()
  const chunks = []; for await (const chunk of stream) chunks.push(chunk)
  const exported = JSON.parse(Buffer.concat(chunks).toString())
  const session = exported[0].sessionId
  const expected = ['upload.validated', 'upload.replaced', 'upload.fail', 'extraction.start', 'extraction.progress', 'extraction.complete', 'analysis.start', 'analysis.complete', 'renderer.fail', 'speech.start', 'speech.pause', 'speech.resume', 'speech.stop', 'speech.end', 'speech.error', 'window.error', 'window.rejection']
  const events = await waitEvents(all => expected.every(name => all.some(e => e.sessionId === session && e.event === name)))
  const mine = events.filter(e => e.sessionId === session)
  assert(!JSON.stringify(mine).match(/PRIVATE|filename|selected|Alice|Bob|stack|credential|latte-reader-text-fixture|https:\/\//))
  assert(expected.every(name => exported.some(e => e.event === name)))
  const progressEvents = mine.filter(e => e.event === 'extraction.progress').length
  assert(progressEvents <= 5, `progress stream not coalesced: ${progressEvents} events for a 2-page document`)
  assert(requests.every(r => r.url === `${origin}/__latte_diagnostics/events` && !r.body.includes('PRIVATE')))
  await page.getByRole('button', { name: 'Clear diagnostics' }).click()
  await page.getByText('0/250 in memory', { exact: false }).waitFor()
  const reloadRequestStart = requests.length
  await page.reload()
  await page.getByText('Extraction complete', { exact: true }).waitFor()
  await page.getByText('Diagnostics · private live', { exact: false }).waitFor()
  const restored = requests.slice(reloadRequestStart).flatMap(r => JSON.parse(r.body)).find(e => e.event === 'restore.complete')
  assert(restored, 'Restore telemetry was not delivered')
  page.once('dialog', d => d.accept())
  await page.getByRole('button', { name: 'Delete local data' }).click()
  await page.getByRole('heading', { name: 'Choose a PDF to begin' }).waitFor()
  await waitEvents(all => ['restore.complete', 'delete.start', 'delete.complete'].every(name => all.some(e => e.sessionId === restored.sessionId && e.event === name)))
  // A genuinely failing extraction worker load, not an invented event.
  const workerPage = await browser.newPage()
  await workerPage.route('**/assets/pdf.worker-*.js', r => r.abort())
  await workerPage.goto(base)
  await workerPage.getByRole('heading', { name: 'Choose a PDF to begin' }).waitFor()
  await workerPage.locator('input[type=file]').setInputFiles(fixture)
  await workerPage.getByText('Extraction error', { exact: true }).waitFor()
  await waitEvents(all => all.some(e => e.event === 'extraction.fail'))
  // Default/static production preview: no injected marker and no POST transport.
  production = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--host', '127.0.0.1', '--port', '4187', '--strictPort'], { env: { ...process.env, LATTE_PRIVATE_DIAGNOSTICS: '0' }, stdio: 'pipe' })
  for (let i = 0; i < 50; i++) { try { if ((await fetch('http://127.0.0.1:4187/')).ok) break } catch {} await wait(100) }
  const prod = await browser.newPage()
  const prodPosts = []; prod.on('request', r => { if (r.method() === 'POST') prodPosts.push(r.url()) })
  await prod.goto('http://127.0.0.1:4187/')
  await prod.getByRole('heading', { name: 'Choose a PDF to begin' }).waitFor()
  await prod.locator('input[type=file]').setInputFiles(fixture)
  await prod.getByText('Extraction complete', { exact: true }).waitFor()
  await prod.locator('.diagnostics-panel summary').click()
  assert((await prod.locator('.diagnostics-panel summary').innerText()).includes('local only'))
  assert.equal(await prod.locator('meta[name="latte-private-diagnostics"]').count(), 0)
  assert.equal(prodPosts.length, 0)
  assert(!readFileSync(resolve('dist/index.html'), 'utf8').includes('latte-private-diagnostics'))
  console.log(JSON.stringify({ status: 'passed', log, session, restoredSession: restored.sessionId, visibleStatus, runtimeEvents: mine.length, progressEvents, rejectionsRecorded: rejections.length, eventNames: [...new Set(mine.map(e => e.event))], verified: ['rejected sensitive/unknown ingestion', 'origin guard', 'request size limit', 'server-side rejection diagnostics (status + reason only)', 'progress coalescing', 'exact runtime log readback', 'export privacy', 'clear', 'real invalid PDF', 'real renderer exception', 'actual unhandled error/rejection', 'actual worker load failure', 'static production no telemetry'], speech: 'mock synthesis events only; no audible speech claimed' }, null, 2))
} finally { production?.kill(); await browser.close() }
