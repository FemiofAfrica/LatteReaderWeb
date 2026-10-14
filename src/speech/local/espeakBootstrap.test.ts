// @vitest-environment node
import { webcrypto, createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'

const bootstrap = readFileSync('public/voice/espeak/espeakng.bootstrap.js', 'utf8')
const fixture = [
  { role: 'worker-js', file: 'glue.js', body: Buffer.from('fixture glue') },
  { role: 'wasm', file: 'module.wasm', body: Buffer.from([0, 97, 115, 109]) },
  { role: 'data', file: 'module.data', body: Buffer.from('fixture data') },
]

async function exercise(tamper = false, failInstantiation = false) {
  const requests: string[] = [], errors: { espeakError: string }[] = []
  const instantiated: ArrayBuffer[] = []
  let imports = 0, received = 0
  const manifest = { objectCode: fixture.map(entry => ({
    role: entry.role, file: entry.file, bytes: entry.body.length,
    sha256: createHash('sha256').update(entry.body).digest('hex'),
  })) }
  const realm: Record<string, unknown> = {
    self: { location: { href: 'http://localhost/voice/espeak/espeakng.bootstrap.js' } },
    URL, Blob, Uint8Array, crypto: webcrypto,
    postMessage: (message: { espeakError: string }) => errors.push(message),
    fetch: async (url: string) => {
      requests.push(String(url))
      if (String(url).endsWith('build-manifest.json')) return { ok: true, json: async () => manifest }
      const entry = fixture.find(item => String(url).endsWith(item.file))!
      const bytes = Buffer.from(entry.body)
      if (tamper && entry.role === 'wasm') bytes[0] ^= 255
      return { ok: true, arrayBuffer: async () => Uint8Array.from(bytes).buffer }
    },
    WebAssembly: { instantiate: async (bytes: ArrayBuffer) => {
      instantiated.push(bytes)
      if (failInstantiation) throw Error('fixture failure')
      return { instance: {} }
    } },
    importScripts: () => {
      imports++
      // Emulate the pinned glue's supported hook (it does not read wasmBinary).
      const self = realm.self as { Module: { instantiateWasm: (imports: object, receive: (instance: object) => void) => object } }
      self.Module.instantiateWasm({}, () => { received++ })
    },
  }
  runInNewContext(bootstrap, realm)
  for (let attempt = 0; attempt < 100 && !received && !errors.length; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  return { requests, errors, instantiated, imports, received }
}

describe('verified eSpeak bootstrap', () => {
  it('passes already-verified WASM to the supported hook without refetching', async () => {
    const result = await exercise()
    expect(result.errors).toEqual([])
    expect(result.requests).toHaveLength(4)
    expect(result.requests.filter(url => url.endsWith('module.wasm'))).toHaveLength(1)
    expect(result.imports).toBe(1)
    expect(result.received).toBe(1)
    expect(Buffer.from(result.instantiated[0])).toEqual(fixture[1].body)
  })

  it('fails before glue import or instantiation when verified bytes mismatch', async () => {
    const result = await exercise(true)
    expect(result.errors).toEqual([{ espeakError: 'HASH_MISMATCH:module.wasm' }])
    expect(result.imports).toBe(0)
    expect(result.instantiated).toHaveLength(0)
  })

  it('reports hook instantiation failure instead of silently retrying by URL', async () => {
    const result = await exercise(false, true)
    expect(result.errors).toEqual([{ espeakError: 'WASM_INSTANTIATION_FAILED:fixture failure' }])
    expect(result.received).toBe(0)
    expect(result.requests.filter(url => url.endsWith('module.wasm'))).toHaveLength(1)
  })
})
