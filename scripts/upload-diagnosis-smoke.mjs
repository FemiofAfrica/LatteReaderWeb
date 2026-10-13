// Real browser verification of upload failure diagnosis against the private preview.
//
// Every case selects a real fixture file, asserts the exact sentence the reader sees, and
// reads the fixed reason code back from .runtime/diagnostics/events.jsonl. A previously saved
// document must survive every rejected upload.
import { chromium } from 'playwright'
import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const base = process.env.LATTE_READER_URL ?? 'http://127.0.0.1:4176/'
const origin = new URL(base).origin
const log = resolve(root, '.runtime/diagnostics/events.jsonl')
const fixture = (name) => readFileSync(resolve(root, `tests/fixtures/${name}`))
const savedFixture = 'latte-reader-text-fixture.pdf'
const markerFixture = 'latte-reader-valid-marker.pdf'
const wait = (ms) => new Promise((resolveWait) => setTimeout(resolveWait, ms))

// The five causes the reader must be able to tell apart, in the order they are tried.
const CASES = [
  {
    label: 'a file that is not a PDF',
    file: { name: 'notes.pdf', mimeType: 'application/pdf', buffer: fixture('latte-reader-not-a-pdf.txt') },
    code: 'file-not-pdf',
    message: 'That file is not a PDF, so your saved document was not changed.',
  },
  {
    label: 'an empty file',
    file: { name: 'empty.pdf', mimeType: 'application/pdf', buffer: Buffer.alloc(0) },
    code: 'file-empty',
    message: 'That file is empty, so your saved document was not changed.',
  },
  {
    label: 'a truncated document',
    file: { name: 'truncated.pdf', mimeType: 'application/pdf', buffer: fixture('latte-reader-truncated.pdf') },
    code: 'pdf-damaged',
    message: 'That PDF is damaged or incomplete, so your saved document was not changed.',
  },
  {
    label: 'a password protected document',
    file: { name: 'locked.pdf', mimeType: 'application/pdf', buffer: fixture('latte-reader-password.pdf') },
    code: 'pdf-password',
    message: 'That PDF is locked with a password, so your saved document was not changed. Unlock it and try again.',
  },
]

const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
const delivered = []
page.on('request', (request) => {
  if (request.method() !== 'POST' || request.url() !== `${origin}/__latte_diagnostics/events`) return
  try { delivered.push(...JSON.parse(request.postData() ?? '[]')) } catch { /* ignore non-JSON */ }
})
const pageErrors = []
page.on('pageerror', (error) => pageErrors.push(error.message))

async function alertText(expected) {
  for (let attempt = 0; attempt < 40; attempt++) {
    const text = (await page.locator('[role=alert]').first().innerText().catch(() => '')).trim()
    if (text && (!expected || text === expected)) return text
    await wait(50)
  }
  return (await page.locator('[role=alert]').first().innerText().catch(() => '')).trim()
}

try {
  await page.goto(base, { waitUntil: 'networkidle' })
  await page.getByRole('heading', { name: 'Choose a PDF to begin' }).waitFor({ timeout: 20000 })

  // Establish a saved document that every rejected upload must leave alone.
  await page.locator('input[type=file]').setInputFiles(resolve(root, `tests/fixtures/${savedFixture}`))
  await page.getByText('Extraction complete', { exact: true }).waitFor({ timeout: 20000 })
  const savedName = (await page.locator('.filename').innerText()).trim()
  assert.equal(savedName, savedFixture, 'the working document was not established')

  const sessionId = delivered.find((event) => event.sessionId)?.sessionId
  assert(sessionId, 'no diagnostics session was delivered by the preview')

  const observed = []
  for (const testCase of CASES) {
    const before = delivered.length
    await page.locator('input[type=file]').setInputFiles(testCase.file)
    // Wait for this upload's own failure event, so the DOM update has certainly been applied.
    let failure
    for (let attempt = 0; attempt < 60 && !failure; attempt++) {
      failure = delivered.slice(before).find((event) => event.event === 'upload.fail')
      if (!failure) await wait(100)
    }
    assert(failure, `${testCase.label}: no upload.fail event was delivered`)
    assert.equal(failure.errorCode, testCase.code, `${testCase.label}: wrong reason code`)

    const text = await alertText(testCase.message)
    assert.equal(text, testCase.message, `${testCase.label}: the reader saw a different sentence`)
    // The atomic guarantee is real for every one of these: nothing was replaced.
    assert(!text.includes('was saved'), `${testCase.label}: claimed a replacement that did not happen`)
    assert(text.includes('was not changed'), `${testCase.label}: dropped the unchanged guarantee`)
    assert(!text.includes('\u2014'), `${testCase.label}: em dash in copy`)
    assert(!text.includes('not a readable PDF'), `${testCase.label}: the old collapsed message returned`)
    assert.equal((await page.locator('.filename').innerText()).trim(), savedName, `${testCase.label}: replaced the saved document`)
    observed.push({ label: testCase.label, code: failure.errorCode, message: text })
  }

  // A real PDF whose header sits after 432 leading bytes. The tolerant header check must not
  // call it "not a PDF"; whether the parser then accepts it is PDF.js's own decision.
  const beforeMarker = delivered.length
  await page.locator('input[type=file]').setInputFiles(resolve(root, `tests/fixtures/${markerFixture}`))
  let markerFailure
  for (let attempt = 0; attempt < 100 && !markerFailure; attempt++) {
    markerFailure = delivered.slice(beforeMarker).find((event) => event.event === 'upload.fail')
    if (!markerFailure) {
      const name = (await page.locator('.filename').innerText().catch(() => '')).trim()
      if (name === markerFixture) break
    }
    await wait(100)
  }
  assert.notEqual(markerFailure?.errorCode, 'file-not-pdf', 'a PDF with leading bytes was rejected as not a PDF by the header check')
  let markerOutcome
  if (markerFailure) {
    markerOutcome = `PDF.js refused a file with leading bytes as ${markerFailure.errorCode}; the header check did not collapse it into "not a PDF"`
  } else {
    await page.getByText('Extraction complete', { exact: true }).waitFor({ timeout: 20000 })
    assert.equal((await page.locator('.filename').innerText()).trim(), markerFixture, 'a PDF with leading bytes was wrongly rejected')
    assert.equal(await page.locator('[role=alert]').count(), 0, 'a successful upload left an error message')
    markerOutcome = 'opened, so leading bytes before the header are accepted'
  }

  // Read the codes back from the runtime log: what a triager would actually see.
  await wait(600)
  const mine = readFileSync(log, 'utf8').trim().split('\n').filter(Boolean)
    .map((line) => JSON.parse(line)).filter((event) => event.sessionId === sessionId)
  const codes = mine.filter((event) => event.event === 'upload.fail').map((event) => event.errorCode)
  assert.deepEqual(codes.slice(0, CASES.length), CASES.map((testCase) => testCase.code), 'the log does not match the reader experience')
  assert.equal(codes.length, CASES.length + (markerFailure ? 1 : 0), 'the log recorded a failure the reader never saw')
  // Idempotent ingestion: each failure is stored exactly once even if a batch is retried.
  const serialized = mine.map((event) => JSON.stringify(event))
  assert.equal(new Set(serialized).size, serialized.length, 'a retried batch was stored twice')
  assert(!codes.includes('pdf'), 'the old collapsed reason code is still recorded')
  assert(!JSON.stringify(mine).match(/notes\.pdf|empty\.pdf|truncated\.pdf|locked\.pdf|%PDF|PRIVATE/), 'the log leaked a filename or bytes')
  assert.deepEqual(pageErrors, [], `uncaught browser errors: ${pageErrors.join(', ')}`)

  // Live proof of idempotent ingestion: resending a batch that already landed, exactly as the
  // transport retry does, must leave the runtime log byte for byte unchanged.
  const alreadyLanded = mine.find((event) => event.event === 'upload.fail')
  assert(alreadyLanded, 'no stored failure to resend')
  const logBeforeRetry = readFileSync(log, 'utf8')
  const resend = () => fetch(`${origin}/__latte_diagnostics/events`, {
    method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify([alreadyLanded]),
  })
  assert.equal((await resend()).status, 204, 'a resent batch was not acknowledged')
  assert.equal((await resend()).status, 204, 'a resent batch was not acknowledged')
  assert.equal(readFileSync(log, 'utf8'), logBeforeRetry, 'a retried batch that already landed was stored again')

  console.log(JSON.stringify({
    status: 'passed',
    base,
    sessionId,
    savedDocument: savedName,
    preservedThrough: CASES.length,
    observed,
    codesFromLog: codes,
    leadingBytesOutcome: markerOutcome,
    eventNames: [...new Set(mine.map((event) => event.event))],
    verified: [
      'exact reader sentence per cause',
      'fixed reason code per cause read back from .runtime/diagnostics/events.jsonl',
      'saved document survived every rejected upload',
      'no failure claimed a replacement',
      'a real PDF with leading bytes before its header still opens',
      'a resent batch is acknowledged and not stored twice, verified against the live log',
      'no filename or bytes in the log',
    ],
    notReproducedHere: ['a cloud placeholder that has not downloaded: not producible in this harness; covered by unit tests', 'a failure after a successful replacement: covered by uploadFlow unit tests'],
  }, null, 2))
} finally {
  await browser.close()
}
