import { afterEach, describe, expect, it, vi } from 'vitest'
import { APP_VERSION, classifyError, validateEvent, type DiagnosticEvent } from './schema'
import { BUFFER_LIMIT, DiagnosticBuffer, diagnostics, isTransportEvent, recordEvent, transportEnabled } from './diagnostics'
const entry = (): DiagnosticEvent => ({ timestamp: new Date().toISOString(), sessionId: crypto.randomUUID(), version: APP_VERSION, event: 'session.start', severity: 'info' })
afterEach(() => { diagnostics.clear(); document.head.innerHTML = ''; vi.unstubAllGlobals(); vi.useRealTimers() })
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
    for (const field of ['filename', 'text', 'selection', 'bytes', 'speaker', 'plan', 'hash', 'credentials', 'storage', 'stack', 'url', 'message', 'reason']) {
      expect(validateEvent({ ...entry(), [field]: 'PRIVATE' })).toBe(false)
    }
    expect(validateEvent({ ...entry(), event: 'PRIVATE' })).toBe(false)
    expect(validateEvent({ ...entry(), errorCode: 'PRIVATE' })).toBe(false)
    expect(validateEvent({ ...entry(), sessionId: 'PRIVATE' })).toBe(false)
    expect(validateEvent({ ...entry(), count: Infinity })).toBe(false)
  })
  it('accepts only well-formed transport lifecycle events', () => {
    expect(validateEvent({ ...entry(), event: 'transport.fail', severity: 'error', errorCode: 'network' })).toBe(true)
    expect(validateEvent({ ...entry(), event: 'transport.recover', severity: 'info' })).toBe(true)
    expect(validateEvent({ ...entry(), event: 'transport.recover', severity: 'info', errorCode: 'network' })).toBe(false)
    expect(validateEvent({ ...entry(), event: 'transport.fail', severity: 'info', errorCode: 'network' })).toBe(false)
    expect(validateEvent({ ...entry(), event: 'transport.fail', severity: 'error', errorCode: 'PRIVATE' })).toBe(false)
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
  it('exposes a truthful transport state and content-free failure reasons', async () => {
    vi.useFakeTimers()
    document.head.innerHTML = '<meta name="latte-private-diagnostics" content="enabled">'
    const ok = vi.fn(async () => ({ ok: true, status: 204 }))
    vi.stubGlobal('fetch', ok)
    recordEvent('session.start')
    await vi.advanceTimersByTimeAsync(300)
    expect(diagnostics.status()).toBe('private live')
    expect(diagnostics.transport().lastSuccessAt).toBeGreaterThan(0)

    const fail = vi.fn(async () => { throw new TypeError('PRIVATE network detail https://secret') })
    vi.stubGlobal('fetch', fail)
    recordEvent('window.error', { errorCode: 'unknown' })
    await vi.advanceTimersByTimeAsync(300)
    expect(diagnostics.status()).toBe('live retrying')
    expect(diagnostics.transport().consecutiveFailures).toBe(1)
    expect(diagnostics.transport().reason).toBe('network')
    const failures = diagnostics.snapshot().filter(e => e.event === 'transport.fail')
    expect(failures).toHaveLength(1)
    expect(JSON.stringify(failures)).not.toContain('PRIVATE')
    expect(failures[0].errorCode).toBe('network')
    expect(failures[0].severity).toBe('error')

    for (let i = 0; i < 8; i++) { recordEvent('window.error', { errorCode: 'unknown' }); await vi.advanceTimersByTimeAsync(4000) }
    expect(diagnostics.transport().consecutiveFailures).toBeGreaterThanOrEqual(5)
    expect(diagnostics.status()).toBe('live unavailable')

    vi.stubGlobal('fetch', ok)
    recordEvent('session.start')
    await vi.advanceTimersByTimeAsync(4000)
    expect(diagnostics.status()).toBe('private live')
    expect(diagnostics.transport().consecutiveFailures).toBe(0)
    expect(diagnostics.snapshot().some(e => e.event === 'transport.recover')).toBe(true)
  })
  it('never latches a permanent failure state after a successful send', async () => {
    vi.useFakeTimers()
    document.head.innerHTML = '<meta name="latte-private-diagnostics" content="enabled">'
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('PRIVATE') }))
    recordEvent('session.start')
    await vi.advanceTimersByTimeAsync(300)
    expect(['live retrying', 'live unavailable']).toContain(diagnostics.status())
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 204 })))
    recordEvent('session.start')
    await vi.advanceTimersByTimeAsync(4000)
    expect(diagnostics.status()).toBe('private live')
  })

  it('treats transport lifecycle events as delivery state, not application errors', () => {
    // A retry hiccup must not be counted as an application failure during triage.
    expect(isTransportEvent('transport.fail')).toBe(true)
    expect(isTransportEvent('transport.recover')).toBe(true)
    for (const event of ['renderer.fail', 'upload.fail', 'window.error', 'window.rejection', 'speech.error']) {
      expect(isTransportEvent(event)).toBe(false)
    }
  })
})
