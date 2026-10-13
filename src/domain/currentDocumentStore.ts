import type { DocumentVoicePlan } from './analysis'
import type { ReadScope } from './playback'

export interface PersistedReaderState {
  currentPage: number
  zoom: number
  speed: number
  readScope: ReadScope
}

export interface CurrentDocumentRecord {
  schemaVersion: 1
  id: string
  name: string
  size: number
  lastModified: number
  mimeType: string
  bytes: ArrayBuffer
  reader: PersistedReaderState
  voicePlan: DocumentVoicePlan | null
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

export async function loadCurrentDocument(): Promise<CurrentDocumentRecord | null> {
  const database = await openDatabase()
  try {
    const transaction = database.transaction(STORE_NAME, 'readonly')
    const result = await requestResult(transaction.objectStore(STORE_NAME).get(CURRENT_KEY))
    await transactionDone(transaction)
    const record = result as CurrentDocumentRecord | undefined
    return record?.schemaVersion === 1 ? record : null
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
): Promise<void> {
  const database = await openDatabase()
  try {
    const transaction = database.transaction(STORE_NAME, 'readwrite')
    const store = transaction.objectStore(STORE_NAME)
    const current = await requestResult(store.get(CURRENT_KEY)) as CurrentDocumentRecord | undefined
    if (current?.schemaVersion === 1) store.put({ ...current, ...update }, CURRENT_KEY)
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
