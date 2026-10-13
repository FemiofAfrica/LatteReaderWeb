import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it } from 'vitest'
import {
  deleteCurrentDocumentDatabase,
  loadCurrentDocument,
  replaceCurrentDocument,
  validateAndReplaceCurrentDocument,
  type CurrentDocumentRecord,
} from './currentDocumentStore'

const record = (id: string, text: string): CurrentDocumentRecord => ({
  schemaVersion: 1,
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
