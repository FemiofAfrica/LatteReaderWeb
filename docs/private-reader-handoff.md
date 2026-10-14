# Private reader handoff: learned narrator + plain interface

## Outcome and scope

The accepted eSpeak-free Misaki-derived dictionary/morphology frontend and original learned BART fallback now run inside the reader's built narrator worker. Kitten graph/Jasper tensor, original-text style row and inference conventions are unchanged. Browser voice remains the default and reversible. No push, deployment, repository visibility or application-licence change. The tester's existing dist, ports4176/4187 and CDP9222 were not restarted or used for tests.

The interface now uses Natural voice, Browser voice, Download voice, Preparing voice, Reading and Paused. PDF preparation, character choices, read-along explanations, accessible labels and problem reports also use plain terms. Engineering details remain in repository docs and the reachable Licences page. Privacy and supported-English limits remain explicit. The full current→new inventory is `docs/ui-copy-inventory.json`.

## Verified result

- Standard `npm run build -- --emptyOutDir`, with LATTE_BUILD_OUT pointing at the isolated candidate directory: exit0. Build is a normal Vite artifact, not a private-only prototype.
- Typecheck exit0. Vitest34 files /199 tests passed, exit0.
- All16 named suite entries in `suites-final/exits.json` are exit0: typecheck, unit, reading, selection, spoken-position, compatibility, desktop, mobile, layout, rotary, fit, sticky, textpanel, spacing-voices, readability-accessibility and workers.
- Actual reader synthesis/playback: owned3-page PDF,8 generated parts,43/43 source units,7 real learned calls,29.475 seconds nonzero PCM. Real Web Audio starts in a running context, sample-offset pause/resume, browsing without cancellation, exact continuous source coverage and drain verified. WAV is emitted from actual reader buffers. This is not physical-device audibility or a20-minute/background/phone-performance claim.
- Actual narrator selection-only and selection-to-end both verified, plus silent stopped/paused seeks, Stop with late inference, invalid-replacement preservation, valid replacement without autoplay, unsupported text retaining source and position0, and explicit browser recovery without automatic engine switching.
- Zero voice downloads before Download voice, including after selecting Natural voice and after reload; zero reload autoplay.12 voice component files received and verified;63,358,119 uncompressed component bytes, plus the built app worker/HTTP overhead. UI rounds to about63.4 decimal MB. Graph parts, runtime bundle/glue/WASM, both dictionaries, frontend modules, fallback config/weights all fail closed when corrupted. Refused emoji, non-Latin, malformed numbers/time, unsupported long words/forced EOS and token limit. No external request/body/document-text transfer in the static narrator trace.
- Final UI DOM/label vocabulary audit and30 pointer hit-tests passed at1440×900,504×900,390×844,320×844,960×540 and640×400. Voice dropdown44px, Licences target24px; legal page actually opened. The default coffee-console layout and type sizes are retained. Short reflow controls were proved after real scrolling, not inferred from screenshots.
- Private report UI/export/clear/server readback/static-no-transport and retry/recovery/unavailability checks also exited0 against isolated4305 with scratch-only logs. Both plain unavailable and transient retry states remain distinct. Diagnostic counters/reason codes stay in data rather than ordinary UI. Preview index injection now honours resolved outDir; isolated verification can opt into LATTE_DIAGNOSTICS_DIR without changing the existing default log location.

## Four initial suite failures

All were obsolete copy assertions, not observed behavior regressions: the damaged-text warning, the no-boundary read-along helper, an ambiguous Browser voice text locator after renaming the selector, and two empty/unavailable voice helper assertions. Tests were retained and strengthened with no-jargon, readout/selector agreement and actual empty/default-choice assertions. Exact initial/rerun/final logs remain under the proof directory. No assertion was skipped to obtain green results.

## Copy measurements

Same-scope skill scanner:69 long strings /5,784 characters →65 /4,814. Its unresolved threshold placeholder was discovered and fixed in the skill; the original zero reports are invalid, not reported as a result. The scanner is lexical, so the real DOM counts below are the stronger volume evidence.

Expanded narrator panel:5 prose blocks remain,971→224 characters. Expanded desktop surface:16 prose blocks remain,1,992→729 characters. Expanded mobile/short-reflow voice surface:12 prose blocks remain,1,774→550 characters. Legal/privacy/capability blocks were not silently deleted. Full measurements: `copy-measurements.json`.

## Artifacts and preview

Proof root: `/root/.hermes/cache/scratch/latte-integration-proof/`

- `verification.json`: exact initial/final exit codes, failure classifications, additional proof logs.
- `suites-final/`: durable named suite logs; `build-tested.log`.
- `before/rendered.json`, `before-states/states.json`, `after/rendered.json`, `after-states/states.json`: actual current→new rendered text/labels with screenshots.
- `after/390-voices-expanded.png`, `after/504-voices-expanded.png`, `after-states/reading.png`: final real screenshots reviewed.
- `plain-ui/results.json`: final geometry, hit-tests, visible copy and accessibility-label audit; companion PNGs at all6 viewports.
- `narrator-final/results.json`: full requests, served hashes, audio metrics, consent/reload, refusals and tamper cases.
- `narrator-final/reader-generated.wav`: actual browser reader audio, SHA256 `083474f192e37c27f8ecae64a7d02857a949a14decb8625811f790b12b02369d`.
- `controls/results.json`, `controls/refusal.png`: actual narrator selection/seek/Stop/replacement/error proof.
- `diagnostics-final.log`, `diagnostics-transport.log`, `private-logs/`: actual isolated content-free report readback.

Tested build: `/root/.hermes/cache/scratch/latte-integration-build/`. Owned static loopback preview4302 serves this build. Parent may use that preview or start a fresh standard preview:

```sh
LATTE_BUILD_OUT=/root/.hermes/cache/scratch/latte-integration-build npm run preview -- --host 127.0.0.1 --port 4306 --strictPort
```

Do not switch the user's existing private preview while playback is active. Coordinate the switch separately. The historical private server also accepts LATTE_DIST for a candidate directory; the new engine no longer selects its legacy eSpeak worker from the private marker. Mac delivery/tunnel changes are not part of this handoff.

## Remaining limits

English-only, best-effort Latin diacritics and imperfect names/case/homographs. Learned words are limited to62 codepoints and natural EOS within the publisher's decoding bound. Unsupported formats refuse instead of silently omitting source. No POS/spaCy pipeline, persistent voice cache, precise word timestamps or background guarantee. Headless PCM/Web Audio does not prove physical-device listening. Historical eSpeak binaries/notices/corresponding source remain intact under `compliance/espeak/`, outside active public assets. Full proprietary/public-release approval remains separate.
