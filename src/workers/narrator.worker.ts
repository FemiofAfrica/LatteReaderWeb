/// <reference lib="webworker" />
/**
 * The public local-narrator worker: one pinned English narrator (Jasper), run
 * entirely on the device.
 *
 * Nothing here reaches a third party. After the user's explicit Enable gesture
 * the worker fetches, and hash-verifies before use:
 *
 *   /voice/narrator/  the Kitten Micro graph as two parts reassembled into the
 *                     whole file, the derived Jasper voice tensor, and the
 *                     pinned ONNX Runtime Web build we serve ourselves
 *   /voice/espeak/    our own eSpeak-NG build, which verifies its own three
 *                     files against its own manifest inside its bootstrap
 *
 * Document text, selections, filenames and the generated audio never leave the
 * worker: the only network traffic is GETs for those static files.
 *
 * The pinned graph exceeds the host's 26,214,400-byte per-file limit, which is
 * why the parts exist. The assembly check lives in `assetIntegrity.ts` and is
 * the same length-then-SHA-256 rule the eSpeak loader uses.
 */
import { fetchPartsVerified, fetchVerified, sha256Hex } from '../speech/local/assetIntegrity'
import { kittenInputs } from '../speech/local/kittenInputs'
import pins from '../speech/local/narratorPins.json'
import { NARRATOR_BASE_PATH } from '../speech/local/narratorAssets'

type InitRequest = { op: 'init'; id: number }
type GenerateRequest = { op: 'generate'; id: number; text: string; speed?: number }
type Request = InitRequest | GenerateRequest

/** The codes the worker is allowed to report. Anything else is INFERENCE_FAILED. */
const ERRORS = ['ASSET_UNAVAILABLE', 'SIZE_MISMATCH', 'HASH_MISMATCH', 'PART_ORDER', 'INVALID_VOICE',
  'UNKNOWN_PHONEMES', 'TOKEN_LIMIT', 'INVALID_PCM', 'INVALID_REQUEST', 'INFERENCE_FAILED']

type Phonemizer = {
  listVoices: () => Promise<{ identifier: string }[]>
  phonemize: (text: string, language?: string) => Promise<string[]>
}
type Tensor = { data: Float32Array; dims: number[]; dispose?: () => void }
type Ort = {
  env: { wasm: { numThreads: number; proxy: boolean; wasmPaths?: unknown; wasmBinary?: Uint8Array | ArrayBuffer } }
  Tensor: new (type: string, data: unknown, dims: number[]) => unknown
  InferenceSession: { create: (data: ArrayBuffer, options: Record<string, unknown>) => Promise<OrtSession> }
}
type OrtSession = { run: (feeds: Record<string, unknown>) => Promise<Record<string, Tensor>> }

const base = new URL(NARRATOR_BASE_PATH, self.location.origin)
const at = (path: string) => new URL(path, base).href

let ort: Ort | null = null
let session: OrtSession | null = null
let voice: Float32Array | null = null
let phonemizer: Phonemizer | null = null
let verify: { graphSha256: string; graphBytes: number; parts: number; runtimeWasmSha256: string } | null = null

async function start(request: InitRequest) {
  const started = performance.now()
  // The phonemizer is verified and mounted first: a bad speech component fails
  // here, in about 1.4 MB, rather than after the model has been transferred.
  phonemizer = await import(/* @vite-ignore */ at(pins.phonemizer.adapter.path)) as Phonemizer
  const voices = await phonemizer.listVoices()

  const tensor = new Float32Array(await fetchVerified(at(pins.voice.path), pins.voice))
  if (tensor.length !== pins.voice.shape[0] * pins.voice.shape[1]) throw Error('INVALID_VOICE')
  voice = tensor

  // ONNX Runtime Web, served from this origin and never a CDN. The WebAssembly
  // build is handed over as the bytes we verified, so the runtime neither
  // fetches nor re-derives it.
  ort = await import(/* @vite-ignore */ at(pins.runtime.bundle.path)) as Ort
  ort.env.wasm.numThreads = 1
  ort.env.wasm.proxy = false
  ort.env.wasm.wasmPaths = { mjs: at(pins.runtime.glue.path) }
  const wasmBytes = await fetchVerified(at(pins.runtime.wasm.path), pins.runtime.wasm)
  const runtimeWasmSha256 = await sha256Hex(wasmBytes)
  ort.env.wasm.wasmBinary = new Uint8Array(wasmBytes)

  const graph = await fetchPartsVerified(pins.graph.parts, pins.graph, at)
  verify = { graphSha256: await sha256Hex(graph), graphBytes: graph.byteLength, parts: pins.graph.parts.length, runtimeWasmSha256 }
  session = await ort.InferenceSession.create(graph, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' })
  self.postMessage({
    id: request.id, ok: true, initMs: performance.now() - started, threads: 1,
    phonemizerVoices: voices.length, phonemizerComponent: pins.phonemizer.component,
    voiceSha256: pins.voice.sha256, ...verify,
  })
}

async function generate(request: GenerateRequest) {
  if (!session || !voice || !ort || !phonemizer) throw Error('INVALID_REQUEST')
  const started = performance.now()
  const { ids, styleRow } = await kittenInputs(request.text, phonemizer.phonemize)
  const out = await session.run({
    input_ids: new ort.Tensor('int64', BigInt64Array.from(ids, id => BigInt(id)), [1, ids.length]),
    style: new ort.Tensor('float32', voice.slice(styleRow * 256, (styleRow + 1) * 256), [1, 256]),
    speed: new ort.Tensor('float32', new Float32Array([request.speed ?? 1]), [1]),
  })
  try {
    const waveform = out.waveform
    const pcm = Float32Array.from(waveform.data)
    if (waveform.dims.length !== 1 || !pcm.length || !pcm.every(Number.isFinite)) throw Error('INVALID_PCM')
    const generateMs = performance.now() - started
    self.postMessage({
      id: request.id, ok: true, pcm: pcm.buffer,
      metrics: {
        generateMs, audioSeconds: pcm.length / 24000, rtf: generateMs / (pcm.length / 24),
        tokens: ids.length, styleRow, trimSamples: 0, verifiedGraphSha256: verify?.graphSha256,
      },
    }, [pcm.buffer])
  } finally {
    for (const tensor of Object.values(out)) tensor.dispose?.()
  }
}

self.onmessage = async (event: MessageEvent<Request>) => {
  const request = event.data
  try {
    if (request?.op === 'init') { await start(request); return }
    if (request?.op === 'generate') { await generate(request); return }
    throw Error('INVALID_REQUEST')
  } catch (error) {
    const reason = String((error as Error)?.message ?? error)
    self.postMessage({ id: request?.id, ok: false, error: ERRORS.find(code => reason.startsWith(code)) ?? 'INFERENCE_FAILED' })
  }
}
