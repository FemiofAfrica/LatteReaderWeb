// Real-browser proof for the public local narrator on our own preview origin.
//
// It checks, on the owned reading fixture only:
//   1. nothing narrator-related is requested on page load or when the local
//      engine is chosen, so the Enable button is the real consent gate,
//   2. a cold opt-in downloads the pinned asset set, the served bytes match
//      every pin, the served parts reassemble to the whole-file SHA-256, and
//      the worker itself reports verifying that hash before running the graph,
//   3. the reader generates and plays audio: real Web Audio buffers, sources
//      started in a running context, the audio clock advancing, drained end,
//   4. a tampered part fails closed with no audio and a plain error, and the
//      reader still starts a browser-speech run,
//   5. every request stays on this origin, carries no body, and carries no
//      document text or filename,
//   6. a reload states honestly whether assets were transferred again.
//
//   LATTE_READER_URL=http://127.0.0.1:4193/ node scripts/narrator-public-smoke.mjs
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { chromium } from 'playwright'

const base = process.env.LATTE_READER_URL || 'http://127.0.0.1:4193/'
const origin = new URL(base).origin
const out = process.env.LATTE_EVIDENCE || '.runtime/narrator-public-evidence'
await mkdir(out, { recursive: true })
const pins = JSON.parse(await readFile('src/speech/local/narratorPins.json', 'utf8'))
const fixture = 'tests/fixtures/reading-quality.pdf'
const phrase = 'well-known difference' // distinctive wording from the owned fixture
const expectedText = 'f ff fi fl ffi ffl ff fi fl ffi ffl “fine” Five fine friends find fresh coffee. A well-known difference.'
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')

/** Every asset this opt-in is allowed to fetch, with the pin it must match. */
const expected = new Map([
  ...pins.graph.parts.map(part => [`/voice/narrator/${part.path}`, { bytes: part.bytes, sha256: part.sha256 }]),
  [`/voice/narrator/${pins.voice.path}`, { bytes: pins.voice.bytes, sha256: pins.voice.sha256 }],
  [`/voice/narrator/${pins.runtime.bundle.path}`, { bytes: pins.runtime.bundle.bytes, sha256: pins.runtime.bundle.sha256 }],
  [`/voice/narrator/${pins.runtime.glue.path}`, { bytes: pins.runtime.glue.bytes, sha256: pins.runtime.glue.sha256 }],
  [`/voice/narrator/${pins.runtime.wasm.path}`, { bytes: pins.runtime.wasm.bytes, sha256: pins.runtime.wasm.sha256 }],
  ...pins.phonemizer.files.map(file => [`/voice/${file.path.replace('../', '')}`, { bytes: file.bytes, sha256: file.sha256 }]),
  // Our own adapter and loader are part of the opt-in too, so their sizes count
  // towards the advertised total; their hashes are pinned in the repository.
  [`/voice/${pins.phonemizer.adapter.path.replace('../', '')}`, { bytes: pins.phonemizer.adapter.bytes, sha256: null }],
  [`/voice/${pins.phonemizer.loader.path.replace('../', '')}`, { bytes: pins.phonemizer.loader.bytes, sha256: null }],
])

const instrument = async page => {
  const requests = []
  const responses = []
  const errors = []
  page.on('request', request => requests.push({
    url: request.url(), method: request.method(), hasBody: !!request.postData(),
    external: request.url().startsWith('data:') ? false : new URL(request.url()).origin !== origin,
    carriesText: request.url().includes(phrase) || (request.postData() ?? '').includes(phrase),
  }))
  page.on('response', response => {
    const url = new URL(response.url())
    if (url.origin !== origin || !response.ok()) return
    // Lengths come from the response headers rather than the body: the two
    // graph parts are fetched by the worker and must not be buffered twice.
    responses.push({ path: url.pathname, status: response.status(), bytes: Number(response.headers()['content-length'] ?? 0) })
  })
  page.on('pageerror', error => errors.push(error.message))
  await page.addInitScript(() => {
    window.__local = { inputs: [], metrics: [], pcm: [], audio: [], status: [], ready: [], failed: [], spoken: [] }
    const push = (key, detail) => window.__local[key].push({ time: performance.now(), ...(detail || {}) })
    window.addEventListener('latte-local-ready', event => push('ready', event.detail))
    window.addEventListener('latte-local-failed', event => push('failed', event.detail))
    window.addEventListener('latte-local-state', event => push('status', event.detail))
    const NativeWorker = Worker
    window.Worker = class extends NativeWorker {
      constructor(url, options) {
        super(url, options)
        this.localNarrator = String(url).includes('narrator.worker')
        if (this.localNarrator) this.addEventListener('message', ({ data }) => {
          if (data?.metrics) window.__local.metrics.push(data.metrics)
        })
      }
      postMessage(message, ...rest) {
        if (this.localNarrator && message?.op === 'generate') window.__local.inputs.push(message.text)
        return super.postMessage(message, ...rest)
      }
    }
    const start = AudioBufferSourceNode.prototype.start
    AudioBufferSourceNode.prototype.start = function (...args) {
      window.__local.audio.push({ action: 'start', offset: args[1] || 0, seconds: this.buffer.duration, state: this.context.state, clock: this.context.currentTime })
      return start.apply(this, args)
    }
    const stop = AudioBufferSourceNode.prototype.stop
    AudioBufferSourceNode.prototype.stop = function (...args) {
      window.__local.audio.push({ action: 'stop', clock: this.context.currentTime })
      return stop.apply(this, args)
    }
    const createBuffer = AudioContext.prototype.createBuffer
    AudioContext.prototype.createBuffer = function (...args) {
      const buffer = createBuffer.apply(this, args)
      const copy = buffer.copyToChannel.bind(buffer)
      buffer.copyToChannel = (data, channel) => {
        window.__local.pcm.push(Array.from(data))
        return copy(data, channel)
      }
      return buffer
    }
    const speak = window.speechSynthesis.speak.bind(window.speechSynthesis)
    window.speechSynthesis.speak = utterance => {
      window.__local.spoken.push({ text: String(utterance.text).slice(0, 60), rate: utterance.rate })
      try { return speak(utterance) } catch { return undefined }
    }
  })
  return {
    requests, responses, errors,
    snapshot: () => page.evaluate(() => JSON.parse(JSON.stringify(window.__local))),
  }
}

const narrate = async page => {
  await page.getByRole('button', { name: 'Read-along text', exact: true }).click()
  await page.getByRole('button', { name: 'Start reading', exact: true }).click()
}
const openFixture = async page => {
  await page.locator('input[type=file]').setInputFiles(fixture)
  await page.waitForFunction(() => document.body.textContent.includes('Extraction complete'))
}
const chooseLocal = page => page.getByLabel('Reading engine', { exact: true }).selectOption('local')
const waitForState = async (page, capture, status, label, timeout) => {
  try {
    await page.locator(`[data-local-status=${status}]`).waitFor({ timeout })
  } catch (error) {
    const state = await capture.snapshot()
    throw Error(`${label}: never reached ${status}. failed=${JSON.stringify(state.failed)} lastStatus=${JSON.stringify(state.status.at(-1))} ready=${state.ready.length} :: ${error.message}`)
  }
}
const voicePaths = capture => capture.requests.map(request => new URL(request.url).pathname).filter(path => path.startsWith('/voice/'))
const wav = (pcm, samples) => {
  const data = pcm.slice(0, samples)
  const buffer = Buffer.alloc(44 + data.length * 2)
  buffer.write('RIFF'); buffer.writeUInt32LE(buffer.length - 8, 4); buffer.write('WAVEfmt ', 8)
  buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22)
  buffer.writeUInt32LE(24000, 24); buffer.writeUInt32LE(48000, 28); buffer.writeUInt16LE(2, 32)
  buffer.writeUInt16LE(16, 34); buffer.write('data', 36); buffer.writeUInt32LE(data.length * 2, 40)
  data.forEach((value, index) => buffer.writeInt16LE(Math.round(Math.max(-1, Math.min(1, value)) * 32767), 44 + index * 2))
  return buffer
}
const rms = pcm => Math.sqrt(pcm.reduce((total, value) => total + value * value, 0) / pcm.length)
const sum = entries => entries.reduce((total, entry) => total + entry.bytes, 0)

const browser = await chromium.launch()
const evidence = {
  base,
  pins: { graphSha256: pins.graph.sha256, parts: pins.graph.parts.map(part => part.sha256), transferBytes: pins.transfer.bytes },
  phases: {},
}

// ---------------------------------------------------------------- happy path
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
const page = await context.newPage()
const cdp = await context.newCDPSession(page)
await cdp.send('Network.enable')
const network = []
cdp.on('Network.responseReceived', ({ response }) => network.push({ path: new URL(response.url).pathname, fromDiskCache: response.fromDiskCache === true, status: response.status }))
// Every narrator asset the browser receives passes through this route, so the
// bytes the browser actually got can be hashed, not merely their declared
// length: the parts are also reassembled and checked here.
const routed = []
await context.route('**/voice/**', async route => {
  const response = await route.fetch()
  const body = Buffer.from(await response.body())
  const path = new URL(route.request().url()).pathname
  routed.push({ path, status: response.status(), bytes: body.length, sha256: sha256(body), body })
  await route.fulfill({ response, body })
})
const capture = await instrument(page)
const { requests, responses, errors } = capture

await page.goto(base)
await page.waitForTimeout(1000)
assert.equal(voicePaths(capture).length, 0, `page load must request no narrator asset: ${JSON.stringify(voicePaths(capture))}`)

await openFixture(page)
await chooseLocal(page)
await page.waitForTimeout(500)
assert.equal(voicePaths(capture).length, 0, `choosing the local engine must request nothing: ${JSON.stringify(voicePaths(capture))}`)
await page.locator('[data-local-notices=ready]').waitFor()
const consent = (await page.locator('.local-narrator-controls').innerText()).replace(/\s+/g, ' ')
assert.match(consent, /about 53\.\d MB of voice files/, `the consent copy must show the real total: ${consent}`)
assert.match(consent, /stay on this device/)
const beforeEnable = await capture.snapshot()
assert.equal(beforeEnable.ready.length + beforeEnable.failed.length + beforeEnable.metrics.length + beforeEnable.audio.length, 0, 'nothing may start before Enable')

const responseMark = responses.length
const routeMark = routed.length
const enabling = Date.now()
await page.getByRole('button', { name: 'Enable local narrator', exact: true }).click()
await waitForState(page, capture, 'ready', 'cold opt-in', 300000)
const enableMs = Date.now() - enabling
const init = (await capture.snapshot()).ready[0] ?? {}
assert.equal(init.graphSha256, pins.graph.sha256, `the worker must report verifying the pinned graph: ${JSON.stringify(init)}`)
assert.equal(init.parts, pins.graph.parts.length)
assert.equal(init.graphBytes, pins.graph.bytes)
assert.equal(init.runtimeWasmSha256, pins.runtime.wasm.sha256)
assert.equal(init.voiceSha256, pins.voice.sha256)

const optedIn = routed.slice(routeMark)
// What the browser actually received during this opt-in. Every narrator asset
// is fetched; the ones the route can see are checked byte for byte, the two
// graph parts are reassembled, and the rest (loaded by a nested worker, which
// routing does not reach) are accounted for at their pinned sizes.
const observed = new Map(optedIn.map(entry => [entry.path, entry]))
// Request events do not report the script URL of a worker created inside
// another worker, so /voice/espeak/espeakng.bootstrap.js is not visible here.
// That it ran is proved by the mounted eSpeak voice list in the init report;
// its size is pinned and checked against the shipped file by the unit tests.
const UNOBSERVABLE = new Set(['/voice/espeak/espeakng.bootstrap.js'])
const seenPaths = new Set([...voicePaths(capture), ...responses.map(entry => entry.path).filter(path => path.startsWith('/voice/'))])
assert.ok(init.phonemizerVoices > 0, `the pinned eSpeak component must have mounted: ${JSON.stringify(init)}`)
for (const [path, pin] of expected) {
  if (!UNOBSERVABLE.has(path)) assert.ok(seenPaths.has(path), `${path} must be fetched during the opt-in`)
  const asset = observed.get(path)
  if (!asset) continue
  assert.equal(asset.status, 200, `${path} must be served`)
  assert.equal(asset.bytes, pin.bytes, `${path} length as received by the browser`)
  assert.ok(asset.sha256, `${path} must have been read`)
  if (pin.sha256) assert.equal(asset.sha256, pin.sha256, `${path} sha256 as received by the browser`)
}
const partsObserved = pins.graph.parts.map(part => observed.get(`/voice/narrator/${part.path}`))
assert.ok(partsObserved.every(Boolean), 'both graph parts must be observed through the route')
const graph = Buffer.concat(partsObserved.map(asset => asset.body))
assert.equal(graph.length, pins.graph.bytes)
assert.equal(sha256(graph), pins.graph.sha256, 'the bytes the browser received must reassemble to the pinned graph')
const unobserved = [...expected.keys()].filter(path => !observed.has(path))
const receivedBytes = sum([...observed.values()])
const countedBytes = receivedBytes + unobserved.reduce((total, path) => total + expected.get(path).bytes, 0)
const otherFetches = responses.slice(responseMark).filter(entry => !entry.path.startsWith('/voice/')).map(entry => entry.path)
assert.equal(countedBytes, pins.transfer.bytes, `the opt-in must total the advertised payload: ${countedBytes} vs ${pins.transfer.bytes}`)

await narrate(page)
await waitForState(page, capture, 'playing', 'playback start', 240000)
await page.waitForTimeout(600)
const playing = await capture.snapshot()
assert.ok(playing.audio.some(entry => entry.action === 'start' && entry.state === 'running'), `audio must start in a running context: ${JSON.stringify(playing.audio)}`)
await waitForState(page, capture, 'ready', 'playback drain', 240000)
const played = await capture.snapshot()
const starts = played.audio.filter(entry => entry.action === 'start')
assert.ok(starts.length >= 2, `every chunk must be played through Web Audio: ${JSON.stringify(starts)}`)
assert.ok(played.metrics.length >= 2)
assert.ok(played.metrics.every(metric => metric.audioSeconds > 0 && metric.rtf > 0 && metric.trimSamples === 0))
assert.equal(played.metrics.at(-1).verifiedGraphSha256, pins.graph.sha256)
assert.ok(played.pcm.length > 0, 'the played PCM must be captured')
const samples = played.pcm[0]
assert.ok(samples.length > 24000, `the first played buffer must be real audio: ${samples.length} samples`)
assert.ok(rms(samples) > 0.001, `the played audio must not be silence: rms ${rms(samples)}`)
assert.equal(played.inputs.join(''), expectedText, 'the document text must reach the local worker in exact, lossless slices')
assert.ok(played.inputs.length >= 2 && played.inputs.every(text => text.length <= 250), `every source slice must stay within the bound: ${JSON.stringify(played.inputs.map(text => text.length))}`)
assert.ok(starts.at(-1).clock > 0.5, `the audio clock must advance during playback: ${starts.at(-1).clock}`)
await writeFile(`${out}/played-chunk-1.wav`, wav(samples, 24000 * 8))

evidence.phases.coldOptIn = {
  enableMs,
  audioContextState: starts[0].state,
  narratorAssets: voicePaths(capture),
  assetCount: voicePaths(capture).length + otherFetches.length,
  otherFetches,
  receivedPayloadBytes: countedBytes,
  observedThroughRoute: receivedBytes,
  observedPaths: [...observed.keys()],
  unobservedPathsCountedAtPinnedSize: unobserved,
  advertisedBytes: pins.transfer.bytes,
  received: optedIn.map(({ path, status, bytes, sha256: hash }) => ({ path, status, bytes, sha256: hash })),
  reassembledGraph: { bytes: graph.length, sha256: sha256(graph) },
  workerInit: init,
  chunksPlayed: starts.length,
  playedSeconds: starts.reduce((total, entry) => total + entry.seconds, 0),
  audioClockSeconds: starts.at(-1).clock,
  metrics: played.metrics,
  rms: rms(samples),
  samples: samples.length,
  instance: { userAgent: await page.evaluate(() => navigator.userAgent), cores: await page.evaluate(() => navigator.hardwareConcurrency) },
}

// ------------------------------------------------------------------- reload
const reloadResponses = responses.length
const reloadVoiceMark = voicePaths(capture).length
const reloadRouteMark = routed.length
const networkMark = network.length
await page.reload()
await page.waitForFunction(() => document.body.textContent.includes('Extraction complete'))
// The document is restored from local storage, so the panel is already open.
// Re-uploading it here would start a replacement that stops a run mid-prepare.
await chooseLocal(page)
await page.waitForTimeout(1500)
assert.equal(voicePaths(capture).length, reloadVoiceMark, 'a reload must not fetch narrator assets by itself')
await page.getByRole('button', { name: 'Enable local narrator', exact: true }).click()
await waitForState(page, capture, 'ready', 'reload opt-in', 240000)
const refetched = voicePaths(capture).slice(reloadVoiceMark)
const reloadInit = (await capture.snapshot()).ready.at(-1) ?? {}
const reloaded = routed.slice(reloadRouteMark)
const partTransfer = reloaded.filter(entry => entry.path.includes('chunks/model.onnx.part'))
const servedFromCache = partTransfer.length > 0 && partTransfer.every(entry => entry.bytes === 0)
const cacheAfterReload = network.slice(networkMark).filter(entry => entry.path.startsWith('/voice/'))
assert.equal(reloadInit.graphSha256, pins.graph.sha256, 'the reloaded worker must verify the same graph again')
assert.ok(refetched.includes('/voice/narrator/chunks/model.onnx.part1') || servedFromCache, 'the parts must either be transferred again or provably come from the HTTP cache')
evidence.phases.reload = {
  assetsRequestedAfterReload: refetched,
  receivedAfterReload: reloaded.map(({ path, status, bytes }) => ({ path, status, bytes })),
  bytesReceivedAfterReload: sum(reloaded),
  partStatusAfterReload: partTransfer.map(({ path, status, bytes }) => ({ path, status, bytes })),
  pageLevelBytesAfterReload: sum(responses.slice(reloadResponses)),
  fromDiskCache: cacheAfterReload.filter(entry => entry.fromDiskCache).map(entry => entry.path),
  revalidated: cacheAfterReload.length > 0,
  reusedFromHttpCache: servedFromCache,
  policy: 'this app keeps no persistent voice cache of its own, so only the browser HTTP cache can avoid a second transfer; the preview sends Cache-Control: no-cache, so a reload revalidates',
}

// ------------------------------------------- reload without interception
// The routed reload above proves the app re-requests every asset. Interception
// can satisfy a request without the browser's own cache, so the same reload is
// measured once more in a plain context: this is what a real browser would do
// with its HTTP cache available.
const plain = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
const page3 = await plain.newPage()
const plainCapture = await instrument(page3)
await page3.goto(base)
await openFixture(page3)
await chooseLocal(page3)
await page3.getByRole('button', { name: 'Enable local narrator', exact: true }).click()
await waitForState(page3, plainCapture, 'ready', 'unintercepted cold opt-in', 300000)
const plainVoiceMark = voicePaths(plainCapture).length
const plainResponseMark = plainCapture.responses.length
await page3.reload()
await page3.waitForFunction(() => document.body.textContent.includes('Extraction complete'))
await chooseLocal(page3)
await page3.waitForTimeout(1500)
await page3.getByRole('button', { name: 'Enable local narrator', exact: true }).click()
await waitForState(page3, plainCapture, 'ready', 'unintercepted reload opt-in', 240000)
const plainReloadRequests = voicePaths(plainCapture).slice(plainVoiceMark)
const plainReloadResponses = plainCapture.responses.slice(plainResponseMark).filter(entry => entry.path.startsWith('/voice/'))
const notModified = plainReloadResponses.filter(entry => entry.status === 304)
evidence.phases.reloadWithoutInterception = {
  assetsRequested: plainReloadRequests,
  responseStatuses: plainReloadResponses.map(entry => ({ path: entry.path, status: entry.status, contentLength: entry.bytes })),
  notModified: notModified.map(entry => entry.path),
  reusedAfterRevalidation: notModified.length > 0,
  bytesInBodies: sum(plainReloadResponses),
  note: 'with no interception the browser answers from this origin under the Cache-Control: no-cache the preview sends, so what arrives here is what a plain reload really transfers',
}
await plain.close()

// ---------------------------------------------------------------- tampering
const genuine = new Map(optedIn.map(asset => [asset.path, asset.body]))
const tamperedCases = [
  { name: 'corrupted-part', path: '/voice/narrator/chunks/model.onnx.part2', code: 'HASH_MISMATCH', mutate: body => { const copy = Buffer.from(body); copy[Math.floor(copy.length / 2)] ^= 0xff; return copy } },
  { name: 'truncated-part', path: '/voice/narrator/chunks/model.onnx.part1', code: 'SIZE_MISMATCH', mutate: body => body.subarray(0, body.length - 1024) },
]
for (const test of tamperedCases) {
  const hostile = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  const original = genuine.get(test.path)
  assert.ok(original, `the genuine bytes of ${test.path} must be known before tampering`)
  const altered = test.mutate(original)
  await hostile.route(`**${test.path}`, route => route.fulfill({ status: 200, contentType: 'application/octet-stream', body: altered }))
  const page2 = await hostile.newPage()
  const seen = await instrument(page2)
  await page2.goto(base)
  await openFixture(page2)
  await chooseLocal(page2)
  await page2.getByRole('button', { name: 'Enable local narrator', exact: true }).click()
  await waitForState(page2, seen, 'error', test.name, 180000)
  await page2.waitForTimeout(500)
  const state = await seen.snapshot()
  assert.equal(state.failed[0]?.code, test.code, `${test.name} must fail closed with ${test.code}: ${JSON.stringify(state.failed)}`)
  assert.equal(state.ready.length, 0, `${test.name} must not report ready`)
  assert.equal(state.audio.filter(entry => entry.action === 'start').length, 0, `${test.name} must play no audio`)
  assert.equal(state.pcm.length, 0, `${test.name} must build no audio buffer`)
  assert.equal(state.metrics.length, 0, `${test.name} must run no inference`)
  assert.equal((await page2.locator('[data-local-status=error]').innerText()).trim(), 'Local voice failed. Retry or use Browser default.')
  assert.deepEqual(seen.errors, [], `no uncaught page error: ${JSON.stringify(seen.errors)}`)
  const chunksRequested = voicePaths(seen).filter(path => path.includes('chunks/'))
  // The reader is still usable: the browser route starts a real speech run.
  await page2.getByLabel('Reading engine', { exact: true }).selectOption('browser')
  await narrate(page2)
  await page2.waitForTimeout(1000)
  const spoken = (await seen.snapshot()).spoken
  assert.ok(spoken.length > 0, `the reader must still start a browser-speech run: ${JSON.stringify(spoken)}`)
  evidence.phases[`tampered-${test.name}`] = {
    code: state.failed[0]?.code,
    tamper: altered.length === original.length
      ? `the served part was the pinned length, ${altered.length} bytes, with altered content`
      : `the served part was ${altered.length} bytes instead of the pinned ${original.length}`,
    chunksRequested, chunksFetched: chunksRequested.length,
    audioStarts: 0, chunksGenerated: 0,
    browserSpeech: spoken,
    readerStatusAfterBrowserRun: (await page2.locator('.voice-status').innerText().catch(() => '')).trim(),
    note: 'headless Chromium ships no installed voices, so this shows the browser route is submitted and not blocked by the local failure, not that a voice was audible',
  }
  await hostile.close()
}

// ------------------------------------------------------------------ privacy
const external = requests.filter(request => request.external)
const withBody = requests.filter(request => request.hasBody)
assert.deepEqual(external, [], `no request may leave ${origin}`)
assert.deepEqual(withBody, [], 'no request may carry a body')
assert.equal(requests.filter(request => request.carriesText).length, 0, 'no request may carry document text')
assert.equal(voicePaths(capture).filter(path => path.includes('reading-quality')).length, 0, 'no request may carry the filename')
assert.deepEqual(errors, [], `no uncaught page error: ${JSON.stringify(errors)}`)
evidence.privacy = {
  requests: requests.length, narratorAssetRequests: voicePaths(capture).length,
  origins: [...new Set(requests.map(request => new URL(request.url).origin))],
  external: external.length, bodies: withBody.length, textLeaks: 0,
  documentInputsSentToWorker: played.inputs, errors,
}
await writeFile(`${out}/results.json`, JSON.stringify({ ...evidence, requests }, null, 2))
console.log(JSON.stringify({
  base,
  enableMs,
  audioContextState: evidence.phases.coldOptIn.audioContextState,
  narratorAssetRequests: voicePaths(capture).length,
  receivedPayloadBytes: countedBytes,
  advertisedBytes: pins.transfer.bytes,
  graphVerifiedByWorker: init.graphSha256,
  graphReassembledFromServedParts: sha256(graph),
  chunksPlayed: starts.length,
  playedSeconds: evidence.phases.coldOptIn.playedSeconds,
  rms: rms(samples),
  reload: { requested: refetched.length, reusedFromHttpCache: servedFromCache, bytesReceived: evidence.phases.reload.bytesReceivedAfterReload },
  tampered: Object.fromEntries(Object.entries(evidence.phases)
    .filter(([name]) => name.startsWith('tampered'))
    .map(([name, value]) => [name, { code: value.code, chunksFetched: value.chunksFetched, speech: value.browserSpeech.length }])),
  privacy: { requests: requests.length, external: external.length, bodies: withBody.length, origins: evidence.privacy.origins },
  errors,
}, null, 2))
await context.close()
await browser.close()
