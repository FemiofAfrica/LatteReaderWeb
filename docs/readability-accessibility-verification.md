# Readability, playback status and default-voice recovery

## Scope

This local slice preserves Crema Waves branding, PDF worker topology, document schema version 2 and its migration, single-slot local storage, selection reading, speech source mapping, swipes, rotary controls and separate browsed/spoken positions. No deployment, public diagnostics infrastructure or security headers changed.

## Changes

- All extracted pages contribute to `pagesWithReadableText` / `pagesWithoutReadableText`. Short text is usable. Whitespace, control-only and replacement-only text are not. Availability is not scan detection; no image evidence is inferred from missing text.
- No-readable-text and partial-text warnings appear in the reading view. Partial documents remain playable, and entirely unusable pages are skipped by speech planning without altering usable source offsets.
- Extraction failures have fixed startup/runtime/protocol/PDF categories and fixed copy. The existing diagnostics schema still receives its existing coarse `worker` category; this slice does not modify telemetry infrastructure.
- Playback presentation distinguishes Ready, Reading, Paused, Stopped, Finished, Waiting for text, Voice unavailable and errors, without expanding the engine's ready/playing/paused states. Stop preserves the reducer's source page. Reload is silent and returns to Ready.
- Mobile status shares the progress label row. Short reflow uses a concise Position label to preserve page space while browsing during speech. Progress, disclosure and read-along touch rows are at least 44px high. Functional mobile labels use ordinary case; retro headings remain unchanged. Forced-colors focus uses Highlight.
- Transcript height includes its frame inset and is bounded above mobile or desktop transport instead of forcing a 100px minimum under pinned chrome.
- Restore browser default stops the current run without automatically starting another, clears the global and all per-speaker voice keys, persists only that reset plus existing reader settings, and invalidates stale session chunks. Extraction finishing after a reset cannot resurrect captured stored voice assignments. PDF bytes and other settings are retained.
- Automatic now chooses an actually `default: true` English browser voice, never an alphabetically first voice. Without such a voice it passes `voice: null` for the system default and explains the fallback. Character voices require explicit chooser assignments; analysis does not assign installed voices automatically. No new engine/model added.

## Executed evidence

All browser commands used a separate built Vite preview at `http://127.0.0.1:4194/`, not the tester's 4176 service.

- Build and typecheck passed. Vitest: 22 files / 129 tests passed.
- `test:readability-accessibility`: actual generated Hi., blank, whitespace, NUL-byte, inline-image and mixed PDFs through PDF.js; short 1/0 readable/missing, mixed 2/2, others 0/1. Play availability and honest warning copy asserted. NUL-byte fixture extracts empty in PDF.js; unit tests separately prove normalized replacement-only text is unusable.
- Real-browser injected startup/runtime/protocol faults verify fixed visible copy and exclusion of raw error text. The PDF failure code and invalid count/enum payloads have unit coverage.
- Visible Ready/Reading/Paused/Stopped/Finished/Voice unavailable transitions and silent reload asserted. `test:reading` holds actual extraction worker output to prove Waiting for text and paused waiting without premature utterances.
- Target, focus and AX checks at 320/390/504x844 and short 960x540 / 640x400: tested progress/disclosure/read-along targets 44px high; zero horizontal overflow; tab arrows/Home state and AX names asserted.
- `test:spacing-voices`: unusual French default plus narrator and Alice overrides -> Restore browser default -> every utterance uses the actual default English identity; all stored keys cleared, PDF bytes and non-voice reader settings unchanged; reload silent and reanalysis retains the reset. Existing delayed/reordered/missing voice identity and explicit assignment regressions also pass.
- Reading, spoken-position, selection, mobile, rotary, fit, layout, desktop, sticky, workers and embedded-capability compatibility suites passed. Worker debugger evidence remains two real DedicatedWorkerGlobalScope parser calls and no fake-worker warning.
- Selection fixture generation used the existing scratch `latte-fixture-venv` interpreter because system Python lacked reportlab; no new environment was provisioned.
- Screenshot review: branding and transport fit retained. Artifacts in `tests/artifacts/readability-accessibility`, `spacing-voices`, `spoken-position`, `rotary-controls`, and existing layout suites (ignored local artifacts).

Two smoke-harness races were corrected rather than weakening product assertions: the 60ms mock selection completion is held until Stop; native numeric-input spinner painting is made consistently visible in the sticky pixel comparison only. Its opacity/geometry checks and moving-viewport evidence remain intact. The rotary expected status changed from Playing to the plain Reading label.

## Desktop screenshot comparison

Measured the same local build at CSS viewports 1366x550, 1440x590 and 1440x900. At both short heights the compact query is true, bottom tabs are present, Speed/Zoom are in the header and desktop transport is absent. At 1440x900 the query is false, tabs are absent and knobs are in desktop transport. All three have zero horizontal overflow; screenshots are `tests/artifacts/readability-accessibility/desktop-height-*.png`.

The exact shared React/CSS threshold is **width <=780px OR height <=600px**, not an OS/device classifier. Windows browser chrome, OS scaling or zoom can therefore produce the friend's compact view on a desktop. An outer 1366x768 window is not proof of a 1366x768 CSS viewport. The screenshot difference alone does not establish a stale build. Keep the short-height guard: the tested 200% 960x540 reflow depends on it. If approved later, a wide-short compact-desktop variant could retain denser desktop naming while preserving all controls, but this slice deliberately makes no new layout variant. Comparing exact deployment/build IDs and measured `innerWidth`/`innerHeight` on both clients is still needed for release proof.

## Boundaries

No automated axe scan or real screen-reader/device-audibility testing was performed; AX snapshots and keyboard/browser checks are not a complete accessibility certification. Mobile background/screen-off speech remains unverified. The real embedded pane was not restarted.

Audit item 6 did not justify a worker rewrite (prior network evidence was one 200 then cached 304 responses). Optional immutable hashed-asset caching was not changed. Item 9's cosmetic App decomposition was deliberately excluded.

CSP is not installed or claimed tested. The audit candidate still needs a report-only local font/image/nested-worker compatibility matrix and an actual embedded-pane/frame-ancestor decision, then parent approval before any external policy deployment. Existing nosniff/referrer protection was not weakened.
