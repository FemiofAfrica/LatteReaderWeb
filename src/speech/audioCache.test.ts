import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it } from 'vitest'
import { AudioCache, deleteAudioCacheDatabase } from './audioCache'
import { cacheId } from './encodedChunk'
import { encodeWav } from './wav'
import type { LocalPart } from './localPlan'

afterEach(() => deleteAudioCacheDatabase())

const part = (start = 0): LocalPart => ({ text: 'Hello.', chunk: 0, start, end: start + 6, page: 1, pageEnd: 1 })

describe('encoded audio cache', () => {
  it('stores a WAV for the session and returns it without regenerating', async () => {
    const cache = new AudioCache()
    const wav = encodeWav(new Float32Array(240), 24000)
    const id = cacheId('doc', 'kitten-micro-jasper', 1, part())
    await cache.put({
      id,
      documentId: 'doc',
      producerId: 'kitten-micro-jasper',
      speed: 1,
      part: part(),
      wav,
      duration: 0.01,
      sampleRate: 24000,
    })
    const hit = await cache.get(id)
    expect(hit?.duration).toBe(0.01)
    expect(new Uint8Array(hit!.wav)).toEqual(new Uint8Array(wav))
    cache.release(id)
    expect(cache.retained).toBe(0)
    expect((await cache.get(id))?.duration).toBe(0.01)
    await cache.clearDocument('doc')
    expect(await cache.get(id)).toBeUndefined()
  })
})
