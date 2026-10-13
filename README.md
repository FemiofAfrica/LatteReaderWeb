# LatteReader Web

LatteReader Web is a local-first PDF reader with a tactile coffee-console interface. This first vertical slice renders one page at a time with PDF.js, extracts text in a dedicated worker, detects likely speakers, and reads selection, page, or document text with the browser SpeechSynthesis API.

## Run locally

Requirements: Node.js 20 or newer.

```bash
npm install
npm run dev
```

Open the local URL printed by Vite. Use **Open PDF** to select a text-based PDF.

## Current document storage

LatteReader has no account, backend, sync, or cloud upload.

- PDF parsing, text extraction, analysis, and speech stay in the browser.
- IndexedDB holds exactly one current-document record containing the PDF bytes, versioned voice plan, reader settings, and current page.
- A valid new PDF replaces the whole current-document record in one IndexedDB transaction.
- A new file is validated before replacement. An invalid upload leaves the working PDF and its saved data untouched.
- Reloading the app restores the current PDF and reruns local text extraction.
- **Delete local data** removes the current PDF, voice plan, settings, and reading position from this browser.
- There is no library, document history, account, or remote copy.

## Capabilities

- Local PDF upload and one-slot local restore
- PDF.js canvas rendering with previous, next, direct page entry, and zoom controls
- Incremental worker-based text extraction and progress metadata
- Filename, page count, current page, extracted character count, and extraction state
- Selection, page, and full-document browser speech
- Play, pause, resume, stop, and speed controls
- Scanned or image-only detection with an OCR-required message
- Deterministic narrator and speaker analysis with up to five character speakers
- Versioned local voice plan and explicit `SpeechEngine` interface
- Keyboard-operable controls, visible focus, labels, and live status announcements
- Responsive desktop and tablet layouts

## Limits in this slice

- Kokoro is not active. Browser SpeechSynthesis is the working no-download engine.
- OCR is not included.
- Browser voices and pause behavior vary by operating system and browser.
- PDF.js remains substantial, but its display API and worker assets are loaded only when opening or restoring a PDF. Canvas drawing and deterministic character analysis still run on the UI thread; PDF parsing and text extraction do not.

## PDF worker architecture

- The preview/validation PDF.js display API runs on the UI thread and communicates with a dedicated PDF.js parser worker.
- A separate extraction controller worker requests pages and emits incremental text/progress messages. It supplies an explicit real nested worker through `GlobalWorkerOptions.workerPort` for PDF.js parsing.
- Both parser workers use the same local `?url` asset; there is no CDN or second emitted copy of the parser bundle.
- Previously, PDF.js automatic worker initialization accessed `window.location` inside the extraction controller, where `window` is absent. It caught that error and selected a fake `LoopbackPort`. Runtime debugger evidence confirmed that fallback parsed inside the extraction controller, **not the UI main thread**. It was an unintended nested-worker setup failure, not an intentional configuration.
- The fix supplies the child worker explicitly; it does not suppress warnings, lower verbosity, or disable workers. The browser regression test fails on any fake-worker warning.

See [the worker audit evidence](docs/pdf-worker-audit.md) for debugger observations and bundle measurements.

## Verification

```bash
npm test
npm run typecheck
npm run build
npm run dev -- --host 127.0.0.1 --port 4173
npm run test:browser
npm audit --omit=dev
```

The browser smoke test expects the running app at `http://127.0.0.1:4173/` by default. Override it when needed:

```bash
LATTE_READER_URL=http://127.0.0.1:5173/ npm run test:browser
```

The test uses `tests/fixtures/latte-reader-text-fixture.pdf` and verifies the empty state, lazy PDF loading, absence of fake-worker warnings, PDF rendering, extraction, navigation, zoom, speaker analysis, mocked playback state, invalid-upload preservation, reload restore, one-slot IndexedDB storage, deletion, and layout at 1440 by 1000 and 1024 by 768. SpeechSynthesis is mocked; audible speech is not verified.

Run the independent thread audit against the **production preview**, not the dev server (Vite transforms dev modules and shifts parser breakpoint locations):

```bash
npm run build
npm run preview -- --host 127.0.0.1 --port 4176
LATTE_READER_URL=http://127.0.0.1:4176/ npm run test:workers
LATTE_READER_URL=http://127.0.0.1:4176/ npm run test:browser
```

The audit recursively attaches Chromium debugger sessions to workers and their children, sets a breakpoint at the shipped PDF.js `PDFDocument.parse` call, and evaluates the actual paused call frames. It asserts distinct preview and extraction parser targets with `DedicatedWorkerGlobalScope`, no `window`/`document`, and a child parser owned by the extraction controller. It also checks real extraction messages (two pages, 365 characters) and zero PDF requests before upload. It does not replace or mock PDF parsing. The breakpoint locator is tied to the installed PDF.js worker source and must be revisited if that implementation changes.

Regenerate the fixture with:

```bash
python tests/fixtures/generate_fixture.py
```
