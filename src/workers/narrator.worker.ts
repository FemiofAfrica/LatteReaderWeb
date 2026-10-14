/// <reference lib="webworker" />
/** On-device Jasper inference. Every downloaded input is verified before use.
 * Misaki-derived English dictionaries and learned BART replace eSpeak.
 * No document content or audio is sent over the network.
 */
import { fetchPartsVerified, fetchVerified, sha256Hex } from '../speech/local/assetIntegrity'
import symbols from '../speech/local/kittenSymbols.json'
import pins from '../speech/local/narratorPins.json'
import { NARRATOR_BASE_PATH } from '../speech/local/narratorAssets'
type Request = { op: 'init' | 'generate'; id: number; text: string; speed?: number }
type Prepared = { ids: number[]; styleRow: number; ok: boolean; tokenLimitExceeded: boolean; sourceUnits: number; coveredUnits: number }
type Frontend = { prepare: (text: string, lex: unknown, symbols: unknown) => Prepared }
type Learned = { calls: unknown[] }
const LETTERS: Record<string,string> = {'%':'percent','&':'and','@':'at','#':'number','+':'plus','=':'equals','/':'slash','*':'star'}
/** Never refuse a whole passage: retry word by word, then spell the word, then skip it. */
export function prepareResilient(text: string, prep: (t: string) => Prepared): Prepared & { skippedWords: number } {
 let first: Prepared | null = null
 try { first = prep(text); if (first.ok || first.tokenLimitExceeded) return { ...first, skippedWords: 0 } } catch { /* fall through */ }
 const ok = (t: string) => { try { const p = prep(t); return p.ok ? p : null } catch { return null } }
 const spoken: string[] = []; let skippedWords = 0
 for (const raw of text.split(/\s+/).filter(Boolean)) {
  if (ok(raw)) { spoken.push(raw); continue }
  // Split symbols/digits from letters ("12%" -> "12 percent", "3.5.1" -> "3 point 5 point 1").
  const parts = raw.match(/[A-Za-z\u00C0-\u024F']+|\d+|[^\sA-Za-z\d]/g) ?? []
  const pieces: string[] = []
  for (const piece of parts) {
   if (ok(piece)) { pieces.push(piece); continue }
   const word = LETTERS[piece] ?? (piece === '.' ? 'point' : null)
   if (word && ok(word)) { pieces.push(word); continue }
   const spelled = [...piece.normalize('NFD').replace(/\p{M}/gu, '')].filter(c => /[A-Za-z0-9]/.test(c)).map(c => c.toUpperCase()).join(' ')
   if (spelled && ok(spelled)) pieces.push(spelled)
  }
  if (pieces.length) spoken.push(pieces.join(' ')); else skippedWords++
 }
 const joined = spoken.join(' ')
 const result = joined ? ok(joined) : null
 if (result) return { ...result, skippedWords }
 // Last resort: concatenate per-word token ids so one odd interaction cannot drop the passage.
 const ids: number[] = [0]
 for (const w of spoken) { const p = ok(w); if (p) ids.push(...p.ids.slice(1, -2), 16) ; else skippedWords++ }
 ids.push(10, 0)
 return { ids, styleRow: Math.min(ids.length, 399), ok: ids.length > 3, tokenLimitExceeded: ids.length > 500, sourceUnits: first?.sourceUnits ?? 0, coveredUnits: 0, skippedWords }
}
type Tensor = { data: Float32Array; dims: number[]; dispose?: () => void }
type Ort = {
 env: { wasm: { numThreads: number; proxy: boolean; wasmPaths?: unknown; wasmBinary?: Uint8Array | ArrayBuffer } }
 Tensor: new (type: string, data: unknown, dims: number[]) => unknown
 InferenceSession: { create: (data: ArrayBuffer, options: Record<string, unknown>) => Promise<{ run: (feeds: Record<string, unknown>) => Promise<Record<string, Tensor>> }> }
}
const ERRORS = ['ASSET_UNAVAILABLE','SIZE_MISMATCH','HASH_MISMATCH','PART_ORDER','INVALID_VOICE','UNSUPPORTED_TEXT','TOKEN_LIMIT','INVALID_PCM','INVALID_REQUEST','INFERENCE_FAILED']
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
 ort.env.wasm.numThreads = 1; ort.env.wasm.proxy = false
 const glue = await fetchVerified(at(pins.runtime.glue.path), pins.runtime.glue)
 ort.env.wasm.wasmPaths = { mjs: URL.createObjectURL(new Blob([glue], { type: 'text/javascript' })) }
 const wasm = await fetchVerified(at(pins.runtime.wasm.path), pins.runtime.wasm)
 ort.env.wasm.wasmBinary = new Uint8Array(wasm)
 const graph = await fetchPartsVerified(pins.graph.parts, pins.graph, at)
 verify = { graphSha256: await sha256Hex(graph), graphBytes: graph.byteLength, parts: pins.graph.parts.length, runtimeWasmSha256: await sha256Hex(wasm) }
 session = await ort.InferenceSession.create(graph, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' })
 self.postMessage({ id: request.id, ok: true, initMs: performance.now()-started, threads: 1, phonemizerComponent: pins.phonemizer.component, voiceSha256: pins.voice.sha256, ...verify })
}
async function generate(request: Request) {
 if (!session || !voice || !ort || !frontend || !learned || typeof request.text !== 'string') throw Error('INVALID_REQUEST')
 const started = performance.now()
 learned.calls.length = 0
 const prepared = prepareResilient(request.text, t => frontend!.prepare(t, lex, symbols))
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
 self.postMessage({id:request.id,ok:true,pcm:pcm.buffer,metrics:{generateMs,audioSeconds:pcm.length/24000,rtf:generateMs/(pcm.length/24),learnedCalls,sourceUnits:prepared.sourceUnits,coveredUnits:prepared.coveredUnits,skippedWords:prepared.skippedWords,tokens:ids.length,styleRow,trimSamples:0,verifiedGraphSha256:verify?.graphSha256}},[pcm.buffer])
 } finally {for(const tensor of Object.values(out))tensor.dispose?.()}
}
self.onmessage=async(event:MessageEvent<Request>)=>{
 const request=event.data
 try {if(request?.op==='init'){await start(request);return}if(request?.op==='generate'){await generate(request);return}throw Error('INVALID_REQUEST')}
 catch(error){if(learned)learned.calls.length=0;const reason=String((error as Error)?.message??error);self.postMessage({id:request?.id,ok:false,error:ERRORS.find(code=>reason.startsWith(code))??'INFERENCE_FAILED'})}
}
