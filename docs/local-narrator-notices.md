# Local narrator: shipped files, licences and where the notices live

The local narrator's English phonemes come from an eSpeak-NG WebAssembly build **we compile ourselves** at a pinned commit, replacing the npm `phonemizer@1.2.1` bundle that shipped a prebuilt eSpeak-NG (asm.js plus an English slice of `espeak-ng-data`) with no GPL text, no copyright notice, no source offer and no identifiable eSpeak revision.

This page is the repository-side view. The user-facing copy is served from the same origin as the component and is linked from the narrator panel; it is what a recipient actually receives.

## Repository path -> served path

| Repository path | Served at | What it is |
|---|---|---|
| `public/voice/espeak/espeakng.worker.js` | `/voice/espeak/espeakng.worker.js` | eSpeak-NG WebIDL glue (GPL-3.0-or-later) with the Emscripten runtime JS (MIT) compiled in |
| `public/voice/espeak/espeakng.worker.wasm` | `/voice/espeak/espeakng.worker.wasm` | compiled eSpeak-NG 1.52.0 at commit `4870adfa25b1a32b4361592f1be8a40337c58d6c` (GPL-3.0-or-later) |
| `public/voice/espeak/espeakng.worker.data` | `/voice/espeak/espeakng.worker.data` | the `espeak-ng-data` the module mounts (GPL-3.0-or-later; Unicode data files also under the Unicode licence) |
| `public/voice/espeak/espeakng.bootstrap.js` | `/voice/espeak/espeakng.bootstrap.js` | LatteReader Web's loader: fetches the three files, checks length and SHA-256, starts only verified bytes |
| `public/voice/espeak/phonemizer.mjs` | `/voice/espeak/phonemizer.mjs` | LatteReader Web's adapter: `phonemize(text, lang)`, `listVoices()` |
| `public/voice/espeak/build-manifest.json` | `/voice/espeak/build-manifest.json` | pins, byte counts, SHA-256 values, modification record, notice list |
| `public/voice/notices/` | `/voice/notices/` | licence texts and the third-party index (`README.md`) |
| `public/voice/source/SOURCE-OFFER.md` | `/voice/source/SOURCE-OFFER.md` | the GPLv3 section 6(d) offer, the modification record and how to rebuild |
| `public/voice/source/espeak-ng-1.52.0-corresponding-source.tar.gz` | same | Corresponding Source, 18,001,299 B, SHA-256 `92a53e…9ca1`, 2,597 files |

Nothing above is bundled into the application's JavaScript. The component is served as separate files from a distinct path, with its own licence and its own source, which is the mitigation for the open §5(c) question.

## Shipped notices

| Notice file | Covers |
|---|---|
| `notices/LICENSE-GPL-3.0.txt` | eSpeak-NG, including its data (GPL-3.0-or-later) |
| `notices/LICENSE-MIT-emscripten.txt` | Emscripten runtime JavaScript inside `espeakng.worker.js` |
| `notices/LICENSE-BSD-2-Clause.txt` | eSpeak-NG's `getopt` compatibility code (NetBSD) |
| `notices/LICENSE-UCD.txt` | Unicode data files inside `espeak-ng-data` and `src/ucd-tools` |
| `notices/LICENSE-Apache-2.0.txt` | the Kitten Micro model and voice data (declared Apache-2.0); also reproduces the file eSpeak-NG ships as `COPYING.APACHE`, whose scope upstream does not document |
| `notices/LICENSE-MIT-onnxruntime-web.txt` | onnxruntime-web, which ships no licence file in its npm package |
| `notices/README.md` | the index: shipped file -> component -> licence -> notice -> source, plus the no-warranty statement |

`src/ucd-tools` is part of the upstream eSpeak-NG tree at the pinned commit and is covered by the same GPL-3.0-or-later declaration upstream makes for the project; Debian's per-file packaging copyright for 1.52.0 lists no carve-out for it. We do not claim `COPYING.APACHE` grants anything to the data or to `ucd-tools`.

## Regenerating and checking the pins

```sh
npm run voice:manifest   # rewrites public/voice/espeak/build-manifest.json
npm test                 # assetManifest.test.ts re-hashes every shipped file against it
npm run voice:smoke      # real browser: loads, hashes, IPA parity, notices, privacy
```

- `scripts/voice-manifest.mjs` holds the pinned artifact hashes and **refuses to write a manifest whose files do not match them**.
- `src/speech/local/assetManifest.test.ts` hashes the shipped files from disk and compares them with the manifest, so a swapped or truncated asset fails the suite.
- `public/voice/espeak/espeakng.bootstrap.js` checks the served bytes at run time and refuses to start the module on any mismatch, so a bad component fails closed instead of phonemizing.

## Open question

Whether the narrator worker bundle forms a single combined work with the eSpeak-NG component, so that GPLv3 section 5(c) would require the bundle as a whole to be licensed under the GPL, is **unresolved and is with a lawyer**. Shipping these notices and the source offer does not answer it.

Also still unconfirmed: written confirmation from KittenML that `voices.npz`, and the `jasper.f32` derived from it, are distributable under the declared Apache-2.0 (the Hub repository has no `LICENSE` file and the model card does not document the voice source). Those files are not in this repository and are staged outside it for the private trial only.
