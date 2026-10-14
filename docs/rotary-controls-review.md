# Rotary controls and independent page browsing

## Scope

Restores the native CoffeeDial-inspired Speed and Zoom controls without changing the coffee-console theme, PDF ownership, text extraction, voices or selection-only semantics. Implements the subsequent approved side-arrow/swipe and continuous-browsing corrections. Background audio, sentence highlighting and sentence seek remain separate work.

Repository guidance: no AGENTS.md, CLAUDE.md or CONTRIBUTING.md found. Existing React/TypeScript/CSS tokens and responsive console rules retained. Native reference: CoffeeDial in PDFReaderSpeaker/LatteReader/Components.swift.

## Delivered

- Matched radial surfaces, restrained 270-degree arcs, readable indicator and contiguous labelled numeric editors. One Speed/Zoom rack in the desktop transport; one rack in the unified mobile Reader. Play retains primary emphasis.
- Native labelled range semantics and keyboard Arrow/Home/End, plus numeric entry with Enter/blur commit and Escape cancellation. Speed remains 0.5–2 in 0.05 steps; zoom uses whole percentages without rounding away fitted values.
- Relative captured vertical pointer drag. Press does not jump, cancel/lost capture ends dragging, and touch does not scroll the page while adjusting a knob. Scoped native touch listener is cleaned up on unmount.
- Zoom minimum lowered from 50% to 25% to fix a real 320px fit failure: the 612px fixture needs 46%, not 50%. Saved manual zoom and explicit Fit width behavior remain intact.
- Viewer arrows occupy desktop gutters; mobile puts them in a small strip outside the PDF rather than covering text. Precise upper pager remains available. Boundary arrows are disabled.
- Single-touch canvas-only swipes use 12px direction lock and 60px turn threshold. Transcript, controls, multi-touch, cancelled gestures and the outer 24px browser-back zones are excluded. Manual enlargement or horizontal overflow disables turning. No viewer-wide touch-action override or vertical preventDefault.
- Browsing preserves active and pending speech, pauses auto-follow and exposes Playing/Paused page, Follow reading and Read from this page. Follow does not restart audio. Only explicit Read from this page replaces the run. Pause, Stop and replacement retain their existing behavior.
- Browsed `reader.currentPage` and optional last-spoken `reader.readingPage` persist separately. Reader saves are document-ID guarded so an old document's delayed save cannot overwrite a replacement's position. Visibility/pagehide saving never cancels speech; reload never auto-starts audio.

## Measured craft

Identical real 300-page fixture, expanded disclosures, diagnostics and DOM-only long speaker-list stress. Same 1024×768 and 1440×900 viewports before and after:

| Measurement | Before | After |
| --- | ---: | ---: |
| 1024px upper toolbar height | 119px | 65px |
| 1024px document viewport height under stress | 391px | 445px |
| 1440px upper toolbar height | 68px | 65px |
| 1440px document viewport height under stress | 566px | 569px |
| Desktop transport height | 80px | 80px |
| Chrome movement during actual PDF inner scrolling | 0px | 0px |

Knob and value baselines match exactly within each rack. Knobs are 60×60 desktop and 56×56 mobile; numeric input hit areas are 74×40 desktop and 70×44 mobile, excluding their surrounding borders. Mobile controls retain 12px outer margins. Side arrows are 40×44 desktop and 44×44 mobile. Labels are 11px/700; values 16px/500 with tabular numerals. No new motion was added.

Computed foregrounds and screenshot-sampled backgrounds: label foam #e8ddd0 on mobile chrome #2c221a = 11.61:1; desktop label on sampled #2a2119 = 11.79:1; value butter #e8c56e on #221a13 = 10.32:1. Butter focus against crema #61513e = 4.59:1. Forced colors reveals the native ranges and numeric fields and retains a measured 3px keyboard focus ring.

Accessibility, layout, writing, typography, colors and UI owners were all applied. Corrected findings were missing tactile controls, fragmented adjustment placement, 320px fitted overflow and short active-browsing reflow. No unresolved blocking finding in the inspected slice. Manual screen-reader and physical-device testing are not claimed.

## Execution evidence

All browser commands explicitly target the isolated loopback preview `http://127.0.0.1:4192/`. Tester preview/tunnel were not restarted; nothing was published.

- `npm run typecheck`: passed.
- `npm run build`: passed; production stays static and the existing no-private-marker test passes.
- `npm test`: 14 files, 88 tests passed.
- `test:rotary`: passed at 320/390/504/768/1024/1440, plus active browsing at 512×384. Actual Chromium CDP touch left/right/cancel/vertical/pan/knob gestures exercised.
- `test:desktop`: passed 1024/1100/1440/1920, mobile widths and short 200% reflow. Full-page axe audit returned no violations with the external axe bundle.
- `test:mobile`, `test:fit`, `test:sticky`, `test:reading`, `test:browser`, `test:compatibility`, `test:layout`, `test:textpanel`, `test:workers`: passed.
- Rotary rack axe audit returned no violations at every primary width. Accessible snapshots are saved in the rotary report.
- Reading rate 1.25 reached the actual SpeechSynthesis request; 120% rendered the fixture at 734px. Fit readouts were 46/57/76/119% at 320/390/504/768.
- Browsed page 1 and spoken page 2 were read back independently from IndexedDB. Browsing and Follow retained the same speech start/cancel counts. Explicit Read from this page started one replacement run. Hide did not change start/cancel counts. Reload started zero utterances.
- Existing mobile/reading assertions were updated to test the visible pager and approved browse-without-cancellation semantics, not removed.

## Local screenshot artifacts

`tests/artifacts/rotary-controls/` contains ready and empty states for each primary width, keyboard-focus, drag, forced-colors, browsing-while-playing, active-browsing-320x900, active-browsing-512x384 and touch-follow PNGs, plus `report.json`.

Desktop before/after screenshots and measured evidence: `tests/artifacts/desktop-console/{before,after}/`. Sticky pixel/position evidence: existing sticky suite artifacts. Screenshot QC inspected actual 320, 504, 1024 stress, 1440, active-browsing and forced-colors images.

## Handoff and limits

- Parent review/merge/publish remains pending. This is a local branch commit only.
- SpeechSynthesis was exercised through an API harness, not audible output. It remains browser/OS-managed and may suspend or disappear in background or screen-off conditions. No Media Session, silent audio, wake lock, backend or cloud TTS was added. Background capability belongs to issue #1.
- Touch verified in Chromium emulation, not native iOS/Safari hardware; browser-edge navigation and screen-reader announcements still need device validation. Pagehide persistence is best effort, not an OS-kill guarantee.
- Future highlight/seek should extend the source-boundary callback seam in SpeechEngine, not derive a spoken position from the browsed page. This slice separates page state but does not invent sentence/character evidence.
- Keep selection-only behavior unless explicit separate continuation UX is approved. Do not guess unknown glyphs or substitute dictionary text. The recovered Grok review remains hypothesis/context for the next bounded pass, not authorization for silent text repair.
