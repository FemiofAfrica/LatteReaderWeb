import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chromium } from 'playwright'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const port = Number(process.env.PLAYBACK_ORDER_PORT || 4175)
const base = (process.env.LATTE_READER_URL ?? `http://127.0.0.1:${port}/`).replace(/\/?$/, '/')
const visibleMs = Number(process.env.PLAYBACK_VISIBLE_MS || 60_000)
const hiddenMs = Number(process.env.PLAYBACK_HIDDEN_MS || 30_000)
const minHeard = Number(process.env.PLAYBACK_MIN_HEARD || 80)

async function waitFor(url) {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url)
      if (response.ok) return
    } catch { /* preview still starting */ }
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  throw new Error(`preview did not start: ${url}`)
}

let preview
if (!process.env.LATTE_READER_URL) {
  preview = spawn(process.execPath, [
    path.join(root, 'node_modules/vite/bin/vite.js'),
    'preview',
    '--host', '127.0.0.1',
    '--port', String(port),
    '--strictPort',
  ], { cwd: root, stdio: 'inherit' })
}

try {
  await waitFor(`${base}playback-order.html`)
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage()
  page.on('console', message => console.log(`[browser:${message.type()}] ${message.text()}`))
  page.on('pageerror', error => console.error(`[pageerror] ${error.message}`))
  await page.goto(`${base}playback-order.html`, { waitUntil: 'networkidle' })
  await page.click('#play')
  await page.waitForFunction(() => window.__playbackIndex?.() != null, null, { timeout: 20_000 })
  console.log(`started; playing visible for ${visibleMs}ms`)
  const pollHeard = async (ms, label) => {
    const heard = []
    const deadline = Date.now() + ms
    while (Date.now() < deadline) {
      const snapshot = await page.evaluate(() => ({
        index: window.__playbackIndex?.() ?? null,
        loop: window.__playbackAudio?.loop ?? false,
        paused: window.__playbackAudio?.paused ?? true,
        time: window.__playbackAudio?.currentTime ?? 0,
        hidden: document.hidden,
        error: window.__playback?.error ?? null,
      }))
      if (snapshot.error) throw new Error(snapshot.error)
      if (snapshot.loop) throw new Error('audio.loop was true; that is the infinite-sentence loop')
      if (typeof snapshot.index === 'number' && heard.at(-1) !== snapshot.index) {
        heard.push(snapshot.index)
        console.log(`[${label}] index=${snapshot.index} t=${snapshot.time.toFixed(2)} paused=${snapshot.paused} hidden=${snapshot.hidden}`)
      }
      await page.waitForTimeout(200)
    }
    return heard
  }
  const visibleHeard = await pollHeard(visibleMs, 'visible')
  console.log(`heard before hide (${visibleHeard.length}): ${visibleHeard.join(',')}`)
  const session = await page.context().newCDPSession(page)
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true })
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
    document.dispatchEvent(new Event('visibilitychange'))
    window.dispatchEvent(new Event('pagehide'))
  })
  try {
    await session.send('Page.setWebLifecycleState', { state: 'frozen' })
  } catch (error) {
    console.log(`lifecycle freeze unavailable (${error.message}); visibilitychange still applied`)
  }
  console.log(`hidden; playing for ${hiddenMs}ms`)
  const hiddenHeard = await pollHeard(hiddenMs, 'hidden')
  const result = await page.evaluate(() => ({
    heard: window.__playback.heard.slice(),
    looped: window.__playback.events.some(event => event.loop),
    error: window.__playback.error,
    pausedWhileHidden: window.__playback.events.filter(event => event.hidden).some(event => event.paused && !event.ended),
    parts: window.__playbackParts,
    samples: window.__playback.events.length,
    polled: true,
  }))
  const heard = [...visibleHeard]
  for (const index of hiddenHeard) {
    if (heard.at(-1) !== index) heard.push(index)
  }
  await browser.close()

  console.log('--- playback chunk index log ---')
  console.log(heard.join(','))
  console.log(`visible=${visibleHeard.join(',')}`)
  console.log(`hidden=${hiddenHeard.join(',')}`)
  console.log(`parts=${result.parts} heard=${heard.length} pageHeard=${result.heard.join(',')} samples=${result.samples} looped=${result.looped} error=${result.error}`)

  assert.equal(result.error, null, `engine error: ${result.error}`)
  assert.equal(result.looped, false, 'audio.loop was true; that is the infinite-sentence loop')
  assert.ok(heard.length >= minHeard, `only heard ${heard.length} chunks: ${heard.join(',')}`)
  for (let index = 0; index < heard.length; index += 1) {
    assert.equal(heard[index], index, `chunk sequence was not 0..n-1 once each: ${heard.join(',')}`)
  }
  assert.equal(new Set(heard).size, heard.length, `duplicate chunk index: ${heard.join(',')}`)
  assert.ok(heard.length > visibleHeard.length, `hidden tab did not advance (before ${visibleHeard.length}, after ${heard.length})`)
  console.log('playback-order-browser: ok')
} finally {
  if (preview) preview.kill('SIGTERM')
}
