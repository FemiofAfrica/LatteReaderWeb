// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import net from 'node:net'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { privateDiagnosticsPlugin, SERVER_LIMIT, PROGRESS_LIMIT, REJECTION_LIMIT } from '../../scripts/privateDiagnosticsPlugin'
import { APP_VERSION, type DiagnosticEvent } from './schema'
import type { ViteDevServer } from 'vite'

describe('private ingestion retention and rejection diagnostics', () => {
  it('protects lifecycle history from progress flooding and records content-free rejections', async () => {
    const directory = mkdtempSync(join(process.env.TMPDIR ?? '/root/.hermes/cache/scratch', 'latte-diagnostics-'))
    const old = process.cwd()
    process.chdir(directory)
    const plugin = privateDiagnosticsPlugin(true)
    const disabled = privateDiagnosticsPlugin(false)
    process.chdir(old)
    let middleware: (req: IncomingMessage, res: ServerResponse, next: () => void) => void
    const hook = plugin.configureServer as (server: ViteDevServer) => void
    hook({ middlewares: { use(fn: typeof middleware) { middleware = fn } } } as unknown as ViteDevServer)
    const server = createServer((req, res) => middleware(req, res, () => { res.statusCode = 404; res.end() }))
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address() as { port: number }
    const origin = `http://127.0.0.1:${address.port}`
    const logFile = join(directory, '.runtime/diagnostics/events.jsonl')
    const rejectFile = join(directory, '.runtime/diagnostics/ingest-rejections.jsonl')
    const sessionId = crypto.randomUUID()
    const progress = (page: number): DiagnosticEvent => ({ timestamp: new Date().toISOString(), sessionId, version: APP_VERSION, event: 'extraction.progress', severity: 'info', page })
    const lifecycle = (event: DiagnosticEvent['event'], extra: Partial<DiagnosticEvent> = {}): DiagnosticEvent => ({ timestamp: new Date().toISOString(), sessionId, version: APP_VERSION, event, severity: /fail$|error$/.test(event) ? 'error' : 'info', ...extra })
    const post = (events: unknown, requestOrigin = origin) => fetch(`${origin}/__latte_diagnostics/events`, { method: 'POST', headers: { Origin: requestOrigin, 'Content-Type': 'application/json' }, body: typeof events === 'string' ? events : JSON.stringify(events) })
    const readLog = () => readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as DiagnosticEvent)
    const readRejections = () => readFileSync(rejectFile, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
    try {
      // A full 341-page extraction's worth of progress, far more than the whole-file limit.
      for (let batch = 0; batch < 41; batch++) {
        const events = Array.from({ length: 25 }, (_, i) => progress(batch * 25 + i))
        expect((await post(events)).status).toBe(204)
      }
      const flooded = readLog()
      expect(flooded.length).toBeLessThanOrEqual(SERVER_LIMIT)
      expect(flooded.filter(e => e.event === 'extraction.progress').length).toBeLessThanOrEqual(PROGRESS_LIMIT)
      // Meaningful lifecycle/failure events must survive later progress floods.
      expect((await post([lifecycle('restore.start'), lifecycle('restore.complete', { count: 341, durationMs: 12 }), lifecycle('extraction.complete', { count: 341, durationMs: 5830 }), lifecycle('extraction.fail', { errorCode: 'worker' }), lifecycle('window.error', { errorCode: 'unknown' })])).status).toBe(204)
      for (let batch = 0; batch < 10; batch++) {
        await post(Array.from({ length: 25 }, (_, i) => progress(1000 + batch * 25 + i)))
      }
      const kept = readLog()
      const names = kept.map(e => e.event)
      for (const name of ['restore.start', 'restore.complete', 'extraction.complete', 'extraction.fail', 'window.error']) {
        expect(names, name).toContain(name)
      }
      expect(kept.filter(e => e.event === 'extraction.progress').length).toBeLessThanOrEqual(PROGRESS_LIMIT)
      expect(kept.length).toBeLessThanOrEqual(SERVER_LIMIT)
      // Oldest progress is evicted first: the newest page is always retained.
      const pages = kept.filter(e => e.event === 'extraction.progress').map(e => e.page as number)
      expect(Math.max(...pages)).toBe(1249)

      // Rejections are recorded server-side as status + fixed reason code only; the log is untouched.
      const before = readFileSync(logFile, 'utf8')
      expect((await post([{ ...progress(1), filename: 'PRIVATE' }])).status).toBe(400)
      expect((await post([{ ...progress(1), event: 'PRIVATE' }])).status).toBe(400)
      expect((await post([progress(1)], 'https://evil.example')).status).toBe(403)
      expect((await post('x'.repeat(17000))).status).toBe(413)
      expect((await fetch(`${origin}/__latte_diagnostics/events`, { method: 'GET' })).status).toBe(403)
      expect((await fetch(`${origin}/__latte_diagnostics/events`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '[]' })).status).toBe(403)
      expect(readFileSync(logFile, 'utf8')).toBe(before)
      // A client that aborts mid-body is the signature of an intermittent connection failure.
      await new Promise<void>(resolve => {
        const socket = net.connect(address.port, '127.0.0.1', () => {
          socket.write(`POST /__latte_diagnostics/events HTTP/1.1\r\nHost: 127.0.0.1:${address.port}\r\nOrigin: ${origin}\r\nContent-Type: application/json\r\nContent-Length: 900\r\n\r\n{"partial":`)
          setTimeout(() => { socket.destroy(); resolve() }, 60)
        })
        socket.on('error', () => resolve())
      })
      await new Promise(r => setTimeout(r, 250))
      const rejections = readRejections()
      const reasons = rejections.map(n => n.reason)
      for (const reason of ['invalid-batch', 'origin', 'too-large', 'method', 'client-abort']) expect(reasons, reason).toContain(reason)
      expect(rejections.every(n => Object.keys(n).every(k => ['timestamp', 'status', 'reason'].includes(k)))).toBe(true)
      expect(rejections.every(n => n.status === null || typeof n.status === 'number')).toBe(true)
      expect(rejections.length).toBeLessThanOrEqual(REJECTION_LIMIT)
      const rawRejections = readFileSync(rejectFile, 'utf8')
      expect(rawRejections).not.toContain('PRIVATE')
      expect(rawRejections).not.toContain('evil.example')
      expect(rawRejections).not.toContain('partial')

      // Reload keeps serving bounded history and preserves the newest progress.
      process.chdir(directory)
      const reloaded = privateDiagnosticsPlugin(true)
      process.chdir(old)
      const reloadHook = reloaded.configureServer as (server: ViteDevServer) => void
      reloadHook({ middlewares: { use(fn: typeof middleware) { middleware = fn } } } as unknown as ViteDevServer)
      expect((await post([progress(1250)])).status).toBe(204)
      const afterReload = readLog()
      expect(afterReload.length).toBeLessThanOrEqual(SERVER_LIMIT)
      expect(afterReload.some(e => e.event === 'extraction.fail')).toBe(true)
      expect(Math.max(...afterReload.filter(e => e.event === 'extraction.progress').map(e => e.page as number))).toBe(1250)

      const snapshot = readFileSync(logFile, 'utf8')
      const disabledHook = disabled.configureServer as (server: ViteDevServer) => void
      disabledHook({ middlewares: { use(fn: typeof middleware) { middleware = fn } } } as unknown as ViteDevServer)
      expect((await post([progress(1)])).status).toBe(404)
      expect(readFileSync(logFile, 'utf8')).toBe(snapshot)
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
      rmSync(directory, { recursive: true, force: true })
    }
  })
})

describe('private ingestion is idempotent', () => {
  it('does not store a retried batch twice', async () => {
    const directory = mkdtempSync(join(process.env.TMPDIR ?? '/root/.hermes/cache/scratch', 'latte-idempotent-'))
    const old = process.cwd()
    process.chdir(directory)
    const plugin = privateDiagnosticsPlugin(true)
    process.chdir(old)
    let middleware: (req: IncomingMessage, res: ServerResponse, next: () => void) => void
    const hook = plugin.configureServer as (server: ViteDevServer) => void
    hook({ middlewares: { use(fn: typeof middleware) { middleware = fn } } } as unknown as ViteDevServer)
    const server = createServer((req, res) => middleware(req, res, () => { res.statusCode = 404; res.end() }))
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`
    const logFile = join(directory, '.runtime/diagnostics/events.jsonl')
    const sessionId = crypto.randomUUID()
    const event = (name: DiagnosticEvent['event'], extra: Partial<DiagnosticEvent> = {}): DiagnosticEvent => ({
      timestamp: new Date().toISOString(), sessionId, version: APP_VERSION, event: name,
      severity: /fail$|error$/.test(name) ? 'error' : 'info', ...extra,
    })
    const post = (events: unknown) => fetch(`${origin}/__latte_diagnostics/events`, {
      method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(events),
    })
    const readLog = () => readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as DiagnosticEvent)
    try {
      // The exact shape recorded for session 82557456: one batch of lifecycle events, retried.
      const batch = [event('session.start'), event('restore.start'), event('delete.start'), event('delete.complete')]
      expect((await post(batch)).status).toBe(204)
      expect(readLog()).toHaveLength(4)
      for (let attempt = 0; attempt < 3; attempt++) {
        expect((await post(batch)).status).toBe(204)
        expect(readLog(), `retry ${attempt + 1} was stored again`).toHaveLength(4)
      }
      expect(readLog().map(e => e.event)).toEqual(['session.start', 'restore.start', 'delete.start', 'delete.complete'])

      // A batch that resends stored events and adds one new event stores only the new event.
      expect((await post([...batch, event('delete.fail', { errorCode: 'unknown' })])).status).toBe(204)
      const afterMixed = readLog()
      expect(afterMixed).toHaveLength(5)
      expect(afterMixed.filter(e => e.event === 'session.start')).toHaveLength(1)
      expect(afterMixed[4].event).toBe('delete.fail')

      // The same event at a different millisecond is a genuinely different event.
      const later = event('delete.complete')
      later.timestamp = new Date(Date.parse(later.timestamp) + 1000).toISOString()
      expect((await post([later])).status).toBe(204)
      expect(readLog()).toHaveLength(6)

      // The log stays content-free: only allowlisted fields, no comparison key, no cause text.
      const raw = readFileSync(logFile, 'utf8')
      expect(raw).not.toContain('PRIVATE')
      for (const entry of readLog()) {
        expect(Object.keys(entry).every(key => ['timestamp', 'sessionId', 'version', 'event', 'severity', 'errorCode', 'page', 'count', 'durationMs', 'zoom'].includes(key))).toBe(true)
      }
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
