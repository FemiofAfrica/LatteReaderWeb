import type { DocumentVoicePlan } from './analysis'
import type { ReadScope } from './playback'

export const CURRENT_SCHEMA_VERSION = 2

export interface PersistedReaderState {
  currentPage: number
  /** Last spoken page, independent of the browsed page. Never auto-start on restore. */
  readingPage?: number
  zoom: number
  speed: number
  /** Stable browser voice identity, never a list index. */
  voiceKey?: string
  readScope: ReadScope
}

export interface CurrentDocumentRecord {
  schemaVersion: typeof CURRENT_SCHEMA_VERSION
  id: string
  name: string
  size: number
  lastModified: number
  mimeType: string
  bytes: ArrayBuffer
  reader: PersistedReaderState
  voicePlan: DocumentVoicePlan | null
}

// Schema 1 stored `readScope: 'page'` as its default, which is the old page-by-page
// behaviour. Migrating to schema 2 lifts every stored document to continuous reading.
interface LegacyCurrentDocumentRecordV1 extends Omit<CurrentDocumentRecord, 'schemaVersion'> {
  schemaVersion: 1
}

const DATABASE_NAME = 'latte-reader-local'
const STORE_NAME = 'current-document'
const CURRENT_KEY = 'current'

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('Browser storage request failed.'))
  })
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onabort = () => reject(transaction.error ?? new Error('Browser storage transaction was cancelled.'))
    transaction.onerror = () => reject(transaction.error ?? new Error('Browser storage transaction failed.'))
  })
}

async function openDatabase(): Promise<IDBDatabase> {
  const request = indexedDB.open(DATABASE_NAME, 1)
  request.onupgradeneeded = () => {
    if (!request.result.objectStoreNames.contains(STORE_NAME)) {
      request.result.createObjectStore(STORE_NAME)
    }
  }
  return requestResult(request)
}

/**
 * Reads any previously stored record into the current schema. A schema-1 record keeps its
 * position, zoom, speed and voice plan but its reading scope becomes continuous, so a
 * document stored before this change no longer restarts in page-only mode.
 */
export function migrateCurrentDocument(record: unknown): CurrentDocumentRecord | null {
  if (!record || typeof record !== 'object') return null
  const candidate = record as { schemaVersion?: unknown }
  if (candidate.schemaVersion === CURRENT_SCHEMA_VERSION) return record as CurrentDocumentRecord
  if (candidate.schemaVersion === 1) {
    const legacy = record as LegacyCurrentDocumentRecordV1
    return {
      ...legacy,
      schemaVersion: CURRENT_SCHEMA_VERSION,
      reader: { ...legacy.reader, readScope: 'document' },
    }
  }
  return null
}

export async function loadCurrentDocument(): Promise<CurrentDocumentRecord | null> {
  const database = await openDatabase()
  try {
    const transaction = database.transaction(STORE_NAME, 'readonly')
    const result = await requestResult(transaction.objectStore(STORE_NAME).get(CURRENT_KEY))
    await transactionDone(transaction)
    return migrateCurrentDocument(result)
  } finally {
    database.close()
  }
}

export async function replaceCurrentDocument(record: CurrentDocumentRecord): Promise<void> {
  const database = await openDatabase()
  try {
    const transaction = database.transaction(STORE_NAME, 'readwrite')
    const store = transaction.objectStore(STORE_NAME)
    store.clear()
    store.put(record, CURRENT_KEY)
    await transactionDone(transaction)
  } finally {
    database.close()
  }
}

export async function validateAndReplaceCurrentDocument<T>(
  record: CurrentDocumentRecord,
  validate: (bytes: ArrayBuffer) => Promise<T>,
): Promise<T> {
  const validated = await validate(record.bytes.slice(0))
  await replaceCurrentDocument(record)
  return validated
}

export async function updateCurrentDocument(
  update: Partial<Pick<CurrentDocumentRecord, 'reader' | 'voicePlan'>>,
  expectedDocumentId?: string,
): Promise<void> {
  const database = await openDatabase()
  try {
    const transaction = database.transaction(STORE_NAME, 'readwrite')
    const store = transaction.objectStore(STORE_NAME)
    const current = migrateCurrentDocument(await requestResult(store.get(CURRENT_KEY)))
    if (current && (!expectedDocumentId || current.id === expectedDocumentId)) store.put({ ...current, ...update }, CURRENT_KEY)
    await transactionDone(transaction)
  } finally {
    database.close()
  }
}

export async function clearCurrentDocument(): Promise<void> {
  const database = await openDatabase()
  try {
    const transaction = database.transaction(STORE_NAME, 'readwrite')
    transaction.objectStore(STORE_NAME).clear()
    await transactionDone(transaction)
  } finally {
    database.close()
  }
}

export async function deleteCurrentDocumentDatabase(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DATABASE_NAME)
    request.onsuccess = () => resolve()
    request.onerror = () => reject(request.error)
    request.onblocked = () => reject(new Error('Browser storage database is still open.'))
  })
}
