// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { privateDiagnosticsPlugin, SERVER_LIMIT } from '../../scripts/privateDiagnosticsPlugin'
import { APP_VERSION } from './schema'
import type { ViteDevServer } from 'vite'
describe('private ingestion retention', () => {
  it('bounds the exact runtime file, reloads safely, and ignores disabled middleware', async () => {
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
    const sessionId = crypto.randomUUID()
    const post = (events: unknown) => fetch(`${origin}/__latte_diagnostics/events`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(events) })
    try {
      for (let batch = 0; batch < 41; batch++) {
        const events = Array.from({ length: 25 }, (_, i) => ({ timestamp: new Date().toISOString(), sessionId, version: APP_VERSION, event: 'extraction.progress', severity: 'info', page: batch * 25 + i }))
        expect((await post(events)).status).toBe(204)
      }
      const file = join(directory, '.runtime/diagnostics/events.jsonl')
      const lines = readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line))
      expect(lines).toHaveLength(SERVER_LIMIT)
      expect(lines[0].page).toBe(25)
      expect(lines.at(-1).page).toBe(1024)
      const before = readFileSync(file, 'utf8')
      expect((await post([{ ...lines[0], text: 'PRIVATE' }])).status).toBe(400)
      expect(readFileSync(file, 'utf8')).toBe(before)
      process.chdir(directory)
      const reloaded = privateDiagnosticsPlugin(true)
      process.chdir(old)
      const reloadHook = reloaded.configureServer as (server: ViteDevServer) => void
      reloadHook({ middlewares: { use(fn: typeof middleware) { middleware = fn } } } as unknown as ViteDevServer)
      expect((await post([{ ...lines.at(-1), page: 1025 }])).status).toBe(204)
      const reloadedLines = readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line))
      expect(reloadedLines).toHaveLength(SERVER_LIMIT)
      expect(reloadedLines[0].page).toBe(26)
      const afterReload = readFileSync(file, 'utf8')
      const disabledHook = disabled.configureServer as (server: ViteDevServer) => void
      disabledHook({ middlewares: { use(fn: typeof middleware) { middleware = fn } } } as unknown as ViteDevServer)
      expect((await post([lines[0]])).status).toBe(404)
      expect(readFileSync(file, 'utf8')).toBe(afterReload)
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
