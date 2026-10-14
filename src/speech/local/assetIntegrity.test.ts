import { createHash, webcrypto } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { assetName, fetchPartsVerified, fetchVerified, sha256Hex } from './assetIntegrity'

// jsdom exposes crypto.randomUUID but not crypto.subtle, so the browser digest
// is supplied explicitly. The code under test still calls `crypto.subtle.digest`.
beforeEach(() => { vi.stubGlobal('crypto', webcrypto) })

const bytes = (text: string) => new TextEncoder().encode(text)
const sha256 = (data: Uint8Array) => createHash('sha256').update(data).digest('hex')
const server = (files: Record<string, string | Uint8Array>, missing: string[] = []) =>
  vi.fn(async (url: string) => {
    const name = assetName(url)
    if (missing.includes(name)) return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) }
    const body = files[name]
    if (body === undefined) throw Error(`unexpected request for ${url}`)
    const data = typeof body === 'string' ? bytes(body) : body
    return { ok: true, status: 200, arrayBuffer: async () => data.slice().buffer }
  })

describe('asset integrity', () => {
  it('returns an asset only when both the length and the hash match', async () => {
    const body = 'pinned bytes'
    const pins = { bytes: body.length, sha256: sha256(bytes(body)) }
    const buffer = await fetchVerified('/voice/narrator/x', pins, server({ x: body }))
    expect(new TextDecoder().decode(buffer)).toBe(body)
  })

  it('fails closed on a missing asset, a short read and altered bytes', async () => {
    const body = 'pinned bytes'
    const pins = { bytes: body.length, sha256: sha256(bytes(body)) }
    await expect(fetchVerified('/voice/narrator/x', pins, server({}, ['x']))).rejects.toThrow('ASSET_UNAVAILABLE:x')
    await expect(fetchVerified('/voice/narrator/x', pins, server({ x: 'pinned' }))).rejects.toThrow('SIZE_MISMATCH:x')
    await expect(fetchVerified('/voice/narrator/x', pins, server({ x: 'pinned bytez' }))).rejects.toThrow('HASH_MISMATCH:x')
  })

  it('reassembles parts in order and checks the whole file, not just the parts', async () => {
    const partA = bytes('first-part|')
    const partB = bytes('second-part')
    const parts = [
      { path: 'chunks/model.onnx.part1', bytes: partA.length, sha256: sha256(partA) },
      { path: 'chunks/model.onnx.part2', bytes: partB.length, sha256: sha256(partB) },
    ]
    const whole = Buffer.concat([Buffer.from(partA), Buffer.from(partB)])
    const buffer = await fetchPartsVerified(
      parts,
      { name: 'model.onnx', bytes: whole.length, sha256: sha256(whole) },
      path => `/voice/narrator/${path}`,
      server({ 'model.onnx.part1': partA, 'model.onnx.part2': partB }),
    )
    expect(new TextDecoder().decode(buffer)).toBe('first-part|second-part')
  })

  it('refuses a reassembled file whose parts hash correctly but do not make the pinned whole', async () => {
    // Each part is genuine and intact; the assembled file is not the pinned graph.
    // This is what a swapped or reordered part list looks like from the client.
    const partA = bytes('AAAAAAAAAA')
    const partB = bytes('BBBBBBBBBBB')
    const parts = [
      { path: 'chunks/model.onnx.part1', bytes: partA.length, sha256: sha256(partA) },
      { path: 'chunks/model.onnx.part2', bytes: partB.length, sha256: sha256(partB) },
    ]
    const reversed = sha256(bytes('BBBBBBBBBBBAAAAAAAAAA'))
    await expect(fetchPartsVerified(
      parts,
      { name: 'model.onnx', bytes: partA.length + partB.length, sha256: reversed },
      path => path,
      server({ 'model.onnx.part1': partA, 'model.onnx.part2': partB }),
    )).rejects.toThrow('HASH_MISMATCH:model.onnx')
  })

  it('reports a part that is served altered, and never assembles from it', async () => {
    const partA = bytes('AAAAAAAAAA')
    const partB = bytes('BBBBBBBBBBB')
    const parts = [
      { path: 'chunks/model.onnx.part1', bytes: partA.length, sha256: sha256(partA) },
      { path: 'chunks/model.onnx.part2', bytes: partB.length, sha256: sha256(partB) },
    ]
    await expect(fetchPartsVerified(
      parts,
      { name: 'model.onnx', bytes: partA.length + partB.length, sha256: sha256(Buffer.concat([Buffer.from(partA), Buffer.from(partB)])) },
      path => path,
      server({ 'model.onnx.part1': partA, 'model.onnx.part2': bytes('BBBBBBBBBBX') }),
    )).rejects.toThrow('HASH_MISMATCH:model.onnx.part2')
  })

  it('refuses a whole file shorter than the parts claim, and an empty part list', async () => {
    const partA = bytes('AAAAAAAAAA')
    await expect(fetchPartsVerified([], { name: 'model.onnx', bytes: 10, sha256: sha256(partA) }, path => path, server({})))
      .rejects.toThrow('PART_ORDER:model.onnx')
    await expect(fetchPartsVerified(
      [{ path: 'a', bytes: partA.length, sha256: sha256(partA) }],
      { name: 'model.onnx', bytes: 100, sha256: sha256(partA) },
      path => path,
      server({ a: partA }),
    )).rejects.toThrow('SIZE_MISMATCH:model.onnx')
  })

  it('digests the same bytes the eSpeak loader digests', async () => {
    expect(await sha256Hex(bytes('abc'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })
})
