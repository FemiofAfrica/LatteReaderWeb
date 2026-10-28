/// <reference lib="webworker" />
/** On-device Jasper inference. Every downloaded input is verified before use.
 * Misaki-derived English dictionaries and learned BART replace eSpeak.
 * No document content or audio is sent over the network.
 */
import { fetchPartsVerified, sha256Hex, type AssetPins } from '../speech/local/assetIntegrity'
import { loadVerified, removeOldNarratorCaches } from '../speech/local/narratorCache'
import { containedPrepare, type PreparedText } from '../speech/local/prepareContained'
import symbols from '../speech/local/kittenSymbols.json'
import pins from '../speech/local/narratorPins.json'
import { NARRATOR_BASE_PATH } from '../speech/local/narratorAssets'
type Request = { op: 'init' | 'generate'; id: number; text: string; speed?: number; allowNetwork?: boolean }
type Frontend = { prepare: (text: string, lex: unknown, symbols: unknown) => PreparedText }
type Learned = { calls: unknown[] }
type Tensor = { data: Float32Array; dims: number[]; dispose?: () => void }
type Ort = {
 env: { wasm: { numThreads: number; proxy: boolean; wasmPaths?: unknown; wasmBinary?: Uint8Array | ArrayBuffer } }
 Tensor: new (type: string, data: unknown, dims: number[]) => unknown
 InferenceSession: { create: (data: ArrayBuffer, options: Record<string, unknown>) => Promise<{ run: (feeds: Record<string, unknown>) => Promise<Record<string, Tensor>> }> }
}
const ERRORS = ['NOT_CACHED','ASSET_UNAVAILABLE','SIZE_MISMATCH','HASH_MISMATCH','PART_ORDER','INVALID_VOICE','UNSUPPORTED_TEXT','TOKEN_LIMIT','INVALID_PCM','INVALID_REQUEST','INFERENCE_FAILED']
const base = new URL(NARRATOR_BASE_PATH, self.location.origin)
const at = (path: string) => new URL(path, base).href
let ort: Ort | null = null
let session: Awaited<ReturnType<Ort['InferenceSession']['create']>> | null = null
let voice: Float32Array | null = null
let frontend: Frontend | null = null
let lex: unknown = null
let learned: Learned | null = null
let verify: Record<string, unknown> | null = null
async function moduleFrom(bytes: ArrayBuffer) {
 const url = URL.createObjectURL(new Blob([bytes], { type: 'text/javascript' }))
 try { return await import(/* @vite-ignore */ url) } finally { URL.revokeObjectURL(url) }
}
async function start(request: Request) {
 const started = performance.now()
 // Files come from this device's voice cache when present; the network is used only
 // after the reader pressed Download (allowNetwork), never on a reload.
 let downloadedFiles = 0
 const options = { allowNetwork: request.allowNetwork === true, onNetwork: () => { downloadedFiles++ } }
 const fetchVerified = (url: string, pin: AssetPins) => loadVerified(url, pin, options)
 const files = new Map<string, ArrayBuffer>()
 for (const pin of pins.phonemizer.files) files.set(pin.path.split('/').at(-1)!, await fetchVerified(at(pin.path), pin))
 const json = (name: string) => JSON.parse(new TextDecoder().decode(files.get(name)!))
 frontend = await moduleFrom(files.get('frontend.mjs')!) as Frontend
 const { Bart } = await moduleFrom(files.get('bart.mjs')!)
 learned = new Bart(files.get('model.safetensors'), json('bart-config.json')) as Learned
 lex = { gold: json('us_gold.json'), silver: json('us_silver.json'), bart: learned }
 const tensor = new Float32Array(await fetchVerified(at(pins.voice.path), pins.voice))
 if (tensor.length !== pins.voice.shape[0] * pins.voice.shape[1]) throw Error('INVALID_VOICE')
 voice = tensor
 ort = await moduleFrom(await fetchVerified(at(pins.runtime.bundle.path), pins.runtime.bundle)) as Ort
 // One WASM thread: extra ORT threads compete with audio and the UI on small cores.
 ort.env.wasm.numThreads = 1; ort.env.wasm.proxy = false
 const glue = await fetchVerified(at(pins.runtime.glue.path), pins.runtime.glue)
 ort.env.wasm.wasmPaths = { mjs: URL.createObjectURL(new Blob([glue], { type: 'text/javascript' })) }
 const wasm = await fetchVerified(at(pins.runtime.wasm.path), pins.runtime.wasm)
 ort.env.wasm.wasmBinary = new Uint8Array(wasm)
 const graph = await fetchPartsVerified(pins.graph.parts, pins.graph, at, undefined, fetchVerified)
 verify = { graphSha256: await sha256Hex(graph), graphBytes: graph.byteLength, parts: pins.graph.parts.length, runtimeWasmSha256: await sha256Hex(wasm) }
 session = await ort.InferenceSession.create(graph, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' })
 if (downloadedFiles) await removeOldNarratorCaches()
 self.postMessage({ id: request.id, ok: true, downloadedFiles, initMs: performance.now()-started, threads: 1, phonemizerComponent: pins.phonemizer.component, voiceSha256: pins.voice.sha256, ...verify })
}
async function generate(request: Request) {
 if (!session || !voice || !ort || !frontend || !learned || typeof request.text !== 'string') throw Error('INVALID_REQUEST')
 const started = performance.now()
 learned.calls.length = 0
 const prepared = containedPrepare(request.text, t => frontend!.prepare(t, lex, symbols))
 const learnedCalls = learned.calls.length; learned.calls.length = 0
 if (prepared.tokenLimitExceeded) throw Error('TOKEN_LIMIT')
 if (!prepared.ok) throw Error('UNSUPPORTED_TEXT')
 const { ids, styleRow } = prepared
 const out = await session.run({
 input_ids: new ort.Tensor('int64', BigInt64Array.from(ids, id=>BigInt(id)), [1,ids.length]),
 style: new ort.Tensor('float32', voice.slice(styleRow*256,(styleRow+1)*256), [1,256]),
 speed: new ort.Tensor('float32', new Float32Array([request.speed??1]), [1]),
 })
 try {
 const waveform=out.waveform, pcm=Float32Array.from(waveform.data)
 if(waveform.dims.length!==1||!pcm.length||!pcm.every(Number.isFinite))throw Error('INVALID_PCM')
 const generateMs=performance.now()-started
 self.postMessage({id:request.id,ok:true,pcm:pcm.buffer,metrics:{generateMs,audioSeconds:pcm.length/24000,rtf:generateMs/(pcm.length/24),learnedCalls,sourceUnits:prepared.sourceUnits,coveredUnits:prepared.coveredUnits,contained:prepared.contained,dropped:prepared.dropped,readByOtherMeans:prepared.readByOtherMeans,omitted:prepared.omissions.slice(0,8).map(omission=>({kind:omission.kind,raw:omission.raw})),tokens:ids.length,styleRow,trimSamples:0,verifiedGraphSha256:verify?.graphSha256}},[pcm.buffer])
 } finally {for(const tensor of Object.values(out))tensor.dispose?.()}
}
self.onmessage=async(event:MessageEvent<Request>)=>{
 const request=event.data
 try {if(request?.op==='init'){await start(request);return}if(request?.op==='generate'){await generate(request);return}throw Error('INVALID_REQUEST')}
 catch(error){if(learned)learned.calls.length=0;const reason=String((error as Error)?.message??error);self.postMessage({id:request?.id,ok:false,error:ERRORS.find(code=>reason.startsWith(code))??'INFERENCE_FAILED'})}
}
