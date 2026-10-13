// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { networkInterfaces } from 'node:os'
import { join } from 'node:path'
import { isIndexDocumentRequest, privateDiagnosticsPlugin } from '../../scripts/privateDiagnosticsPlugin'

type Middleware = (req: IncomingMessage, res: ServerResponse, next: () => void) => void

const marker = '<meta name="latte-private-diagnostics" content="enabled">'
const shells: Array<{ close(): Promise<void>; url: string; directory: string }> = []

afterEach(async () => {
  for (const shell of shells.splice(0)) {
    await shell.close()
    rmSync(shell.directory, { recursive: true, force: true })
  }
})

function nonLoopbackAddress(): string | undefined {
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) return entry.address
    }
  }
  return undefined
}

async function previewServer(enabled: boolean, host = '127.0.0.1') {
  const directory = mkdtempSync(join(process.env.TMPDIR ?? '/root/.hermes/cache/scratch', 'latte-preview-'))
  mkdirSync(join(directory, 'dist'))
  writeFileSync(join(directory, 'dist/index.html'), '<!doctype html><html><head><title>LatteReader</title></head><body><div id="root"></div></body></html>')
  const previous = process.cwd()
  process.chdir(directory)
  const plugin = privateDiagnosticsPlugin(enabled)
  process.chdir(previous)
  const chainMiddlewares: Middleware[] = []
  const hook = plugin.configurePreviewServer as (server: { middlewares: { use(fn: Middleware): void } }) => void
  hook({ middlewares: { use(fn: Middleware) { chainMiddlewares.push(fn) } } })
  const server = createServer((req, res) => {
    // Vite's preview server serves the built document after plugin middleware;
    // mirror that static fallback so a fall-through is visible as unmarked HTML.
    const staticFallback: Middleware = (request, response) => {
      response.statusCode = 200
      response.setHeader('Content-Type', 'text/html')
      response.end(readFileSync(join(directory, 'dist/index.html'), 'utf8'))
    }
    const chain = [...chainMiddlewares, staticFallback]
    let index = 0
    const next = () => {
      const middleware = chain[index++]
      if (!middleware) { res.statusCode = 404; res.end(); return }
      middleware(req, res, next)
    }
    next()
  })
  await new Promise<void>(resolve => server.listen(0, host, resolve))
  const port = (server.address() as { port: number }).port
  const shell = {
    directory,
    url: `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}`,
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  }
  shells.push(shell)
  return shell
}

async function get(url: string, headers: Record<string, string> = {}) {
  const response = await fetch(url, { headers })
  return { status: response.status, body: await response.text() }
}

describe('private preview index marker injection', () => {
  it('injects the private marker for the exact index request', async () => {
    const shell = await previewServer(true)
    const response = await get(`${shell.url}/`)
    expect(response.status).toBe(200)
    expect(response.body).toContain(marker)
  })

  it('injects the private marker when the tester URL carries a query string', async () => {
    const shell = await previewServer(true)
    for (const path of ['/?build=2431814', '/index.html?build=2431814']) {
      const response = await get(`${shell.url}${path}`)
      expect(response.status, path).toBe(200)
      expect(response.body, path).toContain(marker)
    }
  })

  it('injects the private marker when the request carries a fragment-free referer-style query', async () => {
    const shell = await previewServer(true)
    const response = await get(`${shell.url}/?build=2431814&t=1`, { referer: 'http://127.0.0.1:4176/' })
    expect(response.body).toContain(marker)
  })

  it('serves an unmarked document when diagnostics are disabled', async () => {
    const shell = await previewServer(false)
    const response = await get(`${shell.url}/?build=2431814`)
    expect(response.status).toBe(200)
    expect(response.body).not.toContain(marker)
  })

  it('refuses the marked document to a non-loopback socket', async () => {
    const address = nonLoopbackAddress()
    if (!address) return
    const shell = await previewServer(true, '0.0.0.0')
    const response = await get(`http://${address}:${shell.url.split(':').pop()}/?build=2431814`)
    expect(response.status).toBe(403)
    expect(response.body).not.toContain(marker)
  })

  it('keeps the built static document free of the marker', async () => {
    const built = readFileSync(new URL('../../dist/index.html', import.meta.url), 'utf8')
    expect(built).not.toContain(marker)
  })

  it('matches only origin-form index request targets', () => {
    for (const url of ['/', '/index.html', '/?build=2431814', '/index.html?build=2431814', '/?a=1#x'])
      expect(isIndexDocumentRequest(url), url).toBe(true)
    for (const url of ['/assets/index.js', '/index.html.bak', '/nested/index.html', 'http://evil.test/', '//evil.test/', '', undefined, '#/'])
      expect(isIndexDocumentRequest(url), String(url)).toBe(false)
  })
})
