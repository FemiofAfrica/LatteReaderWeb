// Regenerates public/voice/espeak/build-manifest.json from the shipped files.
//
// The pins below are the hashes of the artifacts that were built, verified and
// handed over for integration. This script refuses to write a manifest unless
// every shipped file still matches them byte for byte, so a manifest can never
// describe a file that was swapped underneath it.
//
//   node scripts/voice-manifest.mjs
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const espeakDir = new URL('../public/voice/espeak/', import.meta.url)

const PINNED = {
  'espeakng.worker.js': { role: 'worker-js', bytes: 125613, sha256: 'd1da957c7776045bd97902894f8131c549bdd92b1b66e4b3c507e1c58e53d248', licences: ['GPL-3.0-or-later', 'MIT'] },
  'espeakng.worker.wasm': { role: 'wasm', bytes: 371333, sha256: '08a85955065e49401b7911d73b5b057061d8686311b6c329784539e1e85a5d14', licences: ['GPL-3.0-or-later'] },
  'espeakng.worker.data': { role: 'data', bytes: 904455, sha256: 'dbc7f6e5ef43da6d8fc5e9e906a30a0922749b6d7d0011b455eac8aaf1f46c9d', licences: ['GPL-3.0-or-later', 'Unicode'] },
}
const SOURCE = {
  file: '../source/espeak-ng-1.52.0-corresponding-source.tar.gz',
  bytes: 18001299,
  sha256: '92a53e12260ad748cb80131b420ab73a4bc3c589296e6dbabd1195aee29a9ca1',
}

const sha256 = buffer => createHash('sha256').update(buffer).digest('hex')

async function describe(url, expected) {
  const buffer = await readFile(url)
  const digest = sha256(buffer)
  const name = url.pathname.split('/').pop()
  if (buffer.length !== expected.bytes) throw Error(`SIZE_MISMATCH:${name}:${buffer.length}!=${expected.bytes}`)
  if (digest !== expected.sha256) throw Error(`HASH_MISMATCH:${name}:${digest}`)
  return { bytes: buffer.length, sha256: digest }
}

const objectCode = []
for (const [file, pinned] of Object.entries(PINNED)) {
  const { bytes, sha256: digest } = await describe(new URL(file, espeakDir), pinned)
  objectCode.push({ role: pinned.role, file, bytes, sha256: digest, licences: pinned.licences })
}
const source = await describe(new URL('../source/espeak-ng-1.52.0-corresponding-source.tar.gz', espeakDir), SOURCE)

const manifest = {
  component: 'eSpeak-NG WebAssembly phonemizer',
  paths: 'Every path in this file is relative to the directory that holds this manifest.',
  upstream: {
    project: 'espeak-ng',
    repository: 'https://github.com/espeak-ng/espeak-ng',
    tag: '1.52.0',
    commit: '4870adfa25b1a32b4361592f1be8a40337c58d6c',
    licence: 'GPL-3.0-or-later',
    licenceText: '../notices/LICENSE-GPL-3.0.txt',
    warranty: 'none',
  },
  toolchain: {
    emscripten: '6.0.12',
    releaseHash: '6e9f6885cb17a3d6c8fd488a5cff730f50aba61d',
    target: 'wasm32',
    configureFlags: ['--prefix=/usr', '--without-async', '--without-mbrola', '--without-sonic'],
  },
  modifications: {
    status: 'modified',
    date: '2026-10-14',
    record: '../source/SOURCE-OFFER.md',
    fullRecord: 'MODIFICATIONS inside the corresponding source archive',
    patches: [
      { file: 'src/include/compat/wchar.h', why: 'musl <wchar.h> declares the ucd_* class functions that compat/wctype.h aliases; no behaviour change' },
      { file: 'emscripten/Makefile', why: 'accept a modern static libespeak-ng.a and drop three removed emscripten flags in favour of WebAssembly' },
      { file: 'emscripten/espeakng_glue.cpp', why: 'set the phoneme separator to 0, which upstream comments say it intends, for IPA parity' },
    ],
  },
  objectCode,
  correspondingSource: {
    file: SOURCE.file,
    offer: '../source/SOURCE-OFFER.md',
    bytes: source.bytes,
    sha256: source.sha256,
    files: 2597,
    note: 'Complete Corresponding Source, served from this origin at no charge for as long as the object code is served (GPLv3 6(d)).',
  },
  notices: [
    { component: 'eSpeak-NG', licence: 'GPL-3.0-or-later', file: '../notices/LICENSE-GPL-3.0.txt' },
    { component: 'Emscripten runtime JavaScript inside espeakng.worker.js', licence: 'MIT', file: '../notices/LICENSE-MIT-emscripten.txt' },
    { component: 'eSpeak-NG getopt compatibility code (NetBSD)', licence: 'BSD-2-Clause', file: '../notices/LICENSE-BSD-2-Clause.txt' },
    { component: 'Unicode data files inside espeak-ng-data and src/ucd-tools', licence: 'Unicode', file: '../notices/LICENSE-UCD.txt' },
    { component: 'eSpeak-NG COPYING.APACHE (scope undocumented upstream)', licence: 'Apache-2.0', file: '../notices/LICENSE-Apache-2.0.txt' },
    { component: 'onnxruntime-web (private trial, staged outside this repository)', licence: 'MIT', file: '../notices/LICENSE-MIT-onnxruntime-web.txt' },
    { component: 'Kitten Micro 0.8 model and voice data (private trial, staged outside this repository)', licence: 'Apache-2.0', file: '../notices/LICENSE-Apache-2.0.txt' },
  ],
  noticeIndex: '../notices/README.md',
  shipped: '2026-10-14',
}

const target = new URL('build-manifest.json', espeakDir)
await writeFile(target, `${JSON.stringify(manifest, null, 2)}\n`)
console.log(JSON.stringify({ wrote: `${root}public/voice/espeak/build-manifest.json`, objectCode: objectCode.map(({ role, bytes }) => `${role}:${bytes}`), source: source.bytes }, null, 2))
