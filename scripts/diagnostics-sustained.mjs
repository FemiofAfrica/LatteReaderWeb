// Sustained real session against the live private preview: a 341-page extraction must land
// continuously (no mid-extraction stop), the progress stream must stay coalesced, and the
// status strip must read a truthful state (never a permanent failure after a success).
import { chromium } from 'playwright'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import assert from 'node:assert/strict'

const PAGE_COUNT = 341
const base = process.env.LATTE_READER_URL ?? 'http://127.0.0.1:4176/'
const origin = new URL(base).origin
const log = resolve(process.env.LATTE_DIAGNOSTICS_DIR || '.runtime/diagnostics', 'events.jsonl')

function buildPdf(count) {
  const fontObj = 3 + count * 2
  const kids = []
  const bodies = []
  for (let i = 0; i < count; i++) {
    const pageNum = 3 + i * 2
    const contentNum = pageNum + 1
    kids.push(`${pageNum} 0 R`)
    const lines = [`LATTEREADER BIG DOC PAGE ${i + 1}`, 'ALICE: reading page text here for extraction.', 'BOB: another line for extraction coverage.']
    const cmds = ['BT', '/F1 16 Tf', '72 720 Td']
    lines.forEach((line, li) => { if (li) cmds.push('0 -32 Td'); cmds.push(`(${line.replace(/[()\\]/g, m => '\\' + m)}) Tj`) })
    cmds.push('ET')
    const stream = Buffer.from(cmds.join('\n'), 'ascii')
    bodies.push([pageNum, Buffer.from(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontObj} 0 R >> >> /Contents ${contentNum} 0 R >>`)])
    bodies.push([contentNum, Buffer.concat([Buffer.from(`<< /Length ${stream.length} >>\nstream\n`), stream, Buffer.from('\nendstream')])])
  }
  const objects = [
    Buffer.from('<< /Type /Catalog /Pages 2 0 R >>'),
    Buffer.from(`<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${count} >>`),
  ]
  bodies.forEach(([, body]) => objects.push(body))
  objects.push(Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'))
  const pdf = [Buffer.from('%PDF-1.4\n')]
  const offsets = [0]
  let length = pdf[0].length
  objects.forEach((body, index) => {
    offsets.push(length)
    const head = Buffer.from(`${index + 1} 0 obj\n`)
    const tail = Buffer.from('\nendobj\n')
    pdf.push(head, body, tail)
    length += head.length + body.length + tail.length
  })
  const xref = length
  const parts = [Buffer.from(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`)]
  offsets.slice(1).forEach(offset => parts.push(Buffer.from(`${offset.toString().padStart(10, '0')} 00000 n \n`)))
  parts.push(Buffer.from(`trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`))
  return Buffer.concat([...pdf, ...parts])
}

mkdirSync(resolve('.runtime'), { recursive: true })
const fixture = resolve('.runtime/sustained-341.pdf')
writeFileSync(fixture, buildPdf(PAGE_COUNT))

const browser = await chromium.launch({ headless: true })
const page = await browser.newPage()
// Slow the page so a 341-page extraction runs long enough to exercise interval coalescing.
const throttle = Number(process.env.SUSTAINED_CPU_THROTTLE ?? '6')
if (throttle > 1) {
  const client = await page.context().newCDPSession(page)
  await client.send('Emulation.setCPUThrottlingRate', { rate: throttle })
}
const posts = []
page.on('request', r => { if (r.method() === 'POST') posts.push(r.url()) })
page.on('requestfailed', r => { if (r.method() === 'POST') posts.push('FAILED:' + (r.failure()?.errorText ?? 'unknown')) })
const timeline = []
let last = ''
const sample = async () => { const text = await page.locator('.diagnostics-controls p').nth(1).textContent().catch(() => ''); if (text && text !== last) { timeline.push(text); last = text } }
try {
  await page.goto(base)
  await page.locator('.diagnostics-panel summary').click()
  await page.getByRole('heading', { name: 'Choose a PDF to begin' }).waitFor({ timeout: 15000 })
  await page.locator('input[type=file]').setInputFiles(fixture)
  const started = Date.now()
  let complete = false
  while (Date.now() - started < 90000) {
    await sample()
    if (!complete && await page.getByText('Ready to read', { exact: true }).count()) complete = true
    if (complete && Date.now() - started > 30000) break
    await page.waitForTimeout(100)
  }
  await sample()
  assert(complete, 'Extraction did not complete')
  const finalStatus = await page.locator('.diagnostics-controls p').nth(1).textContent()
  assert(finalStatus.includes('Reports are shared for this private test.'), `Strip did not read live after a successful extraction: ${finalStatus}`)

  const rows = readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  // This smoke always uploads the fixture it just built, so its session has an upload.replaced
  // with the same page count. A live tester session that restored an equally large document
  // would otherwise be picked as "the last" one and hide this run's own lifecycle events.
  const uploaded = new Set(rows.filter(r => r.event === 'upload.replaced' && r.count === PAGE_COUNT && r.sessionId).map(r => r.sessionId))
  const session = rows.filter(r => r.event === 'extraction.start' && r.count === PAGE_COUNT && r.sessionId && uploaded.has(r.sessionId)).map(r => r.sessionId).at(-1)
  assert(session, 'No 341-page upload and extraction.start recorded')
  const mine = rows.filter(r => r.sessionId === session)
  const pages = mine.filter(r => r.event === 'extraction.progress').map(r => r.page)
  assert(mine.some(r => r.event === 'extraction.start' && r.count === PAGE_COUNT), 'extraction.start missing')
  assert(mine.some(r => r.event === 'extraction.complete'), 'extraction.complete missing')
  assert(pages.includes(1), 'First page never reached the log')
  assert(pages.includes(PAGE_COUNT), 'Final page never reached the log')
  for (let i = 1; i < pages.length; i++) assert(pages[i] > pages[i - 1], `Progress not strictly increasing at ${i}`)
  assert(pages.length >= 8, `Coalescing emitted too few samples for continuity: ${pages.length}`)
  assert(pages.length <= 60, `Progress stream flooded retention: ${pages.length} progress events`)
  console.log(JSON.stringify({
    status: 'passed', pageCount: PAGE_COUNT, session: session.slice(0, 8), cpuThrottle: throttle,
    evidence: {
      statusTimeline: timeline,
      finalStatus,
      progressEventsRetained: pages.length,
      progressSpan: [pages[0], pages.at(-1)],
      progressStrictlyIncreasing: true,
      lifecycle: mine.filter(r => r.event !== 'extraction.progress').map(r => r.event),
      posts: posts.length,
      postFailures: posts.filter(p => String(p).startsWith('FAILED')),
    },
  }, null, 2))
} finally {
  await browser.close()
}
