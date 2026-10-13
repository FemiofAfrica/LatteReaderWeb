# Reading fidelity and unified reader

## Behavior

- Read is the primary view: PDF page, previous/next/jump, reading scope, speed, zoom/fit-width and transport. Mobile has exactly Document, Read, Voices. Desktop retains the coffee-console rail/page arrangement.
- Manual page navigation stops both active speech and pending extraction waits. It never starts speech. Play then starts from the displayed page.
- Document scope plans source-aware utterances of at most 1,200 characters. Adjacent pages of the same voice are joined as whitespace, not punctuation. Sentence endings are preferred split points; oversized sentences split at whitespace, and oversized individual tokens at the bound. Voice changes remain utterance boundaries.
- Each chunk carries page spans expressed in offsets of its actual spoken text. `onstart` follows the first span; `onboundary.charIndex` follows the entered page. Voices without boundary callbacks follow the final span only at utterance completion. Merely buffering a later page never advances the preview or saved position.
- There is one cancellation at the start of a user run, not a cancel/restart per page or normal chunk. Pause/resume preserves the current utterance or pending next chunk. Stop, errors, duplicate events and stale callbacks cannot continue a cancelled run. A speech failure stops rather than silently skipping text; retry starts from the visible page, not the book beginning.
- Continuous reading requested before extraction completes waits for extraction (up to 15 seconds) instead of truncating the sentence at the last available page. Pause holds that pending run; manual navigation/Stop cancels it. Timeout/error leaves the displayed position intact and asks the reader to retry once extraction is ready. Page-only and selection reads do not wait for the whole document.
- Explicit Unicode soft-hyphen wraps are removed, including between pages. Hard hyphens are retained: there is no dictionary guess about whether a wrap is lexical. Known presentation ligatures are expanded explicitly; blanket NFKC is not applied.
- Stored PDFs are re-extracted on restore. Saved voice plans are reanalyzed from the new extraction before use, so old segment text cannot bypass the current normalization. Storage remains one current PDF.

## Missing-f investigation

The original worker forwarded `TextItem.str` unchanged; the speech engine did not strip ordinary `f`. Previously observed source words containing NUL point to damaged/unmapped glyph text, but cannot establish that every missing glyph means `f`, `ff` or `fi`.

`tests/fixtures/generate_reading_quality.py` generates an owned embedded-FreeSans PDF containing ordinary f/ff/fi/fl/ffi/ffl, presentation ligatures and curly quotation marks. Its second fixture changes exactly the ToUnicode entry for the drawn ff ligature from `<FB00>` to `<0000>`, preserving stream lengths and xref offsets. This reproduces the mapping failure while leaving the font/drawn glyph intact.

Actual upstream PDF.js extraction (`npm run test:extraction-quality`) returned:

```text
healthy: f ff fi fl ffi ffl ff fi fl ffi ffl “fine” Five fine friends
broken:  f ff fi fl ffi ffl \u0000 fi fl ffi ffl “fine” Five fine friends
```

PDF.js already expands these correctly mapped ligatures. The failure therefore exists upstream of application speech, in the deliberately damaged mapping. Public `getTextContent()` exposes decoded strings, font names/styles and positions, not a reliable original-glyph-to-language recovery for this NUL. Font-family information alone cannot tell whether an unknown glyph was f, ff, fi or something unrelated. No blind replacement was implemented.

The application now detects NUL/replacement characters, retains an explicit replacement marker and warns in Read that letters could not be extracted. Reliable recovery of damaged source mappings still requires a corrected text export, source-specific font analysis or local OCR (not implemented). The user's private PDF was not accessed; its exact mapping defect is **not proven** by this representative fixture.

## Exact speech evidence

The real browser uploads, extracts in the worker, renders and reads the healthy fixture. A synthesis-input harness asserted this exact request:

```text
f ff fi fl ffi ffl ff fi fl ffi ffl “fine” Five fine friends find fresh coffee. A well-known difference.
```

The page-1/page-2 split after `friends` produces neither synthetic punctuation nor a separate page utterance. The damaged fixture is detected without inventing replacement letters. The harness delays genuine worker messages to prove extraction waits, pause/resume and manual-jump cancellation.

This is evidence of API input and control behavior, **not audible output**. Browser/OS voices may still pause at bounded utterance or voice-change boundaries, may not emit boundary events, and may be constrained in background/mobile use. Gapless audio or audible mobile quality is not guaranteed.

## Verification and artifacts

- Clean Node 22.23.3 source copy, `npm ci`, ancestor `/root/node_modules` hidden with bwrap, forced strict `tsc -b --force`, production build before tests.
- Unit tests assert exact speech text, source spans, blank pages, sentence endings, bounded chunks, dialogue voice changes, ligatures, unmapped characters, selection, pause/resume, Stop and errors.
- Browser suites cover upload/render/navigation, restore and one-slot deletion, compatibility in page/nested workers, responsive fit/manual override, selection disclosure, opaque pinned chrome, diagnostics privacy/transport and upload failure preservation.
- `LATTE_READER_URL=http://127.0.0.1:4188/ npm run test:reading` creates screenshots at 360/390/504/768/1440 and `tests/artifacts/reading-quality/evidence.json`. Artifact files are local and ignored by Git.
- Diagnostics verification uses a separate fresh source copy and loopback preview/log, not the tester's running diagnostics log. Production transport remains disabled. No document upload/OCR service or raw-text diagnostic event was added.

Local review only. Do not push `main` until parent review: it auto-deploys.
