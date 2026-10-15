# Third-party notices — LatteReader Web local narrator

Everything on this page is served from the same origin as the components it
describes. Nothing here needs to be requested, and nothing here is a generated
blob: these are the licence texts and notices as they apply to what we ship.

No warranty. The third-party components below are provided "as is", without
warranty of any kind, to the extent each licence allows.

## 1. What we ship, and under which licence

| Served path | Component | Licence | Notice text | Corresponding source |
|---|---|---|---|---|
| `/voice/espeak/espeakng.worker.js` | Emscripten runtime JS (MIT, © Emscripten authors) compiled together with the GPLv3 eSpeak-NG WebIDL glue | MIT **and** GPL-3.0-or-later | `LICENSE-MIT-emscripten.txt`, `LICENSE-GPL-3.0.txt` | `/voice/source/` |
| `/voice/espeak/espeakng.worker.wasm` | Compiled eSpeak-NG (1.52.0, commit `4870adfa25b1a32b4361592f1be8a40337c58d6c`) | GPL-3.0-or-later | `LICENSE-GPL-3.0.txt` | `/voice/source/` |
| `/voice/espeak/espeakng.worker.data` | The `espeak-ng-data` tree the module mounts at `/usr/share/espeak-ng-data` (English voices, dictionary, phontab, intonations) | GPL-3.0-or-later; Unicode data files inside it also carry the Unicode licence | `LICENSE-GPL-3.0.txt`, `LICENSE-UCD.txt` | `/voice/source/` |
| `/voice/espeak/espeakng.bootstrap.js`, `/voice/espeak/phonemizer.mjs`, `/voice/espeak/build-manifest.json` | LatteReader Web's own loader and adapter for the above | LatteReader Web code — see the open question in §5 | — | — |
| `/voice/source/espeak-ng-1.52.0-corresponding-source.tar.gz` | Corresponding Source for the eSpeak-NG component | GPL-3.0-or-later | `LICENSE-GPL-3.0.txt` | it *is* the source |

Pins, byte counts and SHA-256 values for the shipped files are recorded
machine-readably in [`/voice/espeak/build-manifest.json`](../espeak/build-manifest.json)
and — for the human reader — in
[`/voice/source/SOURCE-OFFER.md`](../source/SOURCE-OFFER.md).

### eSpeak-NG, and why our own build replaced the old one

eSpeak-NG is GPL version 3 or later. The npm `phonemizer@1.2.1` bundle that the
local narrator used before this change embedded a prebuilt eSpeak-NG (asm.js
plus an English slice of `espeak-ng-data`) inside a single minified
`dist/phonemizer.js` that carried no GPL text, no copyright notice, no source
offer, and no identifiable eSpeak revision — so no Corresponding Source could be
offered for it at all. We now ship our own build of eSpeak-NG from a pinned
commit, as separate served files, with the notices and the source offer on this
origin. The `phonemizer` package is no longer loaded or shipped by the local
narrator. Our build is a modified work (three patches, all build-level); the
modification record is in §3 below and in full inside the source archive.

`src/ucd-tools` and the Unicode character data are part of the upstream
eSpeak-NG source tree at the pinned commit, and they are covered by the same
GPL-3.0-or-later declaration upstream makes for the project; Debian's per-file
packaging copyright for eSpeak-NG 1.52.0 lists no carve-out for them. The
Unicode data files additionally carry the Unicode licence, which we reproduce in
full as `LICENSE-UCD.txt`. Upstream also ships a `COPYING.APACHE` file whose
scope its README does not document; we reproduce it verbatim as
`LICENSE-Apache-2.0.txt` and do **not** claim it grants anything to the data or
to `ucd-tools`.

## 2. Components bundled in this candidate build

The candidate build now bundles ONNX Runtime Web, the Kitten model graph (in
two parts), and the derived Jasper voice tensor under `/voice/narrator/`.
They are included in this repository and its local build, but this candidate
has **not been publicly deployed**. Inclusion is not legal clearance to publish.
The publisher's model licence declaration and the voice provenance have not
been independently confirmed. The GPL combined-work scope described in §5
also remains unresolved.

| Component | Licence | Notice text | Notes |
|---|---|---|---|
| onnxruntime-web 1.24.3 (WASM + JS) | MIT | `LICENSE-MIT-onnxruntime-web.txt` | **The npm package ships no licence file.** This text is the upstream MIT licence, supplied by us, with the Microsoft copyright line. Redistribution is permitted with this notice. |
| Kitten Micro 0.8 TTS model (`model.onnx`) and the voice tensor (`jasper.f32`, derived from `voices.npz`) | Apache-2.0, as declared by the publisher | `LICENSE-Apache-2.0.txt` | The Hugging Face repo `KittenML/kitten-tts-micro-0.8` at revision `1ccf72b2c2048fd17efac7de2fab32d10e225084` declares `license: apache-2.0` in its metadata and contains **no `LICENSE` file**; we record that declaration, not an independently confirmed grant. The model card's only acknowledgement is "StyleTTS 2 architecture". The provenance of `voices.npz` is not documented by the publisher and is **unverified**; written confirmation of the licence and voice provenance remains required before public release. |

## 3. Modification record for the eSpeak-NG build (GPLv3 §5(a), §5(b))

The archived `espeak-ng-4870adfa25b1a32b4361592f1be8a40337c58d6c/` directory is
pristine upstream source at that commit. Three patches were applied before
compiling, dated 2026-10-14, all reproduced in the archive under
`build/patches/`:

1. `src/include/compat/wchar.h` — lets the system `<wchar.h>` parse with its own
   function names under Emscripten's musl sysroot. No behaviour change.
2. `emscripten/Makefile` — accepts a modern static `libespeak-ng.a` and replaces
   three removed Emscripten flags with a WebAssembly build.
3. `emscripten/espeakng_glue.cpp` — sets the phoneme separator to 0, matching
   what upstream's own comment says it intends, so the IPA output does not carry
   a space between every phoneme.

No eSpeak-NG translation, dictionary, phonetic data or synthesis source file is
altered. The modified work as a whole is licensed under GPL-3.0-or-later, with no
additional restrictions.

## 4. What the app does not do

LatteReader Web's reader keeps document text on the device: speech is generated
locally in the browser and the reader sends no document text, selection, page
content or filename to any server. No term of use in this app restricts your
GPLv3 rights in the components listed above, and no additional restriction is
imposed on them.

## 5. Open question — not settled by these notices

Whether our narrator worker bundle forms a single combined work with the
eSpeak-NG component, so that GPLv3 §5(c) would require the bundle as a whole to
be licensed under the GPL, is an open legal question. Our mitigation is the one
described above: the eSpeak-NG module is loaded as separate served files from a
distinct path with its own licence text and its own Corresponding Source, never
compiled into the application bundle. **These notices and the source offer do
not resolve that question.** It is with a lawyer.
