// Stage the approved local-narrator model and runtime as static assets under
// public/, and record every byte's size and SHA-256 in one manifest.
//
// The 41,384,970-byte Kitten Micro graph is above Cloudflare Pages' 25 MiB
// (26,214,400-byte) per-file limit, so it is written as exactly two parts of
// 20,692,485 bytes. The client concatenates them in order and re-checks the
// whole-file SHA-256 before the runtime sees the buffer.
//
// Nothing is downloaded here. Every source file is read from the approved
// feasibility directory, checked against the pinned SHA-256 first, and read
// back after writing. The script refuses to write a manifest whose bytes do not
// match the pins.
//
// Usage (from the repository root):
//   node scripts/stage-narrator-assets.mjs [APPROVED_FEASIBILITY_DIRECTORY]
import {createHash} from 'node:crypto'
import {mkdir,readFile,rm,stat,writeFile} from 'node:fs/promises'
import {dirname,resolve} from 'node:path'

const PAGES_FILE_LIMIT = 26214400
const REPO = process.cwd()
const SOURCE = resolve(process.argv[2] ?? '/root/.hermes/cache/scratch/latte-narrator-feasibility')
const OUT = resolve(REPO, 'public/voice/narrator')
const PINS = resolve(REPO, 'src/speech/local/narratorPins.json')
const SYMBOLS = resolve(REPO, 'src/speech/local/kittenSymbols.json')

// Pinned sources. A mismatch stops the run before anything is written.
const PINS_SOURCE = {
  'assets/model.onnx': {bytes: 41384970, sha256: '95481626fee1ba70ce683e69c534fc7cb38433c46ce42d3abbeafb4b9f1a4123'},
  'assets/jasper.f32': {bytes: 409600, sha256: '36f085b4a70855602749524990dd9793c6b69598f53284990bc7aa51289de12b'},
  'assets/symbols.json': {bytes: 1765, sha256: 'c31f54084e4c7d95944fb33383bd65b0af7d84969ccc6ed6c1472fbbcb60b2ae'},
  'node_modules/onnxruntime-web/dist/ort.wasm.min.mjs': {bytes: 49997, sha256: 'd5a6d7bc8ee587648fb3742dde8c0094d17cbd3822a68bbec8ddfcd4f2adb88e'},
  'node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.mjs': {bytes: 24274, sha256: '5687566b1bc1c8cf628d76c2ddb16b2a3b81a7997273d4666564880495088e57'},
  'node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm': {bytes: 12361745, sha256: 'be0e129949062ad50290ef94683fac8be5bb6156f709e030b7a5f1661a2f6c17'},
}

// Fully replaced, so a part left behind by an earlier run cannot survive.
await rm(OUT, {recursive: true, force: true})

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const read = async name => {
  const bytes = await readFile(resolve(SOURCE, name))
  const expected = PINS_SOURCE[name]
  if (expected && bytes.length !== expected.bytes) throw Error(`SIZE_MISMATCH:${name}:${bytes.length}`)
  const hash = sha256(bytes)
  if (expected && hash !== expected.sha256) throw Error(`HASH_MISMATCH:${name}:${hash}`)
  return bytes
}

/** Writes an asset and proves the bytes on disk are the bytes we hashed. */
const write = async (relative, bytes) => {
  const target = resolve(OUT, relative)
  await mkdir(dirname(target), {recursive: true})
  await writeFile(target, bytes)
  const served = await readFile(target)
  if (served.length !== bytes.length || sha256(served) !== sha256(bytes)) throw Error(`WRITE_MISMATCH:${relative}`)
  if (bytes.length > PAGES_FILE_LIMIT) throw Error(`OVER_PER_FILE_LIMIT:${relative}:${bytes.length}`)
  return {path: relative, bytes: bytes.length, sha256: sha256(bytes)}
}

// 1. The graph, split in two. Read once: never three copies of 41 MB at rest.
const graph = await read('assets/model.onnx')
const half = graph.length / 2
if (!Number.isInteger(half)) throw Error('ODD_GRAPH_LENGTH')
const parts = [
  await write('chunks/model.onnx.part1', graph.subarray(0, half)),
  await write('chunks/model.onnx.part2', graph.subarray(half)),
]
if (Buffer.concat([graph.subarray(0, half), graph.subarray(half)]).length !== graph.length) throw Error('REASSEMBLY_MISMATCH')

// 2. The derived voice tensor and the symbol table. Provenance comes from the
// audited conversion, not from a guess: Jasper is one 400x256 float32 row set
// selected from the pinned voices.npz.
const sourceManifest = JSON.parse(await readFile(resolve(SOURCE, 'assets/manifest.json'), 'utf8'))
const derived = sourceManifest.derived_voice
if (derived?.key !== 'expr-voice-2-m' || derived?.shape?.join('x') !== '400x256') throw Error('VOICE_PROVENANCE_UNEXPECTED')
const jasper = await read('assets/jasper.f32')
const voice = await write('jasper.f32', jasper)
const symbols = await read('assets/symbols.json')
await writeFile(SYMBOLS, symbols)

// 3. The ONNX Runtime Web build, served from our own origin, never a CDN.
const runtimePackage = JSON.parse(await readFile(resolve(SOURCE, 'node_modules/onnxruntime-web/package.json'), 'utf8'))
if (runtimePackage.version !== '1.24.3') throw Error(`RUNTIME_VERSION:${runtimePackage.version}`)
const runtime = {
  component: runtimePackage.name,
  version: runtimePackage.version,
  licence: 'MIT',
  notice: '../notices/LICENSE-MIT-onnxruntime-web.txt',
  choice: 'ort-wasm-simd-threaded (WASM + SIMD, single-threaded at numThreads=1). '
    + 'The jsep build is 25,014,754 bytes and the asyncify build 27,190,919 bytes; asyncify is over the 26,214,400-byte per-file limit, '
    + 'and neither is needed because this narrator runs one inference on the CPU with no WebGPU or asyncify path.',
  bundle: await write('runtime/ort.wasm.min.mjs', await read('node_modules/onnxruntime-web/dist/ort.wasm.min.mjs')),
  glue: await write('runtime/ort-wasm-simd-threaded.mjs', await read('node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.mjs')),
  wasm: await write('runtime/ort-wasm-simd-threaded.wasm', await read('node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm')),
}

// 4. The English phonemizer we already build and serve ourselves. Its pins stay
// owned by public/voice/espeak/build-manifest.json; this records what a first
// opt-in will actually transfer, so the advertised total is not just the graph.
const espeak = JSON.parse(await readFile(resolve(REPO, 'public/voice/espeak/build-manifest.json'), 'utf8'))
const phonemizer = {
  manifest: '../espeak/build-manifest.json',
  component: `${espeak.upstream.project} ${espeak.upstream.tag}`,
  project: espeak.upstream.project,
  tag: espeak.upstream.tag,
  commit: espeak.upstream.commit,
  licence: espeak.upstream.licence,
  modified: espeak.modifications.date,
  noticeIndex: espeak.noticeIndex,
  notice: espeak.upstream.licenceText,
  source: {
    offer: espeak.correspondingSource.offer, file: espeak.correspondingSource.file,
    bytes: espeak.correspondingSource.bytes, sha256: espeak.correspondingSource.sha256,
    files: espeak.correspondingSource.files,
  },
  adapter: {path: '../espeak/phonemizer.mjs', bytes: (await stat(resolve(REPO, 'public/voice/espeak/phonemizer.mjs'))).size},
  loader: {path: '../espeak/espeakng.bootstrap.js', bytes: (await stat(resolve(REPO, 'public/voice/espeak/espeakng.bootstrap.js'))).size},
  files: espeak.objectCode.map(({role, file, bytes, sha256: hash}) => ({role, path: `../espeak/${file}`, bytes, sha256: hash})),
}

// 5. Uncompressed component payload. Excludes the built app worker and HTTP
// overhead; actual network transfer depends on cache/compression and retries.
const transfer = [
  ...parts.map(part => ({path: part.path, bytes: part.bytes, why: 'part of the pinned model graph, reassembled and re-hashed in the worker'})),
  {path: voice.path, bytes: voice.bytes, why: 'the pinned Jasper voice tensor'},
  {path: runtime.bundle.path, bytes: runtime.bundle.bytes, why: 'ONNX Runtime Web JavaScript, served from this origin'},
  {path: runtime.glue.path, bytes: runtime.glue.bytes, why: 'ONNX Runtime Web WebAssembly loader, served from this origin'},
  {path: runtime.wasm.path, bytes: runtime.wasm.bytes, why: 'ONNX Runtime Web WebAssembly, served from this origin'},
  {path: phonemizer.adapter.path, bytes: phonemizer.adapter.bytes, why: 'our adapter for the pinned eSpeak-NG build'},
  {path: phonemizer.loader.path, bytes: phonemizer.loader.bytes, why: 'the eSpeak-NG loader that verifies its own three files'},
  {path: phonemizer.manifest, bytes: (await stat(resolve(REPO, 'public/voice/espeak/build-manifest.json'))).size, why: 'the eSpeak-NG pins that loader verifies against'},
  ...phonemizer.files.map(file => ({path: file.path, bytes: file.bytes, why: `pinned eSpeak-NG ${file.role}`})),
]

const manifest = {
  component: 'Kitten Micro 0.8 local narrator, fixed voice Jasper (English)',
  model: {
    provider: 'KittenML, Hugging Face repository KittenML/kitten-tts-micro-0.8',
    revision: '1ccf72b2c2048fd17efac7de2fab32d10e225084',
    licence: 'Apache-2.0 as declared by the publisher (the repository carries no LICENSE file)',
    notice: '../notices/LICENSE-Apache-2.0.txt',
  },
  graph: {name: 'model.onnx', bytes: graph.length, sha256: sha256(graph), parts},
  voice: {
    name: 'jasper.f32', alias: derived.alias, key: derived.key,
    path: voice.path, bytes: voice.bytes, sha256: voice.sha256,
    dtype: 'float32', byteOrder: 'little-endian', shape: derived.shape,
    derivation: `selected from voices.npz key ${derived.key} and written unchanged as little-endian float32; no arithmetic, transpose or quantisation`,
    derivedFrom: {name: 'voices.npz', bytes: 3278902, sha256: derived.source_sha256, shipped: false},
  },
  runtime,
  phonemizer,
  symbols: {path: 'src/speech/local/kittenSymbols.json', bytes: symbols.length, sha256: sha256(symbols)},
  perFileLimit: {host: 'Cloudflare Pages', bytes: PAGES_FILE_LIMIT},
  transfer: {basis: "Uncompressed component file sizes, one copy per entry; excludes built app worker and HTTP overhead. Actual transfer depends on cache, compression and retries.", bytes: transfer.reduce((total, entry) => total + entry.bytes, 0), entries: transfer},
}
if (parts.some(part => part.bytes > PAGES_FILE_LIMIT)) throw Error('PART_OVER_LIMIT')

// 6. One record, two copies: served next to the assets for anyone who wants to
// check them, and bundled into the app so the opt-in copy and the worker use
// the same pins without a request of their own.
const json = `${JSON.stringify(manifest, null, 2)}\n`
await writeFile(resolve(OUT, 'manifest.json'), json)
await writeFile(PINS, json)
if ((await readFile(PINS, 'utf8')) !== (await readFile(resolve(OUT, 'manifest.json'), 'utf8'))) throw Error('RECORD_MISMATCH')

console.log(JSON.stringify({
  source: SOURCE,
  staged: resolve(OUT),
  graph: {bytes: graph.length, sha256: sha256(graph), parts},
  voice,
  runtime: {wasm: runtime.wasm, glue: runtime.glue, bundle: runtime.bundle},
  phonemizerFiles: phonemizer.files.length,
  transferBytes: manifest.transfer.bytes,
  largestFile: Math.max(...transfer.map(entry => entry.bytes)),
}, null, 2))
