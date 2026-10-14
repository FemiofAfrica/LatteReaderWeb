import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { mkdir, writeFile } from 'node:fs/promises'
const url = process.env.LATTE_READER_URL ?? 'http://127.0.0.1:4194/'
const dir = 'tests/artifacts/spoken-position'
await mkdir(dir, { recursive: true })
const browser = await chromium.launch()
const evidence = []
const open = async (width, height, touch = false) => {
  const page = await browser.newPage({ viewport: { width, height }, hasTouch: touch, isMobile: touch })
  await page.addInitScript(() => {
    window.__speech = { inputs: [], cancels: 0, current: null, old: null }
    Object.defineProperty(window, 'SpeechSynthesisUtterance', { value: class { constructor(text) { this.text = text } } })
    Object.defineProperty(window, 'speechSynthesis', { value: {
      getVoices: () => [], cancel() { window.__speech.cancels++ }, pause() {}, resume() {},
      speak(u) { const s = window.__speech; s.old = s.current; s.current = u; s.inputs.push(u.text); u.onstart?.() },
    } })
  })
  await page.goto(url)
  await page.locator('input[type=file]').setInputFiles('tests/fixtures/spoken-position.pdf')
  await page.waitForFunction(() => document.body.textContent.includes('Ready to read'))
  await page.locator('canvas').waitFor()
  await page.waitForTimeout(150)
  return page
}
const actualPage = p => p.locator('.preview-header input[type=number]').first().inputValue()
const counts = p => p.evaluate(() => ({ starts: __speech.inputs.length, cancels: __speech.cancels }))
const boundary = (p, offset) => p.evaluate(offset => __speech.current.onboundary({ charIndex: offset }), offset)
const markProof = async p => {
  await p.locator('.read-along-text mark').first().waitFor()
  const proof = await p.locator('.read-along-text').evaluate(el => {
    const text = el.textContent, marks = [...el.querySelectorAll('mark')]
    return marks.map(mark => ({ start: +mark.dataset.sourceStart, end: +mark.dataset.sourceEnd, text: mark.textContent, source: text.slice(+mark.dataset.sourceStart, +mark.dataset.sourceEnd), state: mark.dataset.state }))
  })
  assert(proof.length)
  assert(proof.every(m => m.text === m.source))
  return proof
}
for (const width of [390, 1440]) {
  const p = await open(width, 900, width < 781)
  assert.equal(await p.locator('.viewer-page-arrow').count(), 0)
  assert.equal(await p.getByRole('button', { name: 'Next page', exact: true }).count(), 1)
  if (width > 780) {
    const next = p.getByRole('button', { name: 'Next PDF page', exact: true })
    await p.mouse.move(5, 5)
    assert.equal(await next.evaluate(el => getComputedStyle(el).opacity), '0')
    await p.locator('canvas').hover({ position: { x: 20, y: 20 } })
    assert.equal(await next.evaluate(el => getComputedStyle(el).opacity), '0.75')
    await p.screenshot({ path: `${dir}/canvas-hover-${width}.png` })
    await p.mouse.move(5, 5); await next.focus()
    assert.equal(await next.evaluate(el => getComputedStyle(el).opacity), '0.75')
    const edge = await next.boundingBox(), canvas = await p.locator('canvas').boundingBox()
    assert(Math.abs(edge.x + edge.width - canvas.x - canvas.width) < 1)
    assert.equal(edge.width, 24); assert.equal(edge.height, 48)
    await p.screenshot({ path: `${dir}/canvas-focus-${width}.png` })
    await p.getByRole('button', { name: 'Start reading' }).click()
    const before = await counts(p)
    await next.focus(); await next.press('Enter')
    assert.equal(await actualPage(p), '2'); assert.deepEqual(await counts(p), before)
    await p.getByRole('button', { name: 'Follow reading' }).click()
    assert.equal(await actualPage(p), '1'); assert.deepEqual(await counts(p), before)
    await p.getByRole('button', { name: 'Stop reading' }).click()
  } else {
    assert.equal(await p.locator('.canvas-edge-arrow').first().evaluate(el => getComputedStyle(el).display), 'none')
    assert.equal(await p.getByRole('button', { name: 'Next PDF page', exact: true }).count(), 0)
    assert.equal(await p.locator('.page-turn-viewer').evaluate(el => getComputedStyle(el, '::before').content), 'none')
  }
  await p.getByRole('button', { name: 'Read-along text', exact: true }).click()
  await p.getByRole('button', { name: 'Start reading' }).click()
  assert.equal(await p.locator('mark').count(), 0, 'no fake sentence highlight from utterance start')
  assert.match(await p.getByRole('region', { name: 'Read-along text' }).innerText(), /Your voice shares its place only when a passage starts or ends/)
  assert.doesNotMatch(await p.getByRole('region', {name:'Read-along text'}).locator('.panel-copy').innerText(), /boundar|utterance|chunk|overlay/i)
  const first = await p.evaluate(() => __speech.current.text)
  const repeated = first.lastIndexOf('Same fine')
  await boundary(p, repeated)
  const marks = await markProof(p)
  assert.equal(marks[0].text, 'Same fine friends find fresh coffee.')
  assert(marks[0].start > 700, 'the repeated sentence maps to its own source occurrence')
  const scrolling = await p.locator('.read-along-text').evaluate(el => el.scrollTop)
  assert(scrolling > 0, 'confirmed late sentence scrolls local transcript')
  const beforeBrowse = await counts(p)
  await p.getByRole('button', { name: 'Next page', exact: true }).click()
  await boundary(p, repeated - 10)
  assert.equal(await actualPage(p), '2'); assert.deepEqual(await counts(p), beforeBrowse)
  assert.equal(await p.locator('mark').count(), 0, 'spoken range never paints browsed blank page')
  await p.getByRole('button', { name: 'Follow reading' }).click()
  assert.equal(await actualPage(p), '1'); await markProof(p)
  await p.getByRole('button', { name: 'Pause reading' }).click()
  assert.equal(await p.locator('mark').first().getAttribute('data-state'), 'paused')
  const paused = await counts(p)
  const slider = p.getByRole('slider', { name: 'Reading progress' })
  await slider.fill('300'); await slider.dispatchEvent('keyup', { key: 'ArrowRight' })
  assert.equal((await counts(p)).starts, paused.starts, 'paused middle seek never queues audio')
  assert.equal(await p.locator('mark').count(), 0)
  await p.getByRole('button', { name: 'Resume reading' }).click()
  assert.equal((await counts(p)).starts, paused.starts + 1)
  assert.notEqual(await p.evaluate(() => __speech.current.text), first)
  await p.getByRole('button', { name: 'Pause reading' }).click()
  const pausedAgain = await counts(p)
  await slider.focus(); await slider.press('End')
  assert.equal(await slider.inputValue(), await slider.getAttribute('max'))
  assert.equal((await counts(p)).starts, pausedAgain.starts, 'paused endpoint seek is silent')
  assert.equal(await actualPage(p), '3'); assert.equal(await p.locator('mark').count(), 0)
  await slider.press('Home')
  assert.equal(await slider.inputValue(), '0'); assert.equal((await counts(p)).starts, pausedAgain.starts)
  await p.getByRole('button', { name: 'Start reading' }).click()
  assert.equal(await p.evaluate(() => __speech.current.text), first)
  await boundary(p, repeated)
  await p.getByRole('button', { name: 'Next sentence' }).click()
  assert.match(await p.evaluate(() => __speech.current.text), /^ALICE: Sentence/)
  const afterSkip = await counts(p)
  await p.evaluate(() => { __speech.old.onboundary({ charIndex: 0 }); __speech.old.onend() })
  assert.deepEqual(await counts(p), afterSkip, 'old generation cannot advance or queue speech')
  await p.getByRole('button', { name: 'Previous sentence' }).click()
  assert.match(await p.evaluate(() => __speech.current.text), /^Same fine/)
  await boundary(p, 0)
  await markProof(p)
  const transcriptBounds = await p.evaluate(() => ({
    bottom: document.querySelector('.transcript-frame').getBoundingClientRect().bottom,
    chromeTop: document.querySelector(innerWidth < 781 ? '.mobile-bar' : '.transport').getBoundingClientRect().top,
  }))
  assert(transcriptBounds.bottom <= transcriptBounds.chromeTop, JSON.stringify(transcriptBounds))
  await p.screenshot({ path: `${dir}/read-along-${width}.png` })
  await p.getByRole('button', { name: 'Stop reading' }).click()
  assert.equal(await p.locator('mark').count(), 0)
  // Seek the last sentence on page 1, then skip over the actual blank PDF page.
  await p.getByRole('button', { name: 'Previous sentence' }).click()
  const pageOneText = await p.locator('.page-text-disclosure .page-text').textContent()
  await slider.fill(String(pageOneText.lastIndexOf('Same fine')))
  await slider.dispatchEvent('keyup', { key: 'ArrowRight' })
  await p.getByRole('button', { name: 'Start reading' }).click()
  await p.getByRole('button', { name: 'Next sentence' }).click()
  assert.equal(await actualPage(p), '3', 'sentence skip crosses blank page without speaking it')
  await p.getByRole('button', { name: 'Previous sentence' }).click()
  assert.equal(await actualPage(p), '1', 'back sentence crosses pages deterministically')
  await p.getByRole('button', { name: 'Stop reading' }).click()
  const stopped = await counts(p)
  // Actual pointer interaction uses range semantics, starts only after Play when stopped.
  const bounds = await slider.boundingBox()
  const pointerBefore = await slider.inputValue()
  await p.mouse.click(bounds.x + bounds.width * 0.75, bounds.y + bounds.height / 2)
  assert.notEqual(await slider.inputValue(), pointerBefore); assert.equal((await counts(p)).starts, stopped.starts)
  await p.getByRole('button', { name: 'Start reading' }).click()
  assert.notEqual(await p.evaluate(() => __speech.current.text), first)
  const dragBefore = await counts(p)
  const fromValue = +await slider.inputValue(), maximum = +await slider.getAttribute('max')
  const startX = bounds.x + 8 + (bounds.width - 16) * fromValue / maximum
  const endX = bounds.x + bounds.width * 0.9, y = bounds.y + bounds.height / 2
  if (width < 781) {
    const cdp = await p.context().newCDPSession(p)
    await cdp.send('Input.dispatchTouchEvent', { type:'touchStart', touchPoints:[{x:startX,y}] })
    await cdp.send('Input.dispatchTouchEvent', { type:'touchMove', touchPoints:[{x:endX,y}] })
    assert.equal((await counts(p)).starts, dragBefore.starts, 'touch drag waits for release')
    await cdp.send('Input.dispatchTouchEvent', { type:'touchEnd', touchPoints:[] })
  } else {
    await p.mouse.move(startX,y); await p.mouse.down(); await p.mouse.move(endX,y,{steps:5})
    assert.equal((await counts(p)).starts, dragBefore.starts, 'pointer drag waits for release')
    await p.mouse.up()
  }
  await p.waitForFunction(starts => __speech.inputs.length === starts + 1, dragBefore.starts)
  assert(+await slider.inputValue() > fromValue)
  await p.getByRole('button', { name: 'Stop reading' }).click()
  const geometry = await p.evaluate(() => {
    const rect = selector => { const r = document.querySelector(selector).getBoundingClientRect(); return { x:r.x,y:r.y,width:r.width,height:r.height,bottom:r.bottom } }
    return { overflow: document.documentElement.scrollWidth - innerWidth, header:rect('.preview-header'), progress:rect('.reading-progress'), chrome:rect(innerWidth < 781 ? '.mobile-bar' : '.transport'),
      buttons: [...document.querySelectorAll('.reading-progress button')].map(el => { const r = el.getBoundingClientRect(); return {width:r.width,height:r.height} }) }
  })
  assert.equal(geometry.overflow, 0)
  assert(geometry.buttons.every(b => b.width >= 44 && b.height >= 44))
  assert(geometry.progress.bottom <= geometry.chrome.bottom)
  if (width < 781) assert(geometry.header.bottom < geometry.chrome.y)
  evidence.push({ width, marks, scrolling, geometry, transcriptBounds })
  await p.close()
}
await browser.close()
await writeFile(`${dir}/report.json`, JSON.stringify({ passed:true, evidence, limitations:'Synthesis boundary harness verifies API/source mapping, not audible speech or iOS. No-boundary voices intentionally have no sentence highlight. Read-along is extracted text, not PDF overlay.' }, null, 2))
console.log(JSON.stringify({ passed:true, artifacts:dir, widths:evidence.map(e => e.width) }))
