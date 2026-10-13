// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { ERROR_CODES, validateEvent, APP_VERSION } from '../diagnostics/schema'
import {
  UPLOAD_MESSAGES,
  UPLOAD_REASON_CODES,
  classifyUploadFailure,
  hasPdfHeader,
  preflightFailure,
  type UploadFacts,
} from './uploadFailure'

function fixture(name: string): ArrayBuffer {
  const buffer = readFileSync(new URL(`../../tests/fixtures/${name}`, import.meta.url))
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer
}
function factsOf(bytes: ArrayBuffer, fileSize = bytes.byteLength): UploadFacts {
  return { fileSize, byteLength: bytes.byteLength, hasPdfHeader: hasPdfHeader(bytes) }
}
// Names stand in for the PDF.js classes this build does not export; the injected classes
// exercise the same instanceof branch the real parser takes.
class FakePassword extends Error {}
class FakeInvalid extends Error {}
class FakeResponse extends Error {}
const pdfClasses = { password: FakePassword, invalid: FakeInvalid, response: FakeResponse }
const named = (name: string, message = 'PRIVATE detail') => Object.assign(new Error(message), { name })

describe('upload failure diagnosis', () => {
  it('accepts a real PDF whose header sits inside the first 1024 bytes', () => {
    const bytes = fixture('latte-reader-valid-marker.pdf')
    const header = Buffer.from(new Uint8Array(bytes, 0, 1024)).indexOf('%PDF-')
    expect(header).toBeGreaterThan(0)
    expect(header).toBeLessThan(1024)
    expect(hasPdfHeader(bytes)).toBe(true)
    expect(preflightFailure(factsOf(bytes))).toBeNull()
  })

  it('accepts the plain valid fixtures', () => {
    for (const name of ['latte-reader-text-fixture.pdf', 'latte-reader-long-text-fixture.pdf']) {
      const bytes = fixture(name)
      expect(hasPdfHeader(bytes), name).toBe(true)
      expect(preflightFailure(factsOf(bytes)), name).toBeNull()
    }
  })

  it('names a file with no PDF header as not a PDF', () => {
    const failure = preflightFailure(factsOf(fixture('latte-reader-not-a-pdf.txt')))
    expect(failure?.code).toBe('file-not-pdf')
    expect(failure?.message).toBe('That file is not a PDF, so your saved document was not changed.')
    expect(failure?.replaced).toBe(false)
  })

  it('names an empty file as empty', () => {
    const failure = preflightFailure(factsOf(fixture('latte-reader-empty.pdf')))
    expect(failure?.code).toBe('file-empty')
    expect(failure?.message).toBe('That file is empty, so your saved document was not changed.')
  })

  it('names a file that reports bytes it cannot produce as unreadable', () => {
    // A cloud placeholder that has not downloaded reports a size but yields nothing.
    const failure = preflightFailure({ fileSize: 4096, byteLength: 0, hasPdfHeader: false })
    expect(failure?.code).toBe('file-unreadable')
    expect(failure?.message).toContain('could not be read from where it lives')
    expect(failure?.message).toContain('was not changed')
  })

  it('lets a truncated PDF reach the parser and reports it as damaged', () => {
    const bytes = fixture('latte-reader-truncated.pdf')
    expect(hasPdfHeader(bytes)).toBe(true)
    expect(preflightFailure(factsOf(bytes))).toBeNull()
    const failure = classifyUploadFailure(named('InvalidPDFException'), 'validate', pdfClasses)
    expect(failure.code).toBe('pdf-damaged')
    expect(failure.message).toBe('That PDF is damaged or incomplete, so your saved document was not changed.')
  })

  it('reports a password protected PDF as locked', () => {
    const bytes = fixture('latte-reader-password.pdf')
    expect(hasPdfHeader(bytes)).toBe(true)
    expect(preflightFailure(factsOf(bytes))).toBeNull()
    expect(classifyUploadFailure(new FakePassword('PRIVATE'), 'validate', pdfClasses).code).toBe('pdf-password')
    expect(classifyUploadFailure(named('PasswordException'), 'validate', pdfClasses).message)
      .toBe('That PDF is locked with a password, so your saved document was not changed. Unlock it and try again.')
  })

  it('classifies by error type and never by message text', () => {
    // The message claims one thing; the type decides. Messages are never inspected.
    const misleading = new FakeInvalid('That file is not a readable PDF')
    expect(classifyUploadFailure(misleading, 'validate', pdfClasses).code).toBe('pdf-damaged')
    const textOnly = new Error('PasswordException: no password given, this is a damaged file')
    expect(classifyUploadFailure(textOnly, 'validate', pdfClasses).code).toBe('pdf-unopened')
    expect(classifyUploadFailure(new FakeResponse('PRIVATE'), 'validate', pdfClasses).code).toBe('file-unreadable')
  })

  it('separates running out of room from a plain storage failure', () => {
    const quota = new DOMException('PRIVATE detail', 'QuotaExceededError')
    expect(classifyUploadFailure(quota, 'replace', pdfClasses).code).toBe('storage-full')
    expect(classifyUploadFailure(new DOMException('PRIVATE', 'UnknownError'), 'replace', pdfClasses).code).toBe('storage-save')
    expect(classifyUploadFailure(new DOMException('PRIVATE', 'AbortError'), 'validate', pdfClasses).code).toBe('storage-save')
  })

  it('reports a file that could not be read at all as unreadable', () => {
    expect(classifyUploadFailure(new Error('PRIVATE'), 'read', pdfClasses).code).toBe('file-unreadable')
  })

  it('reports a failure after the replacement as replaced, never as unchanged', () => {
    for (const error of [null, new Error('PRIVATE'), new FakeInvalid('PRIVATE')]) {
      const failure = classifyUploadFailure(error, 'open', pdfClasses)
      expect(failure.code).toBe('document-open')
      expect(failure.replaced).toBe(true)
      expect(failure.message).toContain('was saved')
      expect(failure.message).not.toContain('was not changed')
      expect(failure.message).toContain('Open the file again')
    }
  })

  it('keeps every pre-replacement message honest about the saved document', () => {
    const produced = [
      preflightFailure({ fileSize: 10, byteLength: 0, hasPdfHeader: false }),
      preflightFailure({ fileSize: 0, byteLength: 0, hasPdfHeader: false }),
      preflightFailure({ fileSize: 10, byteLength: 10, hasPdfHeader: false }),
      classifyUploadFailure(new DOMException('PRIVATE', 'QuotaExceededError'), 'replace', pdfClasses),
      classifyUploadFailure(new DOMException('PRIVATE', 'UnknownError'), 'replace', pdfClasses),
      classifyUploadFailure(null, 'read', pdfClasses),
      classifyUploadFailure(named('PasswordException'), 'validate', pdfClasses),
      classifyUploadFailure(named('InvalidPDFException'), 'validate', pdfClasses),
      classifyUploadFailure(new Error('PRIVATE'), 'validate', pdfClasses),
    ]
    for (const failure of produced) {
      expect(failure?.replaced).toBe(false)
      expect(failure?.message).toContain('was not changed')
      expect(failure?.message).not.toContain('was saved')
    }
  })

  it('gives every reason code a short plain message and allows all of them in diagnostics', () => {
    expect(Object.keys(UPLOAD_MESSAGES).sort()).toEqual([...UPLOAD_REASON_CODES].sort())
    for (const code of UPLOAD_REASON_CODES) {
      const message = UPLOAD_MESSAGES[code]
      expect(message.length, code).toBeGreaterThan(10)
      expect(message.length, code).toBeLessThanOrEqual(200)
      expect(code, message).not.toContain('\u2014')
      expect(code, message).not.toContain('PDF.js')
    }
    // The classifiers hand back exactly the published copy, never a message of their own.
    expect(classifyUploadFailure(null, 'open', pdfClasses).message).toBe(UPLOAD_MESSAGES['document-open'])
    expect(preflightFailure({ fileSize: 1, byteLength: 1, hasPdfHeader: false })?.message).toBe(UPLOAD_MESSAGES['file-not-pdf'])
    // Every code a failure can carry must be storable in the diagnostics allowlist.
    for (const code of UPLOAD_REASON_CODES) {
      expect(ERROR_CODES, code).toContain(code)
      expect(validateEvent({
        timestamp: new Date().toISOString(), sessionId: crypto.randomUUID(), version: APP_VERSION,
        event: 'upload.fail', severity: 'error', errorCode: code,
      }), code).toBe(true)
    }
  })

  it('still reads the coarse code written before the split', () => {
    expect(validateEvent({
      timestamp: new Date().toISOString(), sessionId: crypto.randomUUID(), version: APP_VERSION,
      event: 'upload.fail', severity: 'error', errorCode: 'pdf',
    })).toBe(true)
  })
})
