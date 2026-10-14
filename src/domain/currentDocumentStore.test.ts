import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CURRENT_SCHEMA_VERSION,
  deleteCurrentDocumentDatabase,
  loadCurrentDocument,
  migrateCurrentDocument,
  replaceCurrentDocument,
  updateCurrentDocument,
  validateAndReplaceCurrentDocument,
  type CurrentDocumentRecord,
} from './currentDocumentStore'

const record = (id: string, text: string): CurrentDocumentRecord => ({
  schemaVersion: CURRENT_SCHEMA_VERSION,
  id,
  name: `${id}.pdf`,
  size: text.length,
  lastModified: 1,
  mimeType: 'application/pdf',
  bytes: new TextEncoder().encode(text).buffer,
  reader: { currentPage: 2, zoom: 120, speed: 1.25, readScope: 'document' },
  voicePlan: {
    schemaVersion: 1,
    documentId: id,
    documentName: `${id}.pdf`,
    profiles: [],
    segments: [],
  },
})

afterEach(() => deleteCurrentDocumentDatabase())

describe('one-slot current document storage', () => {
  it('keeps spoken and browsed positions separate and ignores an old document save', async () => {
    await replaceCurrentDocument(record('current', '%PDF current'))
    const reader = { currentPage: 3, readingPage: 2, zoom: 100, speed: 1, readScope: 'document' as const }
    await updateCurrentDocument({ reader }, 'current')
    expect((await loadCurrentDocument())?.reader).toEqual(reader)
    await updateCurrentDocument({ reader: { ...reader, currentPage: 9 } }, 'previous')
    expect((await loadCurrentDocument())?.reader).toEqual(reader)
  })
  it('restores PDF bytes, voice plan, settings, and reading position after reload', async () => {
    await replaceCurrentDocument(record('first', '%PDF first'))
    const restored = await loadCurrentDocument()

    expect(restored).toMatchObject({
      id: 'first',
      reader: { currentPage: 2, zoom: 120, speed: 1.25, readScope: 'document' },
      voicePlan: { documentId: 'first' },
    })
    expect(new TextDecoder().decode(restored?.bytes)).toBe('%PDF first')
  })

  it('atomically replaces the previous PDF and all document-specific data', async () => {
    await replaceCurrentDocument(record('first', '%PDF first'))
    await replaceCurrentDocument({
      ...record('second', '%PDF second'),
      reader: { currentPage: 1, zoom: 100, speed: 1, readScope: 'page' },
      voicePlan: null,
    })

    const restored = await loadCurrentDocument()
    expect(restored?.id).toBe('second')
    expect(restored?.voicePlan).toBeNull()
    // A record already written in the current schema keeps the scope the reader chose.
    expect(restored?.reader.readScope).toBe('page')
    expect(new TextDecoder().decode(restored?.bytes)).toBe('%PDF second')
  })

  it('preserves the working PDF when validation of a new upload fails', async () => {
    await replaceCurrentDocument(record('working', '%PDF working'))

    await expect(validateAndReplaceCurrentDocument(
      record('invalid', 'not a pdf'),
      async () => { throw new Error('Invalid PDF') },
    )).rejects.toThrow('Invalid PDF')

    const restored = await loadCurrentDocument()
    expect(restored?.id).toBe('working')
    expect(new TextDecoder().decode(restored?.bytes)).toBe('%PDF working')
  })
})

describe('reading scope migration', () => {
  it('lifts a stored page-only document to continuous reading on load', async () => {
    // A document written before this change: schema 1 with the old page-only default.
    const legacy = {
      ...record('legacy', '%PDF legacy'),
      schemaVersion: 1,
      reader: { currentPage: 3, zoom: 110, speed: 1, readScope: 'page' },
    }
    await replaceCurrentDocument(legacy as unknown as CurrentDocumentRecord)

    const restored = await loadCurrentDocument()
    expect(restored?.schemaVersion).toBe(CURRENT_SCHEMA_VERSION)
    expect(restored?.reader.readScope).toBe('document')
    // The rest of the stored state is untouched.
    expect(restored?.reader.currentPage).toBe(3)
    expect(restored?.reader.zoom).toBe(110)
    expect(new TextDecoder().decode(restored?.bytes)).toBe('%PDF legacy')
  })

  it('upgrades the stored record in place when the reader position is updated', async () => {
    const legacy = {
      ...record('upgrade', '%PDF upgrade'),
      schemaVersion: 1,
      reader: { currentPage: 1, zoom: 100, speed: 1, readScope: 'page' },
    }
    await replaceCurrentDocument(legacy as unknown as CurrentDocumentRecord)

    await updateCurrentDocument({ reader: { currentPage: 4, zoom: 100, speed: 1, readScope: 'document' } })

    const restored = await loadCurrentDocument()
    expect(restored?.schemaVersion).toBe(CURRENT_SCHEMA_VERSION)
    expect(restored?.reader.currentPage).toBe(4)
    expect(restored?.reader.readScope).toBe('document')
  })

  it('ignores unknown or corrupt records instead of restoring them', () => {
    expect(migrateCurrentDocument(null)).toBeNull()
    expect(migrateCurrentDocument('nonsense')).toBeNull()
    expect(migrateCurrentDocument({ schemaVersion: 99 })).toBeNull()
    expect(migrateCurrentDocument(undefined)).toBeNull()
  })
})
