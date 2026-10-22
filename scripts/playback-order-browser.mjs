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
  await page.waitForFunction(() => (window.__playback?.heard.length ?? 0) > 0, null, { timeout: 20_000 })
  console.log(`started; playing visible for ${visibleMs}ms`)
  await page.waitForTimeout(visibleMs)
  const beforeHide = await page.evaluate(() => window.__playback.heard.slice())
  console.log(`heard before hide (${beforeHide.length}): ${beforeHide.join(',')}`)
  const session = await page.context().newCDPSession(page)
  await session.send('Page.setWebLifecycleState', { state: 'hidden' })
  console.log(`hidden; playing for ${hiddenMs}ms`)
  await page.waitForTimeout(hiddenMs)
  const result = await page.evaluate(() => ({
    heard: window.__playback.heard.slice(),
    looped: window.__playback.events.some(event => event.loop),
    error: window.__playback.error,
    pausedWhileHidden: window.__playback.events.filter(event => event.hidden).some(event => event.paused && !event.ended),
    parts: window.__playbackParts,
    samples: window.__playback.events.length,
  }))
  await browser.close()

  console.log('--- playback chunk index log ---')
  console.log(result.heard.join(','))
  console.log(`parts=${result.parts} heard=${result.heard.length} samples=${result.samples} looped=${result.looped} error=${result.error}`)

  assert.equal(result.error, null, `engine error: ${result.error}`)
  assert.equal(result.looped, false, 'audio.loop was true; that is the infinite-sentence loop')
  assert.ok(result.heard.length >= minHeard, `only heard ${result.heard.length} chunks: ${result.heard.join(',')}`)
  for (let index = 0; index < result.heard.length; index += 1) {
    assert.equal(result.heard[index], index, `chunk sequence was not 0..n-1 once each: ${result.heard.join(',')}`)
  }
  assert.equal(new Set(result.heard).size, result.heard.length, `duplicate chunk index: ${result.heard.join(',')}`)
  assert.ok(result.heard.length > beforeHide.length, `hidden tab did not advance (before ${beforeHide.length}, after ${result.heard.length})`)
  console.log('playback-order-browser: ok')
} finally {
  if (preview) preview.kill('SIGTERM')
}
