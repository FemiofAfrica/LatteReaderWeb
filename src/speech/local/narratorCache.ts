/**
 * Keeps the Natural voice files on this device after the first download.
 *
 * The files are served from this site with `max-age=0, must-revalidate`, so the
 * HTTP cache alone means a round trip per file on every visit, and a large entry
 * can be dropped by the browser at any time. Instead, each file is written to
 * Cache Storage once it has passed its size and SHA-256 check, and read from
 * there on later visits with no network request at all.
 *
 * The cache name carries a short fingerprint of every pinned path and hash, so a
 * new model or voice gets a new cache: one fresh download, after which the old
 * cache is deleted. Bytes read back from the cache are verified again before
 * use, so a damaged entry is never handed to the runtime. Nothing here ever
 * sends document text or audio anywhere.
 */
import pins from './narratorPins.json'
import { fetchVerified, sha256Hex, type AssetPins, type Fetcher } from './assetIntegrity'

export const NARRATOR_CACHE_PREFIX = 'latte-narrator-'
const BASE_PATH = '/voice/narrator/'

type Pin = AssetPins & { path: string }

/** Every file the worker loads, in load order. */
export const NARRATOR_FILES: readonly Pin[] = [
  ...pins.phonemizer.files,
  pins.voice,
  pins.runtime.bundle,
  pins.runtime.glue,
  pins.runtime.wasm,
  ...pins.graph.parts,
]

/** FNV-1a, 32-bit: a stable, synchronous fingerprint of the pins. Not a security check. */
function fingerprint(text: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

export const NARRATOR_CACHE_VERSION = fingerprint(NARRATOR_FILES.map(file => `${file.path}:${file.bytes}:${file.sha256}`).join('|'))
export const NARRATOR_CACHE_NAME = `${NARRATOR_CACHE_PREFIX}${NARRATOR_CACHE_VERSION}`

export function narratorFileUrl(path: string, origin: string): string {
  return new URL(path, new URL(BASE_PATH, origin)).href
}

function cacheStorage(): CacheStorage | null {
  try { return typeof caches === 'undefined' ? null : caches } catch { return null }
}

async function openCache(): Promise<Cache | null> {
  const storage = cacheStorage()
  if (!storage) return null
  try { return await storage.open(NARRATOR_CACHE_NAME) } catch { return null }
}

/** True when every current voice file is already stored on this device. Never touches the network. */
export async function hasCachedNarrator(origin: string = globalThis.location?.origin ?? ''): Promise<boolean> {
  const storage = cacheStorage()
  if (!storage) return false
  try {
    if (!(await storage.has(NARRATOR_CACHE_NAME))) return false
    const cache = await storage.open(NARRATOR_CACHE_NAME)
    const stored = new Set((await cache.keys()).map(request => request.url))
    return NARRATOR_FILES.every(file => stored.has(narratorFileUrl(file.path, origin)))
  } catch { return false }
}

/** Delete voice caches from earlier model versions, keeping the current one. */
export async function removeOldNarratorCaches(): Promise<void> {
  const storage = cacheStorage()
  if (!storage) return
  try {
    for (const name of await storage.keys()) {
      if (name.startsWith(NARRATOR_CACHE_PREFIX) && name !== NARRATOR_CACHE_NAME) await storage.delete(name)
    }
  } catch { /* best effort */ }
}

/** Remove every stored voice file, current and old. */
export async function removeNarratorCaches(): Promise<void> {
  const storage = cacheStorage()
  if (!storage) return
  try {
    for (const name of await storage.keys()) if (name.startsWith(NARRATOR_CACHE_PREFIX)) await storage.delete(name)
  } catch { /* best effort */ }
}

/** Ask the browser not to evict site storage under pressure. Best effort; some browsers decide silently. */
export async function requestPersistentStorage(): Promise<boolean> {
  try { return (await navigator.storage?.persist?.()) ?? false } catch { return false }
}

export interface LoadOptions {
  /** When false, a file missing from the cache fails with NOT_CACHED instead of downloading. */
  allowNetwork: boolean
  /** Called once for each file that had to come from the network. */
  onNetwork?: (url: string) => void
  fetcher?: Fetcher
}

export async function sha256Matches(buffer: ArrayBuffer, pin: AssetPins): Promise<boolean> {
  return buffer.byteLength === pin.bytes && await sha256Hex(buffer) === pin.sha256
}

/**
 * Return the pinned bytes for one file: from the device cache when present and
 * intact, otherwise (if allowed) from the network, storing them only after they
 * pass verification.
 */
export async function loadVerified(url: string, pin: AssetPins, options: LoadOptions): Promise<ArrayBuffer> {
  const cache = await openCache()
  if (cache) {
    try {
      const hit = await cache.match(url)
      if (hit) {
        const buffer = await hit.arrayBuffer()
        if (await sha256Matches(buffer, pin)) return buffer
        await cache.delete(url)
      }
    } catch { /* fall through to the network */ }
  }
  if (!options.allowNetwork) throw Error('NOT_CACHED')
  const buffer = await fetchVerified(url, pin, options.fetcher)
  options.onNetwork?.(url)
  if (cache) {
    try {
      await cache.put(url, new Response(buffer, { headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(buffer.byteLength) } }))
    } catch { /* quota or private mode: the voice still works for this visit */ }
  }
  return buffer
}
