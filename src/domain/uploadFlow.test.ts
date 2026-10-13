import { describe, expect, it } from 'vitest'
import { uploadDocument, type UploadDeps, type UploadEventDetails } from './uploadFlow'
import { classifyUploadFailure, UPLOAD_MESSAGES, type UploadPhase } from '../pdf/uploadFailure'
import type { CurrentDocumentRecord } from './currentDocumentStore'
import type { EventName } from '../diagnostics/schema'

const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a]).buffer
const NOT_PDF_BYTES = new Uint8Array([0x68, 0x65, 0x6c, 0x6c, 0x6f]).buffer
const EMPTY_BYTES = new ArrayBuffer(0)
const named = (name: string) => Object.assign(new Error('PRIVATE detail'), { name })
const record = (): CurrentDocumentRecord => ({
  schemaVersion: 2, id: 'fixture', name: 'fixture.pdf', size: 9, lastModified: 1,
  mimeType: 'application/pdf', bytes: PDF_BYTES, reader: { currentPage: 1, zoom: 100, speed: 1, readScope: 'document' },
  voicePlan: null,
})

interface HarnessOptions {
  bytes?: ArrayBuffer
  size?: number
  readError?: unknown
  validateError?: unknown
  replaceError?: unknown
  activateError?: unknown
}
function harness(options: HarnessOptions = {}) {
  const bytes = options.bytes ?? PDF_BYTES
  const size = options.size ?? bytes.byteLength
  const events: { event: EventName; details?: UploadEventDetails }[] = []
  const phases: UploadPhase[] = []
  const calls = { replaced: 0, activated: 0 }
  const deps: UploadDeps<{ numPages: number }> = {
    readBytes: async () => {
      if (options.readError !== undefined) throw options.readError
      return bytes
    },
    buildRecord: () => record(),
    validate: async () => {
      if (options.validateError !== undefined) throw options.validateError
      return { numPages: 2 }
    },
    validateAndReplace: async (target, validate) => {
      // Mirrors the store: validation first, and only then the replacement.
      const document = await validate(target.bytes.slice(0))
      if (options.replaceError !== undefined) throw options.replaceError
      calls.replaced++
      return document
    },
    activate: async () => {
      if (options.activateError !== undefined) throw options.activateError
      calls.activated++
    },
    numPages: (document) => document.numPages,
    record: (event, details) => { events.push({ event, details }) },
    classify: (error: unknown, phase: UploadPhase) => {
      phases.push(phase)
      return classifyUploadFailure(error, phase)
    },
    now: () => 0,
  }
  return {
    events, phases, calls,
    run: () => uploadDocument<{ numPages: number }>({ name: 'fixture.pdf', size, lastModified: 1, type: 'application/pdf' } as unknown as File, deps),
    names: () => events.map(entry => entry.event),
  }
}

describe('upload flow reporting', () => {
  it('reports a stored document only after validation and replacement both succeed', async () => {
    const flow = harness()
    expect(await flow.run()).toBeNull()
    expect(flow.names()).toEqual(['upload.start', 'upload.validated', 'upload.replaced'])
    expect(flow.events[1].details?.count).toBe(2)
    expect(flow.calls).toEqual({ replaced: 1, activated: 1 })
  })

  it('keeps the stored document untouched for every failure before the replacement', async () => {
    // `consulted` marks the cases that reach the injected classifier. A file that cannot be
    // read, and the preflight checks, never load the parser at all.
    const cases: [string, HarnessOptions, keyof typeof UPLOAD_MESSAGES, UploadPhase, boolean][] = [
      ['a file the browser cannot read', { readError: new Error('PRIVATE') }, 'file-unreadable', 'read', false],
      ['a file that is not a PDF', { bytes: NOT_PDF_BYTES }, 'file-not-pdf', 'read', false],
      ['an empty file', { bytes: EMPTY_BYTES }, 'file-empty', 'read', false],
      ['a placeholder that yields no bytes', { bytes: EMPTY_BYTES, size: 4096 }, 'file-unreadable', 'read', false],
      ['a password protected PDF', { validateError: named('PasswordException') }, 'pdf-password', 'validate', true],
      ['a damaged PDF', { validateError: named('InvalidPDFException') }, 'pdf-damaged', 'validate', true],
      ['an unclassifiable parser failure', { validateError: new Error('PRIVATE') }, 'pdf-unopened', 'validate', true],
      ['no room left in storage', { replaceError: new DOMException('PRIVATE', 'QuotaExceededError') }, 'storage-full', 'replace', true],
      ['a storage write failure', { replaceError: new DOMException('PRIVATE', 'UnknownError') }, 'storage-save', 'replace', true],
    ]
    for (const [label, options, code, phase, consulted] of cases) {
      const flow = harness(options)
      const failure = await flow.run()
      expect(failure?.code, label).toBe(code)
      expect(failure?.message, label).toBe(UPLOAD_MESSAGES[code])
      // The claim the old code always made must now actually be true here.
      expect(failure?.replaced, label).toBe(false)
      expect(failure?.message, label).toContain('was not changed')
      // Nothing may be written to storage, and nothing may be activated.
      expect(flow.calls, label).toEqual({ replaced: 0, activated: 0 })
      expect(flow.names(), label).toEqual(['upload.start', 'upload.fail'])
      expect(flow.events[1].details?.errorCode, label).toBe(code)
      expect(flow.phases, label).toEqual(consulted ? [phase] : [])
    }
  })

  it('tells the truth when the failure comes after a successful replacement', async () => {
    const flow = harness({ activateError: new Error('PRIVATE') })
    const failure = await flow.run()
    expect(failure?.code).toBe('document-open')
    // The document really was replaced, so this failure must say so.
    expect(flow.calls.replaced).toBe(1)
    expect(failure?.replaced).toBe(true)
    expect(failure?.message).toBe(UPLOAD_MESSAGES['document-open'])
    expect(failure?.message).toContain('was saved')
    expect(failure?.message).not.toContain('was not changed')
    expect(failure?.message).toContain('Open the file again')
    // The replacement is recorded before the failure, so the log shows what really happened.
    expect(flow.names()).toEqual(['upload.start', 'upload.validated', 'upload.replaced', 'upload.fail'])
    expect(flow.events[3].details?.errorCode).toBe('document-open')
    expect(flow.phases).toEqual(['open'])
  })

  it('records how long each failure took and no cause text', async () => {
    const flow = harness({ validateError: new Error('PRIVATE detail https://secret') })
    await flow.run()
    const failed = flow.events.find(entry => entry.event === 'upload.fail')
    const serialized = JSON.stringify(flow.events)
    expect(serialized).not.toContain('PRIVATE')
    expect(serialized).not.toContain('secret')
    expect(failed?.details?.durationMs).toBe(0)
    expect(Object.keys(failed?.details ?? {}).sort()).toEqual(['durationMs', 'errorCode'])
  })

  it('places the same error in the phase the code actually reached', async () => {
    // The identical error is a storage failure after the replace and a validation failure
    // before it, and only the phase decides which sentence the reader sees.
    const before = harness({ validateError: new DOMException('PRIVATE', 'QuotaExceededError') })
    const after = harness({ replaceError: new DOMException('PRIVATE', 'QuotaExceededError') })
    expect((await before.run())?.code).toBe('storage-full')
    expect((await after.run())?.code).toBe('storage-full')
    expect(before.phases).toEqual(['validate'])
    expect(after.phases).toEqual(['replace'])
  })
})
