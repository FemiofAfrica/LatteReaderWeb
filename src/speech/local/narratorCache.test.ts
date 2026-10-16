import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { sha256Hex } from './assetIntegrity'
import { hasCachedNarrator, loadVerified, NARRATOR_CACHE_NAME, NARRATOR_CACHE_PREFIX, NARRATOR_FILES, narratorFileUrl, removeOldNarratorCaches } from './narratorCache'

class FakeCache {
  store = new Map<string, ArrayBuffer>()
  async match(url: string) { const b = this.store.get(url); return b ? { arrayBuffer: async () => b.slice(0) } : undefined }
  async put(url: string, response: Response) { this.store.set(url, await response.arrayBuffer()) }
  async delete(url: string) { return this.store.delete(url) }
  async keys() { return [...this.store.keys()].map(url => ({ url })) }
}
class FakeStorage {
  caches = new Map<string, FakeCache>()
  async open(name: string) { if (!this.caches.has(name)) this.caches.set(name, new FakeCache()); return this.caches.get(name)! }
  async has(name: string) { return this.caches.has(name) }
  async keys() { return [...this.caches.keys()] }
  async delete(name: string) { return this.caches.delete(name) }
}

let storage: FakeStorage
beforeEach(() => { storage = new FakeStorage(); vi.stubGlobal('caches', storage) })
afterEach(() => vi.unstubAllGlobals())

const bytes = new TextEncoder().encode('voice bytes').buffer as ArrayBuffer
const pin = async () => ({ bytes: bytes.byteLength, sha256: await sha256Hex(bytes) })
const url = 'https://example.test/voice/narrator/jasper.f32'

describe('narrator device cache', () => {
  it('never downloads when the network is not allowed', async () => {
    const fetcher = vi.fn()
    await expect(loadVerified(url, await pin(), { allowNetwork: false, fetcher })).rejects.toThrow('NOT_CACHED')
    expect(fetcher).not.toHaveBeenCalled()
  })
  it('downloads once, stores verified bytes, then serves them with no fetch', async () => {
    const fetcher = vi.fn(async () => ({ ok: true, status: 200, arrayBuffer: async () => bytes.slice(0) }))
    const onNetwork = vi.fn()
    await loadVerified(url, await pin(), { allowNetwork: true, fetcher, onNetwork })
    expect(fetcher).toHaveBeenCalledTimes(1); expect(onNetwork).toHaveBeenCalledTimes(1)
    const again = await loadVerified(url, await pin(), { allowNetwork: false, fetcher, onNetwork })
    expect(new Uint8Array(again)).toEqual(new Uint8Array(bytes))
    expect(fetcher).toHaveBeenCalledTimes(1); expect(onNetwork).toHaveBeenCalledTimes(1)
  })
  it('does not store or use bytes that fail verification', async () => {
    const fetcher = vi.fn(async () => ({ ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode('tampered!!!').buffer }))
    await expect(loadVerified(url, await pin(), { allowNetwork: true, fetcher })).rejects.toThrow('HASH_MISMATCH')
    expect((await storage.open(NARRATOR_CACHE_NAME)).store.size).toBe(0)
    ;(await storage.open(NARRATOR_CACHE_NAME)).store.set(url, new TextEncoder().encode('tampered!!!').buffer as ArrayBuffer)
    await expect(loadVerified(url, await pin(), { allowNetwork: false })).rejects.toThrow('NOT_CACHED')
    expect((await storage.open(NARRATOR_CACHE_NAME)).store.has(url)).toBe(false)
  })
  it('reports ready only when every file is stored, and drops old versions', async () => {
    const origin = 'https://example.test'
    expect(await hasCachedNarrator(origin)).toBe(false)
    const cache = await storage.open(NARRATOR_CACHE_NAME)
    for (const file of NARRATOR_FILES.slice(1)) cache.store.set(narratorFileUrl(file.path, origin), new ArrayBuffer(1))
    expect(await hasCachedNarrator(origin)).toBe(false)
    cache.store.set(narratorFileUrl(NARRATOR_FILES[0].path, origin), new ArrayBuffer(1))
    expect(await hasCachedNarrator(origin)).toBe(true)
    await storage.open(`${NARRATOR_CACHE_PREFIX}oldversion`); await storage.open('unrelated')
    await removeOldNarratorCaches()
    expect(await storage.keys()).toEqual([NARRATOR_CACHE_NAME, 'unrelated'])
  })
})
