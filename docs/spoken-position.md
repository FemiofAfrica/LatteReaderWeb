# Spoken position, read-along and seek

## Contract

- PDF remains the default view. **Read-along text** switches to an explicitly labelled, local extracted-text transcript. This is not a PDF overlay or a claim of PDF geometric alignment. The existing closed-by-default selection disclosure remains available.
- Each speech-input UTF-16 character carries its original extracted-page offset. Ligature expansion, collapsed whitespace and soft-hyphen removal preserve provenance. Voice-plan blocks are located in source order, so identical blocks do not map to the first occurrence. Unmatched/stale blocks have no source mapping and cannot invent highlights.
- Actual synthesis `boundary` events select the containing sentence and its source ranges, including sentences crossing pages or bounded utterances. The transcript scrolls locally only while playing and following. Browsing suspends follow without cancelling speech or erasing the spoken position. Follow reading rejoins the source page without a speech restart.
- Voices without boundaries have **no sentence highlight**. The visible explanation says that coarse position changes only on utterance start/end. No timer estimates speech position. Pause retains the confirmed mark in a paused colour; Stop, end, failure, upload and deletion clear it.
- Previous sentence moves to the previous sentence start; Next sentence moves to the following start, or the end of the run. At the endpoint, Previous goes to the final sentence. Blank pages are skipped naturally by source-aware planning.
- The native range seeks a character offset in the current reading plan, not an audio time. Its percentage is relative to the reading text (from the selected start page to the run's end, or the page-only run). Pointer/touch drags commit on release, keyboard adjustments on key release, and blur commits an outstanding value. It preserves voice assignments, bounded chunks and source provenance.
- Playing seeks replace the run and resume from the requested character. Paused seeks cancel old speech but remain paused until Resume. Ready/stopped seeks are silent until Play. Endpoint seeks end without queuing speech. Stop clears a pending seek and highlights, retaining the readout; ordinary Play starts from the visible page unless the reader has explicitly sought after Stop.
- During incomplete extraction, seek/skip controls are disabled. Continuous Play retains the existing extraction wait, pause/resume and timeout behaviour. Selection-only runs disable document seeking and remain selection-only.
- Existing local storage preserves browsed/spoken **pages** and never auto-starts after reload. This slice does not persist character offsets across reload.
- Source positions and source text remain in memory/UI, never diagnostics. No new diagnostic event fields or boundary-event logging were added.

## Pager correction

There is one permanent precise pager in the reading header. The old gutter buttons and mobile "Turn page" strip are removed. Desktop canvas-edge buttons are transparent at rest, reveal subtle arrows on canvas hover or keyboard focus, and use labelled disabled-at-boundary controls. Each hotspot is confined to the outer 24px of the canvas and is 48px high, with no opaque text-covering panel. Mobile, short reflow and coarse-pointer layouts hide these controls entirely; mobile uses the existing safe swipes plus header pager. All paths use the existing browse callback, not a speech seek.

## Verification

Run against an isolated built preview, never the live tester's port:

```sh
npm run typecheck
npm run build
npm test
LATTE_READER_URL=http://127.0.0.1:4194/ npm run test:spoken-position
```

`test:spoken-position` generates an owned three-page PDF (including a real blank page) and verifies source-range text equality, repeated sentence offsets, no-boundary fallback, local autoscroll, browse/follow separation, paused and stopped seeks, keyboard Home/End, start/middle/end, cross-page sentence skips, stale callback rejection, real desktop pointer dragging and Chromium touch dragging. It measures transcript bottom against the fixed bar and saves desktop/mobile images plus JSON evidence in `tests/artifacts/spoken-position/`.

Final verification: 99 unit tests in 16 files passed; strict typecheck/build passed. Browser suites `test:spoken-position`, `test:reading`, `test:rotary`, `test:mobile`, `test:desktop`, `test:fit`, `test:sticky`, and `test:compatibility` passed. Per-suite outputs are in `tests/artifacts/spoken-position/test-*.log`, with exit codes in `regressions.json`. Final screenshots were inspected; the mobile transcript bottom is 776px against the fixed bar at 777px, and desktop transcript bottom is 720.59px against transport at 766px.

## Limits

Speech verification uses a synthesis boundary harness: it establishes exact API input, callback and source behaviour, not audibility, voice-specific native boundary support or physical iOS behaviour. Sentence splitting is punctuation-based, not a linguistic model; abbreviations can produce short sentence units. PDF geometric text-layer alignment, character-offset restoration, large-book memory optimisation, unknown-glyph recovery, selection continuation, background/screen-off audio and cloud TTS are not part of this slice.
