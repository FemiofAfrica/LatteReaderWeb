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
- The PDF.js bundles are intentionally substantial and load locally with the app.

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

The test uses `tests/fixtures/latte-reader-text-fixture.pdf` and verifies the empty state, PDF rendering, extraction, navigation, zoom, speaker analysis, playback state, invalid-upload preservation, reload restore, one-slot IndexedDB storage, deletion, and layout at 1440 by 1000 and 1024 by 768.

Regenerate the fixture with:

```bash
python tests/fixtures/generate_fixture.py
```
