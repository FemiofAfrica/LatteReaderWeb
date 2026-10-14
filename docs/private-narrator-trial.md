# Private Kitten Micro browser-reader trial

This is a locally committed experiment, not a public release or a default-engine migration. Native PDFReaderSpeaker and installed app bundles were not modified.

## Running the private reader

Only `scripts/private-narrator-preview.mjs` injects the trial flag. Standard built HTML has no flag, makes no narrator requests, and offers browser speech as before. No model, voice, phonemizer or ORT binary is in the repository or `dist`.

```sh
node scripts/stage-private-narrator.mjs APPROVED_EXISTING_FEASIBILITY_DIRECTORY OUTSIDE_REPOSITORY_DIRECTORY
LATTE_NARRATOR_ASSETS=OUTSIDE_REPOSITORY_DIRECTORY PORT=4187 node scripts/private-narrator-preview.mjs
```

The preview binds IPv4 loopback and checks the loopback Host; only GET/HEAD are accepted. It serves approved existing private assets, never fetches a model or sends text to a service. No new packages or asset downloads were needed. ORT Web 1.24.3, phonemizer 1.2.1, Micro revision `1ccf72b2c2048fd17efac7de2fab32d10e225084`, Jasper 400×256 float32. Stage script verifies model/Jasper hashes and reads back every copied file. Total staged bytes including notices/metadata: 55,616,828. Assets have no persistent application cache; the session can reuse its loaded runtime.

In Voices, choose **Local narrator (test)**, then **Enable local narrator**. Preparation never starts from page load or engine selection. Once ready, press Play separately. **Cancel and release voice** terminates the worker and releases the audio context. Browser default is reversible and engine choice is not persisted. Existing per-character browser assignments are retained but ignored by Jasper.

## Engine contract

- Genuine dedicated-worker, single-thread ORT WASM synthesis, transferable finite mono 24 kHz PCM. No prerecorded audio substitutes.
- One inference in flight; at most one current and two ready buffers; ready/current PCM budget <=30 seconds. Results over 15 seconds and over-500-token requests are split into exact source slices and regenerated, not truncated. Normal source slices are <=250 UTF-16 units without cutting surrogate pairs. Unknown IPA fails explicitly.
- Style row uses original input code-point length (max 399); duplicate symbol mapping follows the audited source. Curly quotes/apostrophes map to same-length straight characters for the phonemizer; existing mapped PDF normalization remains the source-offset authority. No blanket waveform-tail trim.
- Audio-clock pause retains the sample offset; Resume reuses that buffer. Stop/seek/engine change/document replacement invalidates old inference and audio callbacks. Cancellation during preparation terminates the worker/downloads. Browser speech API behavior is unchanged.
- Source follow highlights the **playing chunk**, not guessed words. Cross-page chunks remain on their start page until completion. Buffering never advances the source. Browsing preserves playback and suspends follow, while explicit seek replaces the run. Selection-only and selection-to-end remain separate reader actions.
- Buffering, readiness and failure are visible. No automatic cloud/browser fallback. Foreground trial only, no background/lock-screen promises, no generated-audio persistence.

## Real Mac evidence

Actual SSH machine: arm64, macOS 27.2, MacBookPro17,1, 8 CPU cores, 8,589,934,592 bytes RAM. Actual CDP browser: Dia Chromium 155.0.8059.40. Its reduced UA says `Macintosh; Intel Mac OS X 10_15_7` and `navigator.platform` says MacIntel; these are browser compatibility strings, not actual CPU/OS claims. CDP was forwarded from that Mac, not from a Linux browser. Safe isolated installed Dia automation profile was used; live Dia was not quit or killed. A fresh clean-profile Dia probe briefly answered then exited, so the installed isolated automation launcher was used instead.

Ten initialized typical sentence requests ran concurrently with real PDF page navigation:

| Measurement | Actual Mac | Earlier Linux feasibility |
|---|---:|---:|
| Warm generation p95 | 4.2014 s | 8.203 s |
| Warm RTF p95 | 0.79647 | 2.090 |
| Target <=3 s latency | FAIL | FAIL |
| Target <=0.8 RTF | PASS, marginal | FAIL |

Mac 0.5x single probe: RTF 0.55741; 2x single probe: 0.73993 (not distributions). Private tunnel cold prepare was ~27 s for the benchmark and ~31 s for the reader; transfer and graph time were not separated. No cached-init claim. Main-thread 50 ms probe: 1,474 ticks, max gap 318.4 ms, one gap >200 ms. Main-page JS heap ~10.15 MB does **not** include worker/WASM/model/process memory and is not a total-memory measurement. Largest benchmark PCM result: 1,000,800 bytes.

Actual integrated PDF reader run proved:
- No narrator GET before explicit Enable, including after engine selection.
- Exact cross-page input covers the owned 103-character reading fixture, including normalized ligatures and repeated letters; finite genuine waveform generation.
- Web Audio sources started in a running Mac AudioContext; pause stopped the source and resume started at retained offset 7.2 s, without re-synthesis of that buffer.
- Page browsing while paused did not discard PCM; Stop prevented late starts.
- A second complete two-chunk run played 11.25 seconds of generated PCM through the Mac AudioContext, followed to page 2 at chunk completion, and returned to Ready. Zero generation underruns; max buffered duration 11.25 s, one ready buffer. This is short-pipeline evidence, **not** a 20-minute test or acoustic proof.
- Seventeen requests, all private loopback GETs with no bodies or external inference. No page errors. Valid desktop screenshots capture the trial UI and retained reader controls; the 504px Mac screenshot returned a zero-byte file and is **not** visual evidence. Its capture remains unresolved.

Raw evidence has also been copied outside scratch to the git-excluded `.runtime/narrator-trial-evidence/` directory. Raw evidence and real Mac-produced WAVs: `/root/.hermes/cache/scratch/latte-mac-narrator-trial/` (`mac-benchmark.json`, `reader-results.json`, `mac-reader-playing.png`, `mac-reader.png`, `mac-voices-504.png`, `mac-chunk-1.wav` through `mac-chunk-4.wav`). WAV capture is waveform transfer from the actual Mac worker, not microphone/speaker recording. No human listener has confirmed this integrated Mac output, audibility, final syllables or join continuity.

Reproduce from repository root:

```sh
LATTE_CDP=http://127.0.0.1:9222 LATTE_READER_URL=http://127.0.0.1:4187/ node scripts/private-narrator-reader-smoke.mjs
LATTE_CDP=http://127.0.0.1:9222 LATTE_READER_URL=http://127.0.0.1:4187/ node scripts/private-narrator-benchmark.mjs
```

## Verification and delivery limits

Build, typecheck, all 136 unit tests, existing real-browser reading, selection, spoken-position, rotary and Map-compatibility/worker-parser checks passed. The general browser smoke initially failed on stale expected labels `playing`/`ready`; baseline `543b316` already displays `Reading`/`Stopped`, so those two assertions were corrected and its full persistence/upload/navigation smoke passed. Browser speech in those existing suites is mocked and does not establish audible speech. The selection npm wrapper could not regenerate its fixture because system Python lacks reportlab; the existing owned fixture was used by the actual selection smoke, which passed. No-mistakes cannot run: repository is not initialized, daemon stopped, and no configured native/ACP review agent is installed. No claim of independent automated review/CI.

Linux service-manager preview `latte-narrator-trial-preview.service` and self-restarting reverse tunnel `latte-narrator-trial-tunnel.service` successfully exposed `http://127.0.0.1:4187/` on the Mac during the measured runs. Remote HTTP and the actual rendered Mac reader were verified then. At final verification the Mac became unreachable: two Tailscale pings timed out, SSH timed out after retry, and CDP refused connection. The final rerun (including the newly added real paused-seek assertion) is therefore blocked; earlier successful Mac inference/playback is preserved, but current Mac reachability and latest-bundle rerender are not claimed. Linux preview remains active. These are **transient** systemd units, not boot-persistent units. Installation of permanent units was approval-blocked and was not retried; durability/restart-kill testing is unverified. Staged permanent-unit files remain under scratch. A verified private runtime copy exists at `/root/.hermes/latte-private-narrator-runtime`, but the current transient preview still points to the earlier scratch feasibility directory. Do not claim the preview survives reboot or scratch pruning. Existing 4176 preview/tunnel were not restarted.

## Go/no-go

The Mac can synthesize this small corpus slightly faster than playback at 1x, and the short reader pipeline keeps up. Startup and first-chunk latency remain too slow for the proposed target; p95 throughput has little margin. No default migration or public release is approved. Before broader support: human Mac audition, >=20-minute foreground pipeline, full-speed distributions, actual process memory/thermal/battery measurements, embedded-browser and physical mobile tests, interruption/recovery checks, and licensing review.

Pinned model/wrapper licenses do not settle compiled eSpeak-NG GPL/source-distribution obligations. Native/browser dictionary parity remains partial (earlier feasibility matched four of six sequences), and the exact compiled data/source provenance is unresolved. Micro exceeds Pages' per-file limit. No public assets, hosting provision, push, native build, new security permissions or license bypass occurred.
