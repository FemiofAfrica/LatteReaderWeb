# Desktop console review and verification

## Scope and coverage

Screen/flow review and implementation of the local PDF Reader console, starting at `d76b4c4`. React/TypeScript/Vite, existing project CSS, coffee palette/bezel surfaces and native controls retained. Guidelines inspected: `README.md`, `docs/reading-quality.md`, `docs/testing-diagnostics.md`, and the LatteReader product skill. No repository AGENTS, CONTRIBUTING or separate design-system guide was found. No speech planning, extraction mapping, accounts, document storage or deployment changes.

| Domain | Evidence inspected | Result |
| --- | --- | --- |
| Accessibility | Native controls, focus walk, desktop and mobile keyboard navigation, CDP accessible names, axe with voices and disclosures expanded, reduced-motion CSS, deletion confirmation | Fixed semantic/keyboard gaps; zero axe violations in tested desktop state |
| Layout | Supplied screenshot; real before/after renders; four desktop geometries; tall 300-page fixture; expanded metadata, engine and diagnostics; 60 cloned long speaker rows; invalid-upload state; mobile and zoom reflow | Fixed scroll ownership, clipping and grouping |
| Writing | Metadata/privacy/engine copy, analysis/recovery messages, destructive labels | Shorter routine copy; recovery/privacy information retained |
| Typography | Long filename, character names, changing counters, mobile numeric input, transcript | Full filename in disclosure; wrapping speaker names; tabular counters; 16px mobile numeric input |
| Colors | Nine computed foreground colors against screenshot-sampled rendered backgrounds; primary/selected/secondary treatment | All measured text pairs exceed 4.5:1; retained palette |
| UI | CurrentColor icons, inherited bezel/control styling, primary action hierarchy, active and reduced-motion behavior, actual screenshots | Compact control groups; Play is the primary action |

Empty, restored, loaded, extraction-wait, invalid-upload, worker failure, renderer failure, playback and disclosure states were exercised across relevant suites. This is not a full cross-browser or screen-reader certification.

## Ranked findings implemented

Locations refer to the resulting source; before descriptions refer to the original implementation.

| Severity | Domain | Location | Before | After | Why |
| --- | --- | --- | --- | --- | --- |
| HIGH | Layout | `src/styles.css:348`, `src/styles.css:351`, `src/styles.css:354`, `src/styles.css:401` | Deck only had a minimum height. Expanded state grew the root to 2611/2643px and displaced transport; requested inner scrolling did not happen. | Viewport budget, shrink-safe workspace, anchored chrome, bounded PDF/transcript scrollport. | Critical Play and navigation must remain reachable. |
| HIGH | Layout | `src/styles.css:354`, `src/styles.css:373`, `src/styles.css:406` | Sidebar/diagnostics grew with content. | Fixed sidebar shell; bounded, keyboard-scrollable metadata/engine/list/diagnostics content. Long list and error-state rectangles verified within rail. | Growth cannot hide analysis controls or voices. |
| HIGH | Accessibility | `src/App.tsx:33`, `src/styles.css:260`, `src/styles.css:439` | Width-only adaptation left insufficient height at 200% reflow, particularly 960x540. | Synchronized narrow-or-short Reader mode; compact short-height rows keep all functional controls. | Controls/content must remain reachable when zoom reduces both viewport dimensions. |
| HIGH | Accessibility | `src/App.tsx:577` | Restore-failure clear action bypassed confirmation. | Native confirmation names deletion of PDF and reader data. | Destructive recovery must not silently erase data. |
| MEDIUM | Layout | `src/App.tsx:629`, `src/App.tsx:650`, `src/styles.css:380`, `src/styles.css:426` | Oversized pager, duplicate current page, remote zoom in footer, detached scope/speed. | Previous, page input, total, next together; zoom beside Fit width; scope and speed in compact groups. Wide toolbar is 68px instead of 195px. | Grouping improves discoverability and returns space to the PDF. |
| MEDIUM | Accessibility | `src/App.tsx:534`, `src/App.tsx:554`, `src/App.tsx:618`, `src/App.tsx:705`, `src/components/PdfCanvas.tsx:65` | No skip path, hidden file input in tab sequence, label on generic page wrapper, tabs lacked arrows/Home/End. | Skip link, picker reached through visible button, named groups, roving keyboard tabs. | Keyboard and accessible naming must match pointer capability. |
| MEDIUM | Writing | `src/App.tsx:594`, `src/App.tsx:596`, `src/App.tsx:610` | Permanent storage and engine paragraphs dominated the sidebar. | Short privacy statement; explicit file/storage and browser-voice disclosures retain detail and full filename. | Routine copy should not bury controls or lose essential information. |
| MEDIUM | Colors | `src/App.tsx:549`, `src/App.tsx:615`, `src/styles.css:357` | Replace and Analyze competed with Play as filled actions. | Neutral secondary actions; gold Play primary. Scope gold encodes checked state, not a competing action. | Distinguish task priority from selected state. |
| LOW | Typography/UI | `src/styles.css:27`, `src/styles.css:375`, `src/styles.css:399`, `src/styles.css:433` | Truncated speaker labels, non-tabular changing values, desktop nested transcript scrolling and unguarded press movement. | Wrapping names, tabular values, readable single-scrollport transcript, press scale only with no-preference motion. | Preserve readable content and avoid unnecessary motion or nested document scrolling. |

## Measurements

The owned fixture has 300 real PDF pages, 632,436 extracted characters and a 1000px-tall native page. The application caps detected voices at six; the additional 60 long rows are explicitly a DOM-only layout stress, not fabricated application output. Measurements below include expanded metadata, engine information, diagnostics and this long list.

| Desktop | Root/body scrollHeight = clientHeight | Body scrollWidth = clientWidth | Inner scrollTop after scroll | Toolbar height before / after | Viewer height after |
| --- | --- | --- | --- | --- | --- |
| 1024x768 | 768 = 768 | 1024 = 1024 | 450 | 237.4 / 119 | 391 |
| 1100x800 | 800 = 800 | 1100 = 1100 | 450 | 237.4 / 119 | 423 |
| 1440x900 | 900 = 900 | 1440 = 1440 | 450 | 195.4 / 68 | 566 |
| 1920x1080 | 1080 = 1080 | 1920 = 1920 | 348 (maximum) | 195.4 / 68 | 746 |

Every recorded header/sidebar/toolbar/transport rectangle is identical before and after viewer scrolling. Each vertical delta is exactly 0px. PDF center delta from its viewer center is exactly 0px at all four sizes. Pointer hit-testing passes for enabled toolbar/transport controls. Invalid replacement also leaves the fully expanded sidebar inside its measured bounds.

Mobile widths 320/390/504/768 have zero horizontal body overflow and all three Reader tabs. Fit/manual override, pinned top/bottom, continuous speech, selection and local persistence suites pass. 200% reflow equivalents 512x384, 550x400, 720x450 and 960x540 retain every control. Their header bottom is 225px and bottom-bar tops are 313/329/379/469px. These are CSS-pixel reflow tests, not a claim that browser chrome zoom controls were automated.

Text contrast from computed foreground and sampled rendered background: headings 5.78:1; file facts 5.58:1; copy 7.02:1; diagnostics 6.28:1; secondary button 12.39:1; page label 5.76:1; zoom readout 7.34:1; checked scope 8.61:1; playback copy 5.90:1. No palette replacement was needed.

## Verification

Passed:

- Node 22.23.3 clean `npm ci`, build and 77 tests across 12 files, with `/root/node_modules` hidden by bwrap. Forced `tsc -b --force --pretty false` also passes. Latest source rebuilt in the same clean install.
- `LATTE_READER_URL=http://127.0.0.1:4192/ npm run test:desktop` with `LATTE_AXE_PATH` pointing to an axe-core bundle installed outside the repo. Zero assertions fail, zero axe violations; named controls, keyboard next/jump/zoom/fit, mobile arrows/Home and focus indicators checked.
- Against the same isolated static preview: `test:browser`, `test:mobile`, `test:layout`, `test:fit`, `test:sticky`, `test:reading`, `test:textpanel`, `test:compatibility`, `test:workers` all pass.
- `test:textpanel` now retains the mobile half-viewport bound, and replaces desktop's former nested-scroll assertion with actual sole-viewer scroll, zero body growth and stationary chrome. Selection reading is additionally checked on desktop. Desktop transcript scrollTop reaches 1361px with zero header delta in that suite.
- `test:diagnostics` passes on isolated private port 4194 in the clean scratch checkout. Exact log readback, export/clear, rejection guards, real renderer/worker failures and static production zero telemetry pass. Existing tester service, tunnel, logs and credentials were not used or changed.
- `git diff --check` passes. Self-review against the brief and README found no storage/speech/extraction mutations or new UI dependency. Independent parent code review remains the publication gate.

Not verified: audible OS speech, actual VoiceOver/NVDA announcements, RTL/pseudo-localization, interactive Animations-panel replay, other browser engines, and the user's original PDF glyph mapping. No f/ligature substitution was introduced. Healthy/damaged owned reading fixtures still behave as expected; they do not establish the cause in the user's PDF.

## Evidence paths

Under `tests/artifacts/desktop-console/`:

- `before/1440x900.png`, `before/1024x768.png`, `before/evidence.json`
- `after/1440x900.png`, `after/1024x768-stress.png`, `after/1024x768-error.png`
- `after/mobile-320.png`, `after/mobile-390.png`, `after/mobile-504.png`
- `after/200-percent-reflow-512x384.png`, `after/200-percent-reflow-960x540.png`
- `after/evidence.json`, `after/contrast.json`

Screenshots were visually inspected, not inferred from code. Artifacts stay in the local ignored artifacts directory for parent review. Suite outputs are `/root/.hermes/cache/scratch/latte-final-*.log`; clean diagnostics log is `/root/.hermes/cache/scratch/latte-desktop-clean/.runtime/diagnostics/events.jsonl`.

## Verdict

**Approve within the verified desktop/mobile scope.** No confirmed HIGH finding remains in tested states. Local commit only; no push or deployment. Parent independently reviews before publication.
