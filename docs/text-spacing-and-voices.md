# Split text runs and browser voice identity

## Evidence and scope

The owned `tests/fixtures/split-text-items.pdf` renders a word from two touching font runs. PDF.js returns `R` at x=72 with width=10.108 and `o` at x=82.108. The previous worker appended a space after every item, producing `R o`. The current worker joins nearly touching runs on a common baseline and axis, while respecting explicit whitespace and EOL. No word dictionary, character-name exception or missing-glyph guess is involved.

`npm run test:spacing-voices` verifies the real built extraction worker's output, exact SpeechSynthesis input, transcript boundary source ranges and selection-only input. It also checks genuine `R o`, initials, real word gaps and a split apostrophe. Unit coverage includes CJK adjacency, rotated runs, columns, EOL, hyphens and normalized ligature offsets. RTL and vertical logical-end geometry remain conservative: this change does not promise all-script layout reconstruction.

The user's PDF has not been provided. This owned reproduction proves a defect and its bounded repair, not the provenance or audible pronunciation of that particular book.

## Voice choices

- Choose a default reading voice and optional per-character overrides. Blank character choices inherit the default, not an arbitrary installed-voice index.
- Identity is a serialized tuple of voiceURI, name, language and localService. Reordered lists do not change a selection; URI collisions are disambiguated by metadata. Identical tuples are equivalent and collapsed in the chooser. Metadata changes conservatively mark a choice unavailable.
- The mounted watcher reads immediately, listens for `voiceschanged`, polls for up to three seconds, then reports an empty list. The listener remains active for later platform publication and is removed, with timers, on unmount.
- Every utterance resolves against the current list. Missing selections remain saved and visibly unavailable; playback reports the automatic fallback. Fallback stays within the chosen language where known, otherwise the browser language. With no matching listed voice, it sets utterance language and leaves voice null, allowing the browser to try its default. A supported API or empty list does not prove audible output.
- Default and character identities stay in the existing local current-document slot. Re-analysis refreshes text/source segments but keeps matching character choices and enabled settings. Legacy numeric voiceIndex fields remain speaker grouping identifiers only: they cannot recover an old installed voice, and never select/modulo the browser list.
- Choices apply on a new reading run; list churn can resolve a pending later utterance but does not interrupt an already speaking utterance. Restore never automatically speaks. Automatic language comes from the browser, not PDF language detection.

There is no engine/backend swap, cloud TTS integration, new PDF upload, background-audio guarantee or local model download. Browser-provided service voices are labelled separately from device voices; the app cannot guarantee how the browser implements those services.

## Verification

Use a separate loopback preview (not the tester's live service):

```sh
npm run build
npm run preview -- --host 127.0.0.1 --port 4193 --strictPort
LATTE_READER_URL=http://127.0.0.1:4193/ npm run test:spacing-voices
```

The checked-in fixture needs no generator at test time. To regenerate, run `tests/fixtures/generate_split_fixture.py` with a Python interpreter containing reportlab. This generator is deterministic (`invariant=1`). Fixture diagnostics and names in the saved test results belong only to the owned fixture; production diagnostics receive no source text or voice identities.

Additional executed gates: unit suite, typecheck/build, reading, selection, spoken-position, extraction-quality, rotary, mobile, compatibility, workers and desktop console. Generated evidence is under `tests/artifacts/spacing-voices/` (ignored by Git), including real chooser screenshots and raw split-item coordinates. Desktop engine information/chooser uses a bounded local scrollport so expanded metadata and speaker lists do not clip controls. Both chooser hit-testing and the desktop stress regression are exercised.

SpeechSynthesis is mocked in the browser harness. Exact text, selected identity and source mapping are verified; audible pronunciation and mobile screen-off/background playback are not.
