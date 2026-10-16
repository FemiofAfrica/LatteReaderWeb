// Natural voice choice and voice files persist across reloads, with no model download on the second load.
// Usage: LATTE_READER_URL=http://localhost:4173 node scripts/voice-persistence-smoke.mjs
import assert from 'node:assert/strict'
import { chromium } from 'playwright'
const base = process.env.LATTE_READER_URL; assert(base, 'LATTE_READER_URL')
const browser = await chromium.launch()
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
let voiceRequests = []
context.on('request', request => { if (request.url().includes('/voice/narrator/')) voiceRequests.push(request.url().replace(/^.*\/voice\/narrator\//, '')) })
const p = await context.newPage()
// Analytics consent granted so events are queued; the tag itself is never fetched in the test.
await context.route(/googletagmanager\.com/, route => route.abort())
await p.addInitScript(() => localStorage.setItem('latte-analytics-consent', 'granted'))
const events = {}
const gaEvents = () => p.evaluate(() => (window.dataLayer || []).filter(a => a[0] === 'event').map(a => a[1]))
const select = () => p.locator('.local-narrator-controls select')
const status = s => p.locator(`[data-local-status=${s}]`).waitFor({ timeout: 240000 })
const log = (...a) => console.log('[voice-persistence]', ...a)

await p.goto(base)
await p.locator('input[type=file]').setInputFiles('tests/fixtures/misaki-owned.pdf')
await p.waitForFunction(() => document.body.textContent.includes('Ready to read'), null, { timeout: 60000 })
await select().selectOption('local')
await p.getByRole('button', { name: 'Download voice', exact: true }).click()
const t0 = Date.now(); await status('ready')
log(`first download ready in ${Date.now() - t0} ms, ${voiceRequests.length} voice file requests`)
assert(voiceRequests.some(u => u.includes('model.onnx.part1')), 'first load must download the model')
await p.locator('[data-voice-cached=true]').waitFor({ timeout: 10000 })
events.firstLoad = await gaEvents()
assert.deepEqual(events.firstLoad.filter(e => e.startsWith('voice_download')), ['voice_download_started', 'voice_download_completed'])
const persisted = await p.evaluate(() => navigator.storage.persisted())
const cacheNames = await p.evaluate(() => caches.keys())
log('cache names', cacheNames, 'persisted', persisted)

// Reload 1: still Natural, loaded from the device cache, zero voice requests.
voiceRequests = []
await p.reload()
await p.waitForFunction(() => document.body.textContent.includes('Ready to read'), null, { timeout: 60000 })
assert.equal(await select().inputValue(), 'local', 'mode must still be Natural after reload')
await status('ready')
await p.waitForTimeout(1500)
log('after reload: mode', await select().inputValue(), 'voice requests', voiceRequests.length, voiceRequests)
assert.equal(voiceRequests.length, 0, 'no model or voice requests on the second load')
assert.equal(await p.getByRole('button', { name: 'Turn on voice', exact: true }).count(), 1)
events.reload = await gaEvents()
assert.deepEqual(events.reload.filter(e => e.startsWith('voice_download')), [], 'a cache load is not a download')

// Evicted files: Natural stays selected, nothing downloads by itself, Download prompt returns.
await p.evaluate(async () => { for (const n of await caches.keys()) await caches.delete(n) })
voiceRequests = []
await p.reload()
await p.waitForFunction(() => document.body.textContent.includes('Ready to read'), null, { timeout: 60000 })
assert.equal(await select().inputValue(), 'local')
await p.getByRole('button', { name: 'Download voice', exact: true }).waitFor()
await p.waitForTimeout(3000)
assert.equal(await p.locator('[data-local-status=off]').count(), 1)
assert.equal(voiceRequests.length, 0, 'evicted files must not auto-download')
log('after eviction: mode local, status off, Download prompt shown, voice requests', voiceRequests.length)

// Back to browser voice: stays browser after reload.
await select().selectOption('browser')
await p.reload()
await p.waitForFunction(() => document.body.textContent.includes('Ready to read'), null, { timeout: 60000 })
assert.equal(await select().inputValue(), 'browser', 'mode must stay Browser after reload')
log('after switching back and reloading: mode', await select().inputValue())
log('analytics events', events)
await browser.close()
log('PASS')
