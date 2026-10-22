/**
 * Session cache of encoded speech. Prepare-whole-document writes here so a later
 * Play in this visit does not synthesise the same passage again. Audio never leaves
 * the device.
 */
import type { EncodedChunk } from './encodedChunk'

export const AUDIO_CACHE_DATABASE = 'latte-reader-audio'
export const AUDIO_CACHE_STORE = 'encoded-chunks'
const AUDIO_CACHE_VERSION = 1

export interface CachedAudio extends EncodedChunk {
  id: string
  documentId: string
  producerId: string
  speed: number
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('Audio cache request failed.'))
  })
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onabort = () => reject(transaction.error ?? new Error('Audio cache transaction was cancelled.'))
    transaction.onerror = () => reject(transaction.error ?? new Error('Audio cache transaction failed.'))
  })
}

async function openDatabase(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return null
  try {
    const request = indexedDB.open(AUDIO_CACHE_DATABASE, AUDIO_CACHE_VERSION)
    request.onupgradeneeded = () => {
      const database = request.result
      if (!database.objectStoreNames.contains(AUDIO_CACHE_STORE)) {
        const store = database.createObjectStore(AUDIO_CACHE_STORE, { keyPath: 'id' })
        store.createIndex('documentId', 'documentId', { unique: false })
      }
    }
    return await requestResult(request)
  } catch {
    return null
  }
}

export class AudioCache {
  private memory = new Map<string, CachedAudio>()

  peek(id: string): EncodedChunk | undefined {
    const hit = this.memory.get(id)
    return hit?.wav.byteLength ? hit : undefined
  }

  async get(id: string): Promise<EncodedChunk | undefined> {
    const memory = this.peek(id)
    if (memory) return memory
    const database = await openDatabase()
    if (!database) return undefined
    try {
      const transaction = database.transaction(AUDIO_CACHE_STORE, 'readonly')
      const stored = await requestResult(transaction.objectStore(AUDIO_CACHE_STORE).get(id)) as CachedAudio | undefined
      await transactionDone(transaction)
      if (!stored?.wav) return undefined
      this.memory.set(id, stored)
      return stored
    } catch {
      return undefined
    } finally {
      database.close()
    }
  }

  async put(record: CachedAudio): Promise<void> {
    this.memory.set(record.id, record)
    const database = await openDatabase()
    if (!database) return
    try {
      const transaction = database.transaction(AUDIO_CACHE_STORE, 'readwrite')
      transaction.objectStore(AUDIO_CACHE_STORE).put(record)
      await transactionDone(transaction)
    } catch {
      /* quota or private mode: memory still holds this visit's audio */
    } finally {
      database.close()
    }
  }

  async clearDocument(documentId: string): Promise<void> {
    for (const [id, record] of this.memory) if (record.documentId === documentId) this.memory.delete(id)
    const database = await openDatabase()
    if (!database) return
    try {
      const transaction = database.transaction(AUDIO_CACHE_STORE, 'readwrite')
      const index = transaction.objectStore(AUDIO_CACHE_STORE).index('documentId')
      const keys = await requestResult(index.getAllKeys(documentId))
      const store = transaction.objectStore(AUDIO_CACHE_STORE)
      for (const key of keys) store.delete(key)
      await transactionDone(transaction)
    } catch {
      /* best effort */
    } finally {
      database.close()
    }
  }

  async clearAll(): Promise<void> {
    this.memory.clear()
    const database = await openDatabase()
    if (!database) return
    try {
      const transaction = database.transaction(AUDIO_CACHE_STORE, 'readwrite')
      transaction.objectStore(AUDIO_CACHE_STORE).clear()
      await transactionDone(transaction)
    } catch {
      /* best effort */
    } finally {
      database.close()
    }
  }
}

export const sharedAudioCache = new AudioCache()

export async function clearAudioCache(): Promise<void> {
  await sharedAudioCache.clearAll()
}

export async function deleteAudioCacheDatabase(): Promise<void> {
  await sharedAudioCache.clearAll()
  if (typeof indexedDB === 'undefined') return
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(AUDIO_CACHE_DATABASE)
    request.onsuccess = () => resolve()
    request.onerror = () => reject(request.error)
    request.onblocked = () => resolve()
  })
}
