/*
 * LatteReader Web loader for the pinned eSpeak-NG WebAssembly build.
 *
 * This file is LatteReader Web's own code. It does not contain, replace or
 * relicense the eSpeak-NG component it loads:
 *
 *   espeakng.worker.js    eSpeak-NG WebIDL glue (GPL-3.0-or-later) carrying the
 *                         Emscripten runtime JavaScript (MIT)
 *   espeakng.worker.wasm  compiled eSpeak-NG 1.52.0, commit 4870adfa (GPL-3.0-or-later)
 *   espeakng.worker.data  the espeak-ng-data the module mounts (GPL-3.0-or-later)
 *
 * Licence texts:      ../notices/
 * Corresponding source: ../source/   (offered from this origin, at no charge)
 *
 * It runs as a dedicated classic worker. It fetches all three files from this
 * directory, checks each one against build-manifest.json by length and SHA-256,
 * and starts the module only from those verified bytes. Any mismatch, and it
 * reports an error and never initialises, so a swapped or truncated asset can
 * never be phonemized with.
 */
const MANIFEST_URL = new URL('build-manifest.json', self.location.href)
const BASE_URL = new URL('./', self.location.href)

const hex = buffer => [...new Uint8Array(buffer)].map(byte => byte.toString(16).padStart(2, '0')).join('')

async function fetchVerified(entry) {
  const response = await fetch(new URL(entry.file, BASE_URL).href, { credentials: 'omit' })
  if (!response.ok) throw Error(`ASSET_UNAVAILABLE:${entry.file}`)
  const buffer = await response.arrayBuffer()
  if (buffer.byteLength !== entry.bytes) throw Error(`SIZE_MISMATCH:${entry.file}`)
  if (hex(await crypto.subtle.digest('SHA-256', buffer)) !== entry.sha256) throw Error(`HASH_MISMATCH:${entry.file}`)
  return buffer
}

async function start() {
  const response = await fetch(MANIFEST_URL.href, { credentials: 'omit' })
  if (!response.ok) throw Error('MANIFEST_UNAVAILABLE')
  const manifest = await response.json()
  const entry = Object.fromEntries(manifest.objectCode.map(item => [item.role, item]))
  for (const role of ['worker-js', 'wasm', 'data']) if (!entry[role]) throw Error(`MANIFEST_INCOMPLETE:${role}`)
  const loaded = {}
  for (const role of ['worker-js', 'wasm', 'data']) loaded[role] = await fetchVerified(entry[role])
  self.Module = {
    locateFile: name => new URL(name, BASE_URL).href,
    getPreloadedPackage: () => loaded.data,
    wasmBinary: new Uint8Array(loaded.wasm),
    setStatus: () => {},
  }
  // The bytes that are executed are the bytes that were hashed: the verified
  // source is handed to importScripts as a blob, not re-fetched by URL.
  importScripts(URL.createObjectURL(new Blob([loaded['worker-js']], { type: 'text/javascript' })))
}

start().catch(error => postMessage({ espeakError: String(error?.message ?? error) }))
