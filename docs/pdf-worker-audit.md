# PDF worker hardening: runtime evidence

## Finding

PDF.js 6.4.299 automatic initialization uses `window.location` before constructing its worker. `window` is absent inside `src/workers/pdf.worker.ts`. The caught exception selected a fake `LoopbackPort` and dynamically imported the parser into that extraction worker. This was an unintended fallback **inside a dedicated worker**, not parsing on the UI thread.

A controlled regression probe temporarily restored `workerSrc`-only configuration, rebuilt, and ran the Chromium debugger audit. It failed with `PDF.js used a fake worker` and reported:

| Actual `parse` target | Parent | Runtime scope | `window` / `document` |
| --- | --- | --- | --- |
| `571714896C96F9D583D1592375779FCE` (preview parser) | page | `DedicatedWorkerGlobalScope` | absent / absent |
| `C0825FA4D11567A73639EE1E81AA859E` (extraction controller itself) | page | `DedicatedWorkerGlobalScope` | absent / absent |

The warning was `Warning: Setting up fake worker.` There was no child parser target. The explicit-worker fix was then restored and rebuilt before final verification.

## Fixed architecture, independently observed

`GlobalWorkerOptions.workerPort` now receives an actual nested module `Worker`. Main-thread preview setup uses `workerSrc` normally. Both use the same Vite `?url` asset, avoiding duplicate emitted parser bundles.

The audit uses CDP debugger breakpoints at the installed worker source's `PDFDocument.parse` call (`this.xref.parse(...)`). It recursively attaches to worker children and evaluates the actual paused call frames, rather than trusting application-reported thread flags. PDF module source and PDF operations are not mocked or replaced. A test-only Worker subclass observes extraction messages without changing their contents.

Final production-preview run (`http://127.0.0.1:4176/`):

| Target | Parent | Role / observed execution |
| --- | --- | --- |
| `AF02665AEE1D567FBE2193B1E86A0045` | page | preview PDF.js parser; paused in `parse` |
| `4571F1FE5255198CCFCB35FDD8C5F2F1` | page | extraction controller |
| `B4B7F6AF136C186BE93D75E96D600281` | `4571F1FE5255198CCFCB35FDD8C5F2F1` | nested extraction PDF.js parser; paused in `parse` |

Both parser call frames reported `DedicatedWorkerGlobalScope`, `hasWindow: false`, and `hasDocument: false`. Their source was `/assets/pdf.worker.min-CjEcRF4W.mjs`. Target IDs are ephemeral observations, not configuration identifiers.

Real controller messages were metadata (2 pages), page 1 (196 cumulative characters), page 2 (365 cumulative characters), and complete (365 characters, `scanned: false`). Fake-worker warnings: zero. PDF requests before upload: zero.

## Bundle measurements

Vite production build sizes (decimal kB, as reported by Vite):

| Asset | Before | After |
| --- | ---: | ---: |
| Initial application JS | 679.52 | 243.01 |
| Initial application JS, gzip | 207.57 | 76.54 |
| Lazy display API (`loadPdf`) | included in initial JS | 436.48 (131.09 gzip) |
| Extraction controller worker | approximately 437 | 437.22 |
| Shared PDF.js parser worker | 1264.34 | 1264.34 |

Initial JS decreased 64.2% (63.1% gzip). This shifts PDF code to opening/restoring a document; it does not shrink the underlying PDF engine. The display API is loaded dynamically only after an upload or a stored PDF is found. Canvas component imports are type-only for PDF.js.

## Verification and limitations

- `npm test`: 10 tests across 3 files passed.
- `npm run typecheck`: passed.
- `npm run build`: passed, with no oversized initial-chunk warning.
- Production `test:browser`: passed rendering, two-page extraction, navigation, zoom, speaker analysis, invalid-upload preservation, restoration, one-slot storage, deletion, and desktop/tablet layout checks.
- Production `test:workers`: passed real parser breakpoints and worker-parent relationships.
- Fresh dev-server browser smoke also passed. The previously running dev server had a stale optimized PDF.js API (5.7.284 versus installed worker 6.4.299); a separate server started with `--force` resolved the cache mismatch. No dependency version changes were made.
- Browser smoke mocks SpeechSynthesis. Audible speech is **not** verified.
- Chromium is the verified browser. Other browsers, nested-worker/CSP restrictions, large-document performance, and worker-load failure UX are not covered by this fixture audit.
- The debugger audit targets production preview: Vite's dev transforms shift source positions. Its breakpoint locator must be revisited when PDF.js changes.
- PDF.js display orchestration, canvas drawing, and deterministic character analysis remain on the UI thread. The evidence establishes PDF parsing/extraction thread placement, not a main-thread-free application or a measured performance guarantee.
- OCR and Kokoro remain outside this slice. An `Indexing all PDF objects` warning during the deliberately invalid upload remains visible and is expected; no warnings are hidden.

Reproduce using the production-preview commands in the README. Nothing was published.
