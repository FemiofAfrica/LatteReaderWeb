# Private learned narrator integration

The accepted Misaki-derived frontend and original PeterReid learned BART weights now feed the unchanged Kitten Micro graph and Jasper tensor in the reader's built worker. Browser speech remains the default. Private markers no longer select the historical eSpeak worker.

## Pins and consent

`src/speech/local/narratorPins.json` is bundled before consent; selecting Natural voice never fetches voice assets. Enable creates the worker. All 12 component files, including dictionaries, configuration and executable frontend/runtime modules, are length/SHA-256 verified. Verified JavaScript is imported from local blobs; WASM receives verified bytes. The graph is reassembled from two parts and verified as a whole. No CDN, request text/body, eSpeak import or hidden fallback. The uncompressed component total is 63,358,119 bytes plus the built worker and HTTP overhead. Cache/compression/retries change network transfer; the app has no persistent voice cache. Individual files remain below 25 MiB.

## Frontend derivation and limits

`public/voice/narrator/frontend/frontend.mjs` derives dictionary lookup, context and morphology from Misaki 0.9.4 fba1236595f2d2bf21d414ba6e57d25256afada3 (Apache-2.0). Modified to accept verified data without implicit downloads, conservatively refuse malformed numeric forms, and integrate with the reader worker. Dictionaries are unchanged. Independently authored number normalization is retained. No POS/spaCy pipeline is claimed.

`bart.mjs` derives single-layer/head inference from Transformers 4.51.2 BART (Apache-2.0), modified for original F32 safetensors and cached browser decoding. Accepted scratch reference matched 11 NumPy full-sequence predictions, not upstream torch parity. Original model/config revision a5631b285d18d59483c32c0c3379cb9fac924f4b is unchanged. Learned calls are cleared after each request; no source text enters diagnostics.

English only. Unknown graphemes, emoji, non-Latin input, invalid times/numeric forms, negative currency, values at/above one trillion, >62-codepoint learned words and forced-EOS truncations refuse explicitly. Latin diacritics are best-effort transliteration. Name/case and homograph pronunciation are imperfect. Source units must all be accounted and pronounced before inference. Overbudget text splits only at whitespace, preserving source slices; indivisible words refuse rather than being pronounced as fragments. Audio >15 seconds also splits at whitespace. Original codepoint length selects style capped at399, last-index symbol mapping, punctuation, boundary IDs, token limit500, original inference speed and no waveform trimming remain.

## Historical compliance

The prior eSpeak binaries, manifest, licences and corresponding-source archive remain intact in `compliance/espeak/voice/`, outside public and built output, with integrity regression tests. Original scratch and Git history are unchanged. This is not blanket legal/title-chain clearance or permission to publish the proprietary product. Active notices cover Kitten, Misaki, BART and ONNX Runtime at `/voice/notices/index.html`.

## Verification

Use an owned isolated preview and explicitly set LATTE_READER_URL. `scripts/misaki-reader-smoke.mjs` performs real reader synthesis, Web Audio playback-clock checks, pause sample-offset resume, browsing without cancellation, drain, complete owned three-page text coverage with actual learned calls, zero pre-Enable downloads, reload without autoplay, all shipped-input corruption failures and unsupported/token limits. It emits a WAV and JSON evidence. Headless Web Audio is not physical-device audibility, background playback, phone speed or sustained 20-minute proof. Existing suites continue to cover browser reading, selection/continuation, navigation and position seams. Never aim tests at tester4176/4187 or CDP9222.
