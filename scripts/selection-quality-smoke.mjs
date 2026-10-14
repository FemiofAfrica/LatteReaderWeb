import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { mkdir, writeFile } from 'node:fs/promises'
const browser = await chromium.launch()
const evidence = []
const url = process.env.LATTE_READER_URL ?? 'http://127.0.0.1:4198/'
await mkdir('tests/artifacts/selection', { recursive: true })
for (const width of [390, 1440]) {
  const p = await browser.newPage({ viewport: { width, height: 900 }, hasTouch: width < 781, isMobile: width < 781 })
  await p.addInitScript(() => {
    window.__speech = { inputs: [], current: null, old: null, cancels: 0 }
    Object.defineProperty(window, 'SpeechSynthesisUtterance', { value: class { constructor(text) { this.text = text } } })
    Object.defineProperty(window, 'speechSynthesis', { value: {
      getVoices: () => [], pause() {}, resume() {}, cancel() { __speech.cancels++ },
      speak(u) { __speech.old = __speech.current; __speech.current = u; __speech.inputs.push(u.text); u.onstart?.() },
    } })
  })
  await p.goto(url)
  await p.locator('input[type=file]').setInputFiles('tests/fixtures/selection-quality.pdf')
  await p.waitForFunction(() => document.body.textContent.includes('Extraction complete'))
  await p.getByRole('button', { name: 'Next page', exact: true }).click()
  await p.getByRole('button', { name: 'Read-along text', exact: true }).click()
  const text = await p.locator('.read-along-text').textContent()
  assert(text.includes("don’t I'm we're. John' s l’ amour don ' t."))
  const repeated = text.indexOf('Same fine sentence.', text.indexOf('Same fine sentence.') + 1)
  const select = async (start, end, selector = '.read-along-text') => {
    await p.locator(selector).evaluate((el, { start, end }) => {
      const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT), range = document.createRange()
      let node, offset = 0, began = false
      while (node = walk.nextNode()) {
        const next = offset + node.textContent.length
        if (!began && start < next) { range.setStart(node, start - offset); began = true }
        const done = began && end <= next
        offset = next
        if (done) { range.setEnd(node, end - (offset - node.textContent.length)); break }
      }
      const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range)
      document.dispatchEvent(new Event('selectionchange'))
    }, { start, end })
  }
  const actions = p.locator('.preview-scroll > .selection-actions')
  const measure = async () => actions.evaluate(row => {
    const buttons = [...row.querySelectorAll('button')]
    return { disabled: buttons.map(b => b.disabled),
      boxes: buttons.map(b => { const r = b.getBoundingClientRect()
        return { name: b.textContent, top: r.top, bottom: r.bottom, left: r.left, right: r.right, height: r.height, width: r.width } }),
      viewport: window.innerWidth,
      documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth }
  })
  const layout = await measure()
  assert.deepEqual(layout.disabled, [true, true], 'actions are inert before any selection')
  assert(layout.boxes.every(b => b.height >= 44 && b.width > 80), 'touch target')
  assert.equal(layout.documentOverflow, 0, 'no horizontal overflow')
  assert(layout.boxes.every(b => b.left >= 0 && b.right <= layout.viewport + 1), 'actions stay inside the viewport')
  const [left, right] = layout.boxes
  const overlaps = left.left < right.right && right.left < left.right && left.top < right.bottom && right.top < left.bottom
  assert.equal(overlaps, false, 'the two actions never overlap')
  await select(repeated, repeated + 19)
  assert.deepEqual((await measure()).disabled, [false, false])
  await actions.getByRole('button', { name: 'Read selection only', exact: true }).click()
  assert.equal(await p.evaluate(() => __speech.current.text), 'Same fine sentence.')
  await p.evaluate(() => __speech.current.onboundary({ charIndex: 0 }))
  await p.locator('mark').waitFor()
  const onlyMark = await p.locator('mark').evaluate(el => ({ start: +el.dataset.sourceStart, end: +el.dataset.sourceEnd, text: el.textContent }))
  assert.equal(onlyMark.start, repeated); assert.equal(onlyMark.text, 'Same fine sentence.')
  await p.getByRole('button', { name: 'Stop reading' }).click()
  // Select across DOM nodes that were split by a real highlight, then explicitly continue.
  await select(repeated, repeated + 19)
  await actions.getByRole('button', { name: 'Read from selection', exact: true }).click()
  const first = await p.evaluate(() => __speech.current.text)
  assert(first.startsWith("Same fine sentence. don’t I'm we're.")); assert(!first.includes('Earlier page.'))
  await p.getByRole('button', { name: 'Pause reading' }).click()
  const count = await p.evaluate(() => __speech.inputs.length)
  const slider = p.getByRole('slider', { name: 'Reading progress' })
  await slider.fill('30'); await slider.dispatchEvent('keyup', { key: 'ArrowRight' })
  assert.equal(await p.evaluate(() => __speech.inputs.length), count)
  await p.getByRole('button', { name: 'Resume reading' }).click()
  assert.equal(await p.evaluate(() => __speech.inputs.length), count + 1)
  await p.getByRole('button', { name: 'Stop reading' }).click()
  await p.evaluate(() => { __speech.inputs = [] })
  await select(repeated, repeated + 19)
  await actions.getByRole('button', { name: 'Read from selection', exact: true }).click()
  for (let i = 0; i < 20; i++) {
    if (await p.getByRole('button', { name: 'Start reading' }).count()) break
    await p.evaluate(() => __speech.current.onend?.())
    await p.waitForTimeout(30)
  }
  const continuation = await p.evaluate(() => __speech.inputs)
  assert(continuation.every(t => t.length <= 1200)); assert(continuation.at(-1).endsWith('Final page. End of document.'))
  assert.equal(await p.locator('.preview-header input[type=number]').first().inputValue(), '3')
  await p.getByRole('button', { name: 'Previous page', exact: true }).click()
  await select(0, text.length)
  await p.evaluate(() => { __speech.inputs = [] })
  await actions.getByRole('button', { name: 'Read selection only', exact: true }).click()
  for (let i = 0; i < 20; i++) {
    if (await p.getByRole('button', { name: 'Start reading' }).count()) break
    await p.evaluate(() => __speech.current.onend?.()); await p.waitForTimeout(30)
  }
  const longOnly = await p.evaluate(() => __speech.inputs)
  assert(longOnly.length > 1); assert(longOnly.every(t => t.length <= 1200)); assert(!longOnly.join(' ').includes('Final page.'))
  await p.screenshot({ path: `tests/artifacts/selection/selection-${width}.png` })
  evidence.push({ width, repeatedSourceOffset: repeated, onlyMark, layout, continuation, longOnlyLengths: longOnly.map(t => t.length) })
  await p.close()
}
await browser.close()
await writeFile('tests/artifacts/selection/proof.json', JSON.stringify(evidence, null, 2))
console.log(JSON.stringify(evidence.map(({ width, repeatedSourceOffset, onlyMark, layout, longOnlyLengths, continuation }) =>
  ({ width, repeatedSourceOffset, onlyMark, actionRow: layout.boxes.map(b => ({ name: b.name, height: b.height })),
    continuationChunks: continuation.length, lastInputTail: continuation.at(-1).slice(-24), longOnlyLengths })), null, 2))
