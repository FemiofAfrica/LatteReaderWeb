import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { chromium } from 'playwright'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
// The ?url asset is shipped verbatim. Locate PDFDocument.parse in that exact
// dependency, then stop the real execution there using Chromium's debugger.
const source = await readFile(path.join(root, 'node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs'), 'utf8')
const token = 'this.xref.parse('
assert.equal(source.split(token).length, 2, 'Update the parser breakpoint for this PDF.js version')
const before = source.slice(0, source.indexOf(token))
const lineNumber = before.split('\n').length - 1
const columnNumber = before.length - before.lastIndexOf('\n') - 1
const browser = await chromium.launch({ headless: true })
const page = await browser.newPage()
const cdp = await page.context().newCDPSession(page)
const targets = []
const missingMapRealms = []
const compatibility = process.env.LATTE_TEST_NO_MAP === '1'
const parserStops = []
const errors = []
const pending = new Set()
const track = (promise) => {
  pending.add(promise)
  promise.catch((error) => errors.push(error.message)).finally(() => pending.delete(promise))
}

// Use non-flattened CDP sessions so nested workers can be attached recursively.
// Playwright's page worker list/network events do not include child workers.
function endpoint(transport, target = null, parent = null) {
  let nextId = 0
  const replies = new Map()
  const children = new Map()
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId
    replies.set(id, { resolve, reject })
    transport({ id, method, params }).catch(reject)
  })
  const receive = (message) => {
    if (message.id) {
      const reply = replies.get(message.id)
      replies.delete(message.id)
      if (message.error) reply?.reject(new Error(message.error.message))
      else reply?.resolve(message.result)
      return
    }
    if (message.method === 'Target.receivedMessageFromTarget') {
      children.get(message.params.sessionId)?.receive(JSON.parse(message.params.message))
    }
    if (message.method === 'Target.attachedToTarget') {
      const { sessionId, targetInfo } = message.params
      const child = endpoint((payload) => send('Target.sendMessageToTarget', { sessionId, message: JSON.stringify(payload) }), targetInfo, target?.targetId ?? 'page')
      children.set(sessionId, child)
      track(child.initialize())
    }
    if (message.method === 'Debugger.paused') {
      track((async () => {
        if (message.params.hitBreakpoints?.length) {
          const frame = message.params.callFrames[0]
          const result = await send('Debugger.evaluateOnCallFrame', {
            callFrameId: frame.callFrameId,
            expression: '({scope:globalThis.constructor.name,hasWindow:typeof window!=="undefined",hasDocument:typeof document!=="undefined",url:globalThis.location.href})',
            returnByValue: true,
          })
          parserStops.push({ targetId: target.targetId, parent, functionName: frame.functionName, ...result.result.value })
        }
        await send('Debugger.resume')
      })())
    }
  }
  const initialize = async () => {
    await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: false })
    if (target?.type === 'worker') {
      targets.push({ targetId: target.targetId, parent, type: target.type, url: target.url })
      if (compatibility) {
        const removed = await send('Runtime.evaluate', { expression: 'delete Map.prototype.getOrInsertComputed; delete Map.prototype.getOrInsert; typeof Map.prototype.getOrInsertComputed', returnByValue: true })
        assert.equal(removed.result.value, 'undefined')
        missingMapRealms.push(target.targetId)
      }
      await send('Debugger.enable')
      await send('Debugger.setBreakpointByUrl', { urlRegex: 'pdf\\.worker\\.min[^/]*\\.mjs', lineNumber, columnNumber })
    }
    await send('Runtime.runIfWaitingForDebugger')
  }
  return { send, receive, initialize }
}
const rootEndpoint = endpoint(async (payload) => {
  const result = await cdp.send(payload.method, payload.params)
  rootEndpoint.receive({ id: payload.id, result })
})
cdp.on('Target.attachedToTarget', (params) => rootEndpoint.receive({ method: 'Target.attachedToTarget', params }))
cdp.on('Target.receivedMessageFromTarget', (params) => rootEndpoint.receive({ method: 'Target.receivedMessageFromTarget', params }))
await rootEndpoint.initialize()
if (compatibility) await page.addInitScript(() => { delete Map.prototype.getOrInsertComputed; delete Map.prototype.getOrInsert })
const warnings = []
const requests = []
page.on('request', (request) => requests.push(request.url()))
page.on('console', (message) => {
  if (message.text().includes('Setting up fake worker')) warnings.push(message.text())
})
await page.addInitScript(() => {
  window.__pdfAuditMessages = []
  const NativeWorker = window.Worker
  window.Worker = class extends NativeWorker {
    constructor(url, options) {
      super(url, options)
      this.addEventListener('message', (event) => {
        if (['metadata', 'page', 'complete'].includes(event.data?.type)) {
          const { text, ...metadata } = event.data
          window.__pdfAuditMessages.push({ url: String(url), ...metadata })
        }
      })
    }
  }
})
try {
  await page.goto(process.env.LATTE_READER_URL ?? 'http://127.0.0.1:4173/', { waitUntil: 'networkidle' })
  await page.getByRole('heading', { name: 'Choose a PDF to begin' }).waitFor()
  const initialPdfRequests = requests.filter((url) => /pdfjs|\/assets\/(?:pdf[-.]|loadPdf[-.])|\/pdf\/loadPdf/.test(url))
  assert.deepEqual(initialPdfRequests, [], 'PDF code was fetched before a document was opened')
  await page.locator('input[type=file]').setInputFiles(path.join(root, 'tests/fixtures/latte-reader-text-fixture.pdf'))
  await page.getByText('Extraction complete', { exact: true }).waitFor({ timeout: 15000 })
  await page.getByText('LATTEREADER TEST STORY').waitFor()
  if (compatibility) {
    await page.waitForFunction(() => document.querySelector('canvas')?.width > 0)
    await page.getByRole('button', { name: 'Next page' }).click()
    await page.getByText('SECOND PAGE').waitFor()
    await page.getByLabel('Preview zoom').fill('120')
    await page.waitForTimeout(500)
    assert.equal(await page.locator('.page-stage .error-copy').count(), 0)
    assert.equal(missingMapRealms.length, 3)
  }
  await Promise.all([...pending])
  const extractionMessages = await page.evaluate(() => window.__pdfAuditMessages)
  assert.deepEqual(errors, [], 'CDP instrumentation failed')
  assert.equal(warnings.length, 0, 'PDF.js used a fake worker')
  assert.equal(new Set(parserStops.map((stop) => stop.targetId)).size, 2, 'Expected separate preview and extraction parser workers')
  assert.ok(parserStops.every((stop) => stop.scope === 'DedicatedWorkerGlobalScope' && !stop.hasWindow && !stop.hasDocument), 'PDF parsing reached the UI main thread')
  const extractionTarget = targets.find((target) => !target.url.includes('pdf.worker.min'))
  assert.ok(extractionTarget, 'Extraction controller worker was not observed')
  assert.ok(parserStops.some((stop) => stop.parent === extractionTarget.targetId), 'No parser ran inside the extraction controller child worker')
  assert.ok(parserStops.some((stop) => stop.parent !== extractionTarget.targetId), 'Preview parser worker was not observed')
  assert.deepEqual(extractionMessages.filter((event) => event.type === 'page').map((event) => event.pageNumber), [1, 2])
  assert.equal(extractionMessages.find((event) => event.type === 'complete')?.characterCount, 365)
  console.log(JSON.stringify({ status: 'passed', compatibility, missingMapRealms, canvas: await page.locator('canvas').evaluate(c => ({ width: c.width, height: c.height })), initialPdfRequests, targets, parserStops, extractionMessages, fakeWorkerWarnings: warnings }, null, 2))
} catch (error) {
  console.error(JSON.stringify({ status: 'failed', error: error.message, targets, parserStops, fakeWorkerWarnings: warnings }, null, 2))
  throw error
} finally {
  await browser.close()
}
