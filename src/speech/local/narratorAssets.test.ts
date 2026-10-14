import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { NARRATOR_LARGEST_FILE, NARRATOR_PINS, NARRATOR_COMPONENT_BYTES, NARRATOR_BASE_PATH, narratorPath } from './narratorAssets'
import pinsJson from './narratorPins.json'

// Vitest's jsdom environment resolves import.meta.url to an http URL, so the
// shipped files are read from the project root instead.
const file = (relative: string) => join(process.cwd(), 'public/voice/narrator', relative)
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
const bytesOf = (relative: string) => readFileSync(file(relative))

describe('local narrator assets we ship', () => {
  it('serves the same record the app bundles, so the served manifest cannot drift', () => {
    const served = readFileSync(file('manifest.json'), 'utf8')
    const bundled = readFileSync(join(process.cwd(), 'src/speech/local/narratorPins.json'), 'utf8')
    expect(served).toBe(bundled)
    expect(JSON.stringify(NARRATOR_PINS)).toBe(JSON.stringify(pinsJson))
    expect(NARRATOR_BASE_PATH).toBe('/voice/narrator/')
    expect(narratorPath('jasper.f32', 'https://latte.example')).toBe('https://latte.example/voice/narrator/jasper.f32')
  })

  it('ships the graph as parts that reassemble to the pinned whole file', () => {
    const parts = NARRATOR_PINS.graph.parts.map(part => {
      const bytes = bytesOf(part.path)
      expect(bytes.length, part.path).toBe(part.bytes)
      expect(sha256(bytes), part.path).toBe(part.sha256)
      return bytes
    })
    expect(parts.length).toBe(2)
    const whole = Buffer.concat(parts)
    expect(whole.length).toBe(NARRATOR_PINS.graph.bytes)
    expect(whole.length).toBe(41384970)
    expect(sha256(whole)).toBe(NARRATOR_PINS.graph.sha256)
    expect(NARRATOR_PINS.graph.sha256).toBe('95481626fee1ba70ce683e69c534fc7cb38433c46ce42d3abbeafb4b9f1a4123')
  })

  it('ships the derived voice tensor with its provenance, and not the whole voicepack', () => {
    const bytes = bytesOf(NARRATOR_PINS.voice.path)
    expect(bytes.length).toBe(NARRATOR_PINS.voice.bytes)
    expect(bytes.length).toBe(409600)
    expect(sha256(bytes)).toBe(NARRATOR_PINS.voice.sha256)
    expect(NARRATOR_PINS.voice.sha256).toBe('36f085b4a70855602749524990dd9793c6b69598f53284990bc7aa51289de12b')
    expect(NARRATOR_PINS.voice.shape).toEqual([400, 256])
    expect(NARRATOR_PINS.voice.dtype).toBe('float32')
    expect(NARRATOR_PINS.voice.byteOrder).toBe('little-endian')
    expect(NARRATOR_PINS.voice.key).toBe('expr-voice-2-m')
    expect(NARRATOR_PINS.voice.derivedFrom.sha256).toBe('112710c1be8ad0e967c190fb0fd95cbe5848ec4791b93209f20b28b7da20dac1')
    expect(NARRATOR_PINS.voice.derivedFrom.shipped).toBe(false)
    // 409,600 bytes of tensor instead of 3,278,902 bytes of voicepack.
    expect(NARRATOR_PINS.voice.bytes).toBeLessThan(NARRATOR_PINS.voice.derivedFrom.bytes)
  })

  it('ships the ONNX Runtime Web build we chose, from our own origin', () => {
    for (const entry of [NARRATOR_PINS.runtime.bundle, NARRATOR_PINS.runtime.glue, NARRATOR_PINS.runtime.wasm]) {
      const bytes = bytesOf(entry.path)
      expect(bytes.length, entry.path).toBe(entry.bytes)
      expect(sha256(bytes), entry.path).toBe(entry.sha256)
    }
    expect(NARRATOR_PINS.runtime.wasm.bytes).toBe(12361745)
    expect(NARRATOR_PINS.runtime.wasm.sha256).toBe('be0e129949062ad50290ef94683fac8be5bb6156f709e030b7a5f1661a2f6c17')
    expect(NARRATOR_PINS.runtime.choice).toMatch(/ort-wasm-simd-threaded/)
    expect(NARRATOR_PINS.runtime.version).toBe('1.24.3')
    expect(NARRATOR_PINS.runtime.notice).toBe('../notices/LICENSE-MIT-onnxruntime-web.txt')
  })

  it('records the phonemizer this app already ships, and keeps its file hashes true', () => {
    for (const entry of NARRATOR_PINS.phonemizer.files) {
      const bytes = readFileSync(join(process.cwd(), 'public/voice/espeak', entry.path.replace('../espeak/', '')))
      expect(bytes.length, entry.path).toBe(entry.bytes)
      expect(sha256(bytes), entry.path).toBe(entry.sha256)
      expect(statSync(join(process.cwd(), 'public/voice/espeak', entry.path.replace('../espeak/', ''))).isFile()).toBe(true)
    }
    expect(NARRATOR_PINS.phonemizer.files.map(entry => entry.role).sort()).toEqual(['data', 'wasm', 'worker-js'])
    expect(NARRATOR_PINS.phonemizer.commit).toBe('4870adfa25b1a32b4361592f1be8a40337c58d6c')
    expect(statSync(join(process.cwd(), 'public/voice/espeak/phonemizer.mjs')).size).toBe(NARRATOR_PINS.phonemizer.adapter.bytes)
    expect(statSync(join(process.cwd(), 'public/voice/espeak/espeakng.bootstrap.js')).size).toBe(NARRATOR_PINS.phonemizer.loader.bytes)
  })

  it('ships the audited symbol table the worker maps through', () => {
    const bytes = readFileSync(join(process.cwd(), NARRATOR_PINS.symbols.path))
    expect(bytes.length).toBe(NARRATOR_PINS.symbols.bytes)
    expect(sha256(bytes)).toBe(NARRATOR_PINS.symbols.sha256)
  })

  it('records the uncompressed component payload and keeps every file under the host limit', () => {
    const limit = NARRATOR_PINS.perFileLimit.bytes
    expect(limit).toBe(26214400)
    let total = 0
    for (const entry of NARRATOR_PINS.transfer.entries) {
      // Every recorded path is relative to the manifest's own directory.
      const bytes = readFileSync(file(entry.path))
      expect(bytes.length, entry.path).toBe(entry.bytes)
      expect(entry.bytes, entry.path).toBeLessThanOrEqual(limit)
      expect(entry.why.length, entry.path).toBeGreaterThan(10)
      total += entry.bytes
    }
    expect(total).toBe(NARRATOR_PINS.transfer.bytes)
    expect(total).toBe(NARRATOR_COMPONENT_BYTES)
    expect(NARRATOR_PINS.transfer.basis).toMatch(/excludes built app worker/)
    // Component payload includes more than the graph, but is not network traffic.
    expect(total).toBeGreaterThan(NARRATOR_PINS.graph.bytes)
    expect(NARRATOR_LARGEST_FILE).toBe(20692485)
    expect(NARRATOR_PINS.graph.bytes).toBeGreaterThan(limit)
  })
})
