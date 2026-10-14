import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { mkdir, writeFile } from 'node:fs/promises'
const url = process.env.LATTE_READER_URL ?? 'http://127.0.0.1:4194/'
const artifacts = 'tests/artifacts/readability-accessibility'
await mkdir(artifacts, { recursive: true })
function pdf(pages) {
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', `<< /Type /Pages /Kids [${pages.map((_, i) => `${4 + 2 * i} 0 R`).join(' ')}] /Count ${pages.length} >>`, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>']
  for (const text of pages) {
    const stream = text === null ? 'q 100 0 0 100 50 600 cm BI /W 1 /H 1 /BPC 8 /CS /RGB /F /AHx ID FF0000> EI Q' : text ? `BT /F1 12 Tf 50 750 Td (${text}) Tj ET` : ''
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${objects.length + 2} 0 R >>`, `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`)
  }
  let out = '%PDF-1.4\n', offsets = [0]
  for (let i = 0; i < objects.length; i++) { offsets.push(out.length); out += `${i + 1} 0 obj\n${objects[i]}\nendobj\n` }
  const start = out.length
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` + offsets.slice(1).map(o => String(o).padStart(10, '0') + ' 00000 n \n').join('') + `trailer << /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF`
  return Buffer.from(out)
}
const browser = await chromium.launch()
const evidence = []
try {
  for (const [name, pages, readable] of [['short', ['Hi.'], 1], ['blank', [''], 0], ['whitespace', ['   '], 0], ['nul', ['\u0000'], 0], ['image', [null], 0], ['mixed', ['Hi.', null, '', 'End.'], 2]]) {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
    await page.addInitScript(() => {
      window.__complete = null; window.__inputs = []; window.__current = null
      const W = window.Worker
      window.Worker = class extends W { constructor(...args) { super(...args); this.addEventListener('message', e => { if (e.data.type === 'complete') window.__complete = e.data }) } }
      Object.defineProperty(window, 'SpeechSynthesisUtterance', { value: class { constructor(text) { this.text = text } } })
      Object.defineProperty(window, 'speechSynthesis', { value: { getVoices: () => [], cancel() {}, pause() {}, resume() {}, speak(u) { window.__current = u; window.__inputs.push(u.text); u.onstart?.() } } })
    })
    await page.goto(url)
    await page.locator('input[type=file]').setInputFiles({ name: `${name}.pdf`, mimeType: 'application/pdf', buffer: pdf(pages) })
    await page.waitForFunction(() => window.__complete)
    const complete = await page.evaluate(() => window.__complete)
    assert.equal(complete.pagesWithReadableText, readable)
    assert.equal(complete.pagesWithoutReadableText, pages.length - readable)
    assert.equal(Object.hasOwn(complete, 'scanned'), false)
    assert.equal(await page.getByRole('button', { name: 'Start reading' }).isDisabled(), !readable)
    if (!readable) assert.match(await page.locator('.preview-scroll .warning-copy').innerText(), /may be an image-only/)
    if (readable && pages.length > readable) assert.match(await page.locator('.preview-scroll .warning-copy').innerText(), /2 pages have no readable text/)
    evidence.push({ name, complete })
    if (readable) {
      const status = page.locator('.mobile-reading-status')
      assert.equal(await status.innerText(), 'Ready')
      await page.getByRole('button', { name: 'Start reading' }).click(); await status.filter({ hasText: /^Reading$/ }).waitFor()
      await page.getByRole('button', { name: 'Pause reading' }).click(); assert.equal(await status.innerText(), 'Paused')
      await page.getByRole('button', { name: 'Stop reading' }).click(); assert.equal(await status.innerText(), 'Stopped')
      const before = await page.evaluate(() => window.__inputs.length)
      await page.getByRole('slider', { name: 'Reading progress', exact: true }).focus()
      await page.keyboard.press('ArrowRight')
      assert.equal(await page.evaluate(() => window.__inputs.length), before, 'stopped seek is silent')
      assert.equal(await status.innerText(), 'Stopped')
      await page.reload(); await page.waitForFunction(() => window.__complete)
      assert.equal(await status.innerText(), 'Ready'); assert.equal(await page.evaluate(() => window.__inputs.length), 0)
      await page.getByRole('button', { name: 'Start reading' }).click()
      await page.evaluate(() => window.__current.onend()); await status.filter({ hasText: /^Finished$/ }).waitFor()
      await page.getByRole('button', { name: 'Start reading' }).click()
      await page.evaluate(() => window.__current.onerror({ error: 'synthesis-failed' })); await status.filter({ hasText: /^Voice unavailable$/ }).waitFor()
      evidence.push({ name, transitions: ['Ready', 'Reading', 'Paused', 'Stopped', 'Ready after reload (silent)', 'Finished', 'Voice unavailable'], before })
    }
    if (name === 'short') {
      for (const [width, height] of [[320, 844], [390, 844], [504, 844], [960, 540], [640, 400]]) {
        await page.setViewportSize({ width, height }); await page.waitForTimeout(200)
        const measurements = await page.evaluate(() => {
          const selectors = ['.reading-progress input', '.page-text-disclosure summary', '.diagnostics-panel summary', '.read-along-toggle']
          const targets = selectors.map(selector => { const e = document.querySelector(selector), r = e.getBoundingClientRect(); return { selector, width: r.width, height: r.height } })
          const header = document.querySelector('.preview-header').getBoundingClientRect(), bar = document.querySelector('.mobile-bar').getBoundingClientRect()
          return { targets, overflow: document.documentElement.scrollWidth - innerWidth, availablePageHeight: bar.top - header.bottom }
        })
        assert.equal(measurements.overflow, 0); assert.ok(measurements.availablePageHeight > 30, JSON.stringify(measurements))
        for (const target of measurements.targets) assert.ok(target.height >= 44, JSON.stringify(target))
        await page.keyboard.press('Tab')
        await page.locator('.page-text-disclosure summary').focus()
        assert.equal(await page.locator('.page-text-disclosure summary').evaluate(e => getComputedStyle(e).outlineStyle), 'solid')
        const tab = page.getByRole('tab', { name: 'Read', exact: true })
        await tab.focus(); await page.keyboard.press('ArrowRight'); assert.equal(await page.getByRole('tab', { name: 'Voices', exact: true }).getAttribute('aria-selected'), 'true')
        await page.keyboard.press('Home'); assert.equal(await page.getByRole('tab', { name: 'Document', exact: true }).getAttribute('aria-selected'), 'true')
        await page.keyboard.press('ArrowRight')
        const session = await page.context().newCDPSession(page)
        const tree = await session.send('Accessibility.getFullAXTree')
        assert.ok(tree.nodes.some(n => n.role?.value === 'tab' && n.name?.value === 'Read'))
        assert.ok(tree.nodes.some(n => n.role?.value === 'button' && n.name?.value === 'Start reading'))
        await session.detach()
        await page.screenshot({ path: `${artifacts}/reader-${width}-${height}.png`, fullPage: true })
        evidence.push({ width, height, ...measurements })
      }
    }
    await page.close()
  }
  // Desktop OS/browser scaling can enter the compact layout via CSS height alone.
  for (const [width, height] of [[1366, 550], [1440, 590], [1440, 900]]) {
    const page = await browser.newPage({ viewport: { width, height } })
    await page.goto(url)
    await page.locator('input[type=file]').setInputFiles({ name: 'layout.pdf', mimeType: 'application/pdf', buffer: pdf(['Hi.']) })
    await page.waitForFunction(() => document.body.textContent.includes('Extraction complete'))
    const layout = await page.evaluate(() => ({
      cssWidth: innerWidth, cssHeight: innerHeight,
      compactQuery: matchMedia('(max-width: 780px), (max-height: 600px)').matches,
      mobileTabs: !!document.querySelector('.mobile-tabs'),
      desktopTransport: !!document.querySelector('.transport'),
      knobsInHeader: !!document.querySelector('.preview-header .rotary-rack'),
      knobsInTransport: !!document.querySelector('.transport .rotary-rack'),
      overflow: document.documentElement.scrollWidth - innerWidth,
    }))
    assert.equal(layout.compactQuery, height <= 600)
    assert.equal(layout.mobileTabs, height <= 600)
    assert.equal(layout.desktopTransport, height > 600)
    assert.equal(layout.overflow, 0)
    await page.screenshot({ path: `${artifacts}/desktop-height-${width}-${height}.png` })
    evidence.push({ layout }); await page.close()
  }
  // Distinguish startup, runtime and malformed protocol failures without showing raw text.
  for (const fault of ['startup', 'runtime', 'protocol']) {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
    await page.addInitScript(fault => {
      const W = window.Worker
      window.Worker = class extends W {
        constructor(...args) {
          if (String(args[0]).includes('/assets/pdf.worker-') && fault === 'startup') throw new Error('PRIVATE raw message')
          super(...args); this.extraction = String(args[0]).includes('/assets/pdf.worker-')
        }
        postMessage(...args) {
          if (!this.extraction) return super.postMessage(...args)
          setTimeout(() => fault === 'runtime' ? this.onerror?.(new ErrorEvent('error', { message: 'PRIVATE raw message' })) : this.onmessage?.({ data: { type: 'error', errorCode: 'PRIVATE raw message' } }), 0)
        }
      }
    }, fault)
    await page.goto(url); await page.locator('input[type=file]').setInputFiles({ name: 'fault.pdf', mimeType: 'application/pdf', buffer: pdf(['Hi.']) })
    await page.locator('.mobile-reading-status').filter({ hasText: 'Text extraction error' }).waitFor()
    const copy = await page.locator('.preview-scroll .error-copy').innerText()
    assert.doesNotMatch(copy, /PRIVATE/); evidence.push({ fault, copy }); await page.close()
  }
  await writeFile(`${artifacts}/evidence.json`, JSON.stringify(evidence, null, 2))
  console.log(JSON.stringify(evidence, null, 2))
} finally { await browser.close() }
