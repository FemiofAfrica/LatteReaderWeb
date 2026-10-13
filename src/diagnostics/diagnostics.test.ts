import { afterEach, describe, expect, it, vi } from 'vitest'
import { APP_VERSION, classifyError, validateEvent, type DiagnosticEvent } from './schema'
import { BUFFER_LIMIT, DiagnosticBuffer, diagnostics, recordEvent, transportEnabled } from './diagnostics'
const entry = (): DiagnosticEvent => ({ timestamp: new Date().toISOString(), sessionId: crypto.randomUUID(), version: APP_VERSION, event: 'session.start', severity: 'info' })
afterEach(() => { diagnostics.clear(); document.head.innerHTML = ''; vi.unstubAllGlobals() })
describe('content-free diagnostics', () => {
  it('retains only the last bounded events and exports copies', () => {
    const buffer = new DiagnosticBuffer()
    for (let i = 0; i < BUFFER_LIMIT + 10; i++) buffer.add({ ...entry(), event: 'extraction.start', count: i })
    expect(buffer.snapshot()).toHaveLength(BUFFER_LIMIT)
    expect(buffer.snapshot()[0].count).toBe(10)
    buffer.snapshot()[0].count = 99
    expect(buffer.snapshot()[0].count).toBe(10)
    buffer.clear(); expect(buffer.snapshot()).toEqual([])
  })
  it('rejects all sensitive and unknown fields server-side', () => {
    for (const field of ['filename', 'text', 'selection', 'bytes', 'speaker', 'plan', 'hash', 'credentials', 'storage', 'stack', 'url', 'message']) {
      expect(validateEvent({ ...entry(), [field]: 'PRIVATE' })).toBe(false)
    }
    expect(validateEvent({ ...entry(), event: 'PRIVATE' })).toBe(false)
    expect(validateEvent({ ...entry(), errorCode: 'PRIVATE' })).toBe(false)
    expect(validateEvent({ ...entry(), sessionId: 'PRIVATE' })).toBe(false)
    expect(validateEvent({ ...entry(), count: Infinity })).toBe(false)
  })
  it('client picks only safe fields, never messages or stacks', () => {
    recordEvent('renderer.fail', { page: 1, text: 'PRIVATE', stack: 'PRIVATE', filename: 'PRIVATE', errorCode: classifyError(new TypeError('PRIVATE https://secret/?password=PRIVATE')) } as never)
    const output = JSON.stringify(diagnostics.snapshot())
    expect(output).not.toContain('PRIVATE')
    expect(diagnostics.snapshot()[0].errorCode).toBe('type')
    expect(classifyError({ name: 'PRIVATE', message: 'PRIVATE', stack: 'PRIVATE' })).toBe('unknown')
  })
  it('static production does not contact telemetry without explicit private marker', () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch)
    expect(transportEnabled()).toBe(false)
    recordEvent('session.start')
    expect(fetch).not.toHaveBeenCalled()
    document.head.innerHTML = '<meta name="latte-private-diagnostics" content="enabled">'
    expect(transportEnabled()).toBe(true)
  })
})
