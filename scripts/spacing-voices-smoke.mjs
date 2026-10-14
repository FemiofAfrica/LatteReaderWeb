import assert from 'node:assert/strict'
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { chromium } from 'playwright'
const url = process.env.LATTE_READER_URL ?? 'http://127.0.0.1:4193/'
const artifacts = 'tests/artifacts/spacing-voices'
await mkdir(artifacts, { recursive: true })
// Prove the owned source really has separate touching PDF.js items, not just
// a mocked string. This diagnostic text belongs only to the owned fixture.
const pdf = await getDocument({ data: new Uint8Array(await readFile('tests/fixtures/split-text-items.pdf')), standardFontDataUrl: `${process.cwd()}/node_modules/pdfjs-dist/standard_fonts/` }).promise
const raw = (await (await pdf.getPage(1)).getTextContent()).items.filter(i => 'str' in i)
assert.equal(raw[0].str, 'R'); assert.equal(raw[1].str, 'o')
assert.ok(Math.abs(raw[1].transform[4] - raw[0].transform[4] - raw[0].width) < 0.001)
assert.match(raw.map(i => `${i.str} `).join(''), /^R o /, 'old per-item spacing demonstrably splits the owned word')
await pdf.cleanup()
const browser = await chromium.launch()
try {
  const page = await browser.newPage({ viewport: { width: 504, height: 950 } })
  await page.addInitScript(() => {
    window.__voices = []; window.__inputs = []; window.__voiceListeners = new Set()
    window.__extracted = []
    const NativeWorker = window.Worker
    window.Worker = class extends NativeWorker {
      set onmessage(callback) { super.onmessage = event => { if (event.data.type === 'page') window.__extracted.push(event.data.text); callback(event) } }
      get onmessage() { return super.onmessage }
    }
    window.__publish = voices => { window.__voices = voices; window.__voiceListeners.forEach(f => f()) }
    Object.defineProperty(window, 'SpeechSynthesisUtterance', { value: class { constructor(text) { this.text = text } } })
    Object.defineProperty(window, 'speechSynthesis', { value: {
      getVoices: () => window.__voices,
      addEventListener: (name, cb) => window.__voiceListeners.add(cb),
      removeEventListener: (name, cb) => window.__voiceListeners.delete(cb),
      cancel() {}, pause() {}, resume() {},
      speak(u) { window.__current = u; window.__inputs.push({ text: u.text, voice: u.voice, lang: u.lang }); u.onstart?.() },
    } })
  })
  await page.goto(url)
  await page.locator('input[type=file]').setInputFiles('tests/fixtures/split-text-items.pdf')
  await page.waitForFunction(() => document.body.textContent.includes('Extraction complete'))
  await page.getByRole('button', { name: 'Start reading' }).click()
  const expected = "Ro finds fine coffee. R o are separate letters. A. B. are initials. Two words. can't stop. ALICE: One. ALICE: Two."
  const initial = await page.evaluate(() => window.__inputs.at(-1))
  assert.equal(initial.text, expected)
  const extracted = await page.evaluate(() => window.__extracted[0])
  assert.equal(extracted, "Ro finds fine coffee.\nR o are separate letters.\nA. B. are initials.\nTwo words.\ncan't stop.\nALICE: One.\nALICE: Two.")
  assert.equal(initial.voice, null)
  await page.getByRole('button', { name: 'Read-along text', exact: true }).click()
  await page.evaluate(() => window.__current.onboundary({ charIndex: window.__current.text.indexOf('R o') }))
  await page.locator('.read-along-text mark').waitFor()
  const marked = await page.locator('.read-along-text mark').evaluate(el => ({ text: el.textContent, start: +el.dataset.sourceStart, end: +el.dataset.sourceEnd }))
  assert.equal(marked.text, 'R o are separate letters.')
  assert.equal(marked.start, extracted.indexOf('R o'))
  assert.equal(marked.text, extracted.slice(marked.start, marked.end))
  await page.getByRole('button', { name: 'Stop reading' }).click()
  await page.locator('.read-along-text').evaluate(el => {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
    let node
    while ((node = walker.nextNode())) {
      const offset = node.textContent.indexOf('Ro')
      if (offset < 0) continue
      const range = document.createRange(); range.setStart(node, offset); range.setEnd(node, offset + 2)
      const selected = getSelection(); selected.removeAllRanges(); selected.addRange(range)
      document.dispatchEvent(new Event('selectionchange')); break
    }
  })
  await page.getByRole('button', { name: 'Read selection only' }).click()
  assert.equal((await page.evaluate(() => window.__inputs.at(-1))).text, 'Ro')
  await page.getByRole('button', { name: 'Stop reading' }).click()
  await page.evaluate(() => { getSelection().removeAllRanges(); document.dispatchEvent(new Event('selectionchange')) })
  await page.getByRole('tab', { name: 'Voices', exact: true }).click()
  await page.getByText('No voices listed.', { exact: false }).waitFor()
  const a = { name: 'Owned English', voiceURI: 'shared', lang: 'en-US', localService: true, default: true }
  const b = { name: 'Owned Character', voiceURI: 'shared', lang: 'en-GB', localService: true, default: false }
  const french = { name: 'Owned French', voiceURI: 'fr', lang: 'fr-FR', localService: true, default: false }
  const key = v => JSON.stringify([v.voiceURI, v.name, v.lang, v.localService])
  await page.evaluate(voices => window.__publish(voices), [french, b, a])
  await page.getByLabel('Default reading voice').selectOption(key(a))
  await page.getByRole('button', { name: 'Analyze Characters' }).click()
  await page.getByLabel('Alice voice').selectOption(key(b))
  await page.evaluate(voices => window.__publish(voices), [a, french, b])
  assert.equal(await page.getByLabel('Default reading voice').inputValue(), key(a))
  assert.equal(await page.getByLabel('Alice voice').inputValue(), key(b))
  await page.screenshot({ path: `${artifacts}/chooser-504.png`, fullPage: true })
  await page.getByRole('tab', { name: 'Read', exact: true }).click()
  await page.getByRole('button', { name: 'Start reading' }).click()
  assert.equal((await page.evaluate(() => window.__inputs.at(-1))).voice.name, a.name)
  await page.evaluate(() => window.__current.onend())
  assert.equal((await page.evaluate(() => window.__inputs.at(-1))).voice.name, b.name)
  await page.getByRole('button', { name: 'Stop reading' }).click()
  await page.waitForTimeout(250)
  await page.reload()
  await page.waitForFunction(() => document.body.textContent.includes('Extraction complete'))
  await page.getByRole('tab', { name: 'Voices', exact: true }).click()
  assert.equal(await page.getByLabel('Default reading voice').inputValue(), key(a))
  assert.equal(await page.getByLabel('Alice voice').inputValue(), key(b))
  assert.equal(await page.evaluate(() => window.__inputs.length), 0, 'restore is silent')
  await page.evaluate(voices => window.__publish(voices), [french, a])
  await page.getByRole('tab', { name: 'Read', exact: true }).click()
  await page.getByRole('button', { name: 'Start reading' }).click()
  await page.evaluate(() => window.__current.onend())
  assert.equal((await page.evaluate(() => window.__inputs.at(-1))).voice.name, a.name)
  await page.getByRole('tab', { name: 'Voices', exact: true }).click()
  await page.getByText('The selected voice is unavailable.', { exact: false }).waitFor()
  assert.equal(await page.getByLabel('Alice voice').inputValue(), key(b), 'missing identity is not overwritten')
  await page.evaluate(voices => window.__publish(voices), [b, french, a])
  await page.getByRole('button', { name: 'Stop reading' }).click()
  await page.getByRole('button', { name: 'Analyze Characters' }).click()
  assert.equal(await page.getByLabel('Alice voice').inputValue(), key(b), 'reanalyze keeps explicit choice')
  // Restore clears the global choice AND every stored speaker choice, not just the select.
  await page.getByLabel('Default reading voice').selectOption(key(french))
  await page.getByLabel('Narrator voice', { exact: true }).selectOption(key(french))
  const saved = () => page.evaluate(() => new Promise(resolve => {
    const req = indexedDB.open('latte-reader-local', 1)
    req.onsuccess = () => { const db = req.result; const get = db.transaction('current-document').objectStore('current-document').get('current'); get.onsuccess = () => { db.close(); resolve(get.result) } }
  }))
  await page.waitForTimeout(250)
  const beforeReset = await saved()
  await page.getByRole('tab', { name: 'Read', exact: true }).click()
  await page.getByRole('button', { name: 'Start reading' }).click()
  assert.equal((await page.evaluate(() => window.__inputs.at(-1))).voice.name, french.name)
  await page.getByRole('tab', { name: 'Voices', exact: true }).click()
  await page.getByRole('button', { name: 'Restore browser default', exact: true }).click()
  assert.equal(await page.getByLabel('Default reading voice').inputValue(), '')
  for (const label of ['Narrator voice', 'Alice voice']) assert.equal(await page.getByLabel(label, { exact: true }).inputValue(), '')
  await page.waitForTimeout(250)
  const afterReset = await saved()
  assert.equal(afterReset.reader.voiceKey, undefined)
  assert.ok(afterReset.voicePlan.profiles.every(p => p.voiceKey === undefined))
  assert.equal(afterReset.id, beforeReset.id); assert.deepEqual(afterReset.bytes, beforeReset.bytes)
  assert.deepEqual({ ...afterReset.reader, voiceKey: undefined }, { ...beforeReset.reader, voiceKey: undefined })
  const proveDefaultRun = async () => {
    await page.getByRole('tab', { name: 'Read', exact: true }).click()
    const start = await page.evaluate(() => window.__inputs.length)
    await page.getByRole('button', { name: 'Start reading' }).click()
    for (let guard = 0; guard < 10 && await page.getByRole('button', { name: 'Pause reading' }).count(); guard++) await page.evaluate(() => window.__current.onend())
    const run = await page.evaluate(start => window.__inputs.slice(start), start)
    assert.ok(run.length); assert.ok(run.every(input => input.voice.name === a.name), 'all speakers use actual default English voice')
  }
  await proveDefaultRun()
  await page.reload(); await page.waitForFunction(() => document.body.textContent.includes('Extraction complete'))
  assert.equal(await page.evaluate(() => window.__inputs.length), 0, 'reset restores silently')
  await page.evaluate(voices => window.__publish(voices), [b, french, a])
  await page.getByRole('tab', { name: 'Voices', exact: true }).click()
  await page.getByRole('button', { name: 'Analyze Characters' }).click()
  assert.equal(await page.getByLabel('Alice voice').inputValue(), '', 'reset survives restore and reanalysis')
  await proveDefaultRun()
  await page.getByRole('tab', { name: 'Voices', exact: true }).click()
  for (const width of [320, 390, 504, 1440]) {
    await page.setViewportSize({ width, height: 1000 }); await page.waitForTimeout(100)
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth), 0)
    await page.getByLabel('Default reading voice').scrollIntoViewIfNeeded()
    const chooser = await page.getByLabel('Default reading voice').boundingBox()
    assert.ok(chooser.width > 100)
    assert.equal(await page.getByLabel('Default reading voice').evaluate(el => {
      const r = el.getBoundingClientRect()
      return document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) === el
    }), true, 'chooser is reachable, not only present in a clipped sidebar')
    await page.screenshot({ path: `${artifacts}/chooser-${width}.png`, fullPage: true })
  }
  await writeFile(`${artifacts}/result.json`, JSON.stringify({ expectedInput: expected, extracted, rawSplit: raw.slice(0, 2).map(i => ({ text: i.str, x: i.transform[4], width: i.width })), initial, stableChoices: [key(a), key(b)], checks: ['real worker PDF to speech input', 'delayed list', 'reorder', 'duplicate URI', 'missing voice fallback', 'local reload', 'silent restore', 'reanalyze choices', 'responsive chooser'] }, null, 2))
  console.log('PASS: actual split-font PDF worker input, delayed/reordered/missing voices, per-character persistence, 320/390/504/1440 chooser.')
} finally { await browser.close() }
