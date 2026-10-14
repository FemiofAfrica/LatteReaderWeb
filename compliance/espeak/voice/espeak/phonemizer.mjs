/*
 * LatteReader Web adapter for the pinned eSpeak-NG build.
 *
 * This file is LatteReader Web's own code. It exposes the same surface the npm
 * `phonemizer` package used to provide — phonemize(text, language) and
 * listVoices() — but drives the eSpeak-NG WebAssembly component we build and
 * serve ourselves from this directory instead of a prebuilt third-party bundle.
 *
 *   component   ../espeak/espeakng.worker.js | .wasm | .data  (GPL-3.0-or-later,
 *               with the Emscripten runtime under MIT)
 *   notices     ../notices/
 *   source      ../source/    corresponding source, offered from this origin
 *   manifest    ../espeak/build-manifest.json   pins and SHA-256 values
 *
 * The component is verified (length and SHA-256) before it runs; see
 * espeakng.bootstrap.js. A verification failure rejects every call here, so the
 * narrator reports an error instead of speaking with an unknown build.
 */
const WORKER_URL = new URL('espeakng.bootstrap.js', import.meta.url).href

let worker = null
let starting = null
let serial = 0
let voices = null
const pending = new Map()

function load() {
  if (starting) return starting
  starting = new Promise((resolve, reject) => {
    const instance = new Worker(WORKER_URL)
    worker = instance
    const failed = error => {
      if (instance === worker) { worker = null; starting = null; voices = null }
      for (const waiting of pending.values()) waiting.reject(error)
      pending.clear()
      instance.terminate()
      reject(error)
    }
    instance.onmessage = ({ data }) => {
      if (typeof data === 'string') { if (data === 'ready') resolve(); return }
      if (data && data.espeakError) { failed(Error(data.espeakError)); return }
      const waiting = data && pending.get(data.callback)
      if (!waiting) return
      pending.delete(data.callback)
      if (data.done === false) waiting.reject(Error('SPEECH_COMPONENT_FAILED'))
      else waiting.resolve(data.result ? data.result[0] : undefined)
    }
    instance.onerror = () => failed(Error('SPEECH_COMPONENT_FAILED'))
  })
  return starting
}

async function call(method, ...args) {
  await load()
  return new Promise((resolve, reject) => {
    const id = ++serial
    pending.set(id, { resolve, reject })
    worker.postMessage({ method, args, callback: id })
  })
}

/** Every voice in the mounted data package. Cached for the life of the worker. */
export function listVoices() {
  voices ??= call('list_voices').then(list => list ?? [])
  return voices
}

/** IPA phonemes for `text`, one string per output line, empty lines dropped. */
export async function phonemize(text, language = 'en-us') {
  const identifiers = new Set()
  for (const voice of await listVoices()) {
    identifiers.add(voice.identifier.toLowerCase())
    for (const entry of voice.languages) identifiers.add(entry.name.toLowerCase())
  }
  if (!identifiers.has(String(language).toLowerCase())) throw Error(`INVALID_LANGUAGE:${language}`)
  const code = await call('set_voice', language)
  if (code) throw Error(`VOICE_UNAVAILABLE:${language}`)
  const result = await call('synthesize_ipa', text)
  if (!result || result.code) throw Error('PHONEMIZE_FAILED')
  return (result.ipa ?? '').split('\n').filter(line => line.length > 0)
}

/** Release the phonemizer worker and everything it holds. */
export function release() {
  worker?.terminate()
  worker = null
  starting = null
  voices = null
  pending.clear()
}
