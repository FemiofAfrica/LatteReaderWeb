# Private testing diagnostics

PDFs, extracted text, selections, filenames, speakers, voice plans, document hashes,
credentials and browser-storage values are **never** diagnostic fields. Error messages,
stacks and URLs are discarded, not redacted with best-effort regexes. Only fixed event
names/error codes, time, a fresh random session UUID, app version and allowlisted numeric
page/count/zoom/duration fields leave the browser.

## Tester controls

Expand the small **Diagnostics** strip below the coffee console. **Export diagnostics**
downloads the current sanitized JSON buffer. **Clear diagnostics** clears its in-memory
buffer and unsent queue; it does not erase events already received by private preview.
Reload starts a new session and empty buffer. Neither PDF deletion nor diagnostics clear
changes the other's storage. Retention: last 250 events per browser; last 1,000 events
in the private runtime file, of which at most 200 may be `extraction.progress` so per-page
progress can never evict lifecycle/failure history. Per-page progress is coalesced to the
first page, the final page and roughly twenty evenly spaced pages regardless of document
size. That is a rate, not every page. Unsent
transport is capped at 250; batches are at most 25, with a three-second timeout. A failed
batch is re-queued and retried with backoff at most four times, then dropped.
This is best-effort testing evidence, not an audit trail; rapid close/reload may lose
pending events. Diagnostics must never delay document operations.

## Truthful transport state

The strip is derived from real send outcomes, never a single stale flag. `private live`
means the last send succeeded; `live retrying` means a batch is being retried (degraded);
`live unavailable` means sustained failures, or failures with no prior success. Any later
successful send returns the strip to `private live`; a failure is never shown as permanent
after successful ingestion. The expanded panel shows the last successful send time, the
consecutive-failure count and a fixed reason code (`none`, `http-client`, `http-server`,
`timeout`, `network`, `unknown`). Transport transitions also record edge-triggered
`transport.fail`/`transport.recover` events (one per transition, never per attempt).

The strip summary separates the two things a tester reports together, so triage cannot
confuse them: the transport state (`local only`, `live connecting`, `private live`,
`live retrying`, `live unavailable`) and a count of genuine application error events.
A transport retry shows as `live retrying` and still reads `no errors`; only real
application failures increment the count, which uses correct singular (`1 error`) and
plural (`2 errors`) wording. Transport lifecycle events are never counted as application
errors. The expanded panel shows both lines explicitly.

## Reading scope and continuous playback

Play reads from the current page to the end of the document and moves the preview and the
stored reading position with it. Reading scope is stored as `document` (continuous) or
`page` (this page only); stored records are migrated from the old page-only default to
continuous on load, so a document saved before this change no longer restarts page by page.
Page advance records **one** bounded aggregate `playback.complete` event per run (page count
and duration), never an event per page, so a long document cannot flood retention.

## Wizzy: live evidence on Linux

Exact file: `/root/Projects/LatteReaderWeb/.runtime/diagnostics/events.jsonl`

Server-side rejections and client aborts are recorded **content-free** in
`/root/Projects/LatteReaderWeb/.runtime/diagnostics/ingest-rejections.jsonl` records timestamp,
numeric status and a fixed reason code (`not-loopback`, `bad-host`, `method`, `origin`,
`content-type`, `too-large`, `bad-json`, `invalid-batch`, `client-abort`). Never a payload,
URL or header value; bounded to the last 500 entries. A `client-abort` entry is the
signature of an intermittent connection failure mid-send.

Use `read_file` on that exact path, or filter it without reading any document store:

```sh
cd /root/Projects/LatteReaderWeb
python3 -c 'import json,pathlib; rows=[json.loads(s) for s in pathlib.Path(".runtime/diagnostics/events.jsonl").read_text().splitlines()]; print(json.dumps(rows[-50:],indent=2))'
```

Ask the tester for the eight-character session prefix shown in the strip, action, page
and approximate time (not PDF text). Filter `sessionId` by that prefix, order by
`timestamp`, then inspect `severity == "error"`. App version is `0.1.0-diag.1`.

- `upload.fail` without `upload.replaced`: rejected validation; saved PDF preserved.
- `upload.replaced` then `extraction.fail`: replacement succeeded, worker failed.
- `renderer.fail`: page/zoom/duration identify the render attempt; raw error is deliberately absent.
- `analysis.start` → `analysis.complete`/`analysis.fail`: local character analysis.
- `speech.*`: control/engine lifecycle; an event is not proof of audible output.
- `window.error`/`window.rejection`: uncaught browser failure; only a fixed error category survives.
- No live entries? Read the strip's state and reason code, then
  `.runtime/diagnostics/ingest-rejections.jsonl` (`client-abort` points at a dropped
  connection, a 4xx reason at a rejected batch), then service health and tunnel; use local
  export rather than weakening the origin or loopback guards.

## Upload failure reasons

A rejected upload carries exactly one cause, one fixed reason code and one plain sentence.
The code is what triage reads from `upload.fail`; the sentence is what the reader sees. Both
are asserted by test rather than inferred.

| Reason code | Reader sees |
| --- | --- |
| `file-empty` | That file is empty, so your saved document was not changed. |
| `file-not-pdf` | That file is not a PDF, so your saved document was not changed. |
| `file-unreadable` | That file could not be read from where it lives, so your saved document was not changed. Download it first and try again. |
| `pdf-password` | That PDF is locked with a password, so your saved document was not changed. Unlock it and try again. |
| `pdf-damaged` | That PDF is damaged or incomplete, so your saved document was not changed. |
| `pdf-unopened` | That PDF could not be opened, so your saved document was not changed. |
| `storage-full` | There is not enough room in this browser to save that PDF, so your saved document was not changed. |
| `storage-save` | That PDF could not be saved in this browser, so your saved document was not changed. |
| `document-open` | Your new PDF was saved, but it could not be opened for reading. Open the file again to recover. |

The unchanged claim is only made where it is true. Reading the file, the preflight checks,
validation and the replacement all happen before the stored document is touched, so a
failure in any of them leaves it intact. Only `document-open` happens after a successful
replacement. It never claims the document was unchanged, and it states what really
happened. The old coarse `pdf` code is no longer emitted; it stays in the allowlist so logs
written before the split remain readable.

Classification uses PDF.js's own error types (`PasswordException`, `InvalidPDFException`,
`ResponseException`), never message text. The preflight header check scans the first 1024
bytes for `%PDF-` instead of testing the first four, so a real PDF that carries leading
bytes before its header is not rejected as "not a PDF".

Ingestion is idempotent. A batch whose events already landed is acknowledged with 204 and
not written again, so a transport retry cannot duplicate `session.start` or any other
event. The comparison key is built in memory from allowlisted fields only and is never
stored, so the log stays content-free.

Regenerate the refusal fixtures with `python3 tests/fixtures/generate_failure_fixtures.py`
(a valid PDF, a PDF with leading bytes before its header, a non-PDF, an empty file, a
truncated document and a genuine password protected PDF made with pypdf, a fixture tool
only).

## Explicit private preview only

Normal `npm run build` (the public build deployed to lattereader.iririlabs.com) compiles
diagnostics out entirely: no "Help with problems" panel, no event buffer, no marker check
and no `/__latte_diagnostics/events` request (`__LATTE_DIAGNOSTICS__` is `false`). Normal
dev/preview has no transport or ingestion middleware.
To opt in **only** for the private Linux preview, build and serve with the flag:

```sh
LATTE_PRIVATE_DIAGNOSTICS=1 npm run build
LATTE_PRIVATE_DIAGNOSTICS=1 npm run preview -- --host 127.0.0.1 --port 4176 --strictPort
```

The Vite serve-only plugin injects a marker at runtime; the browser also requires a
loopback hostname. The preview matches the request path, so a tester URL that carries a
query string (`/?build=<sha>`) still receives the marker; only the origin-form index path
(`/` or `/index.html`, query/fragment ignored) is marked, never an asset or absolute-form
target. Same-origin POST `/__latte_diagnostics/events` requires matching
Origin, loopback Host/socket, JSON, at most 16 KiB and 25 strictly validated events.
Unknown keys/events or wrong event-specific fields reject the entire batch without
writing. Non-loopback server configuration refuses startup. No GET log endpoint,
CORS access, accounts, document endpoint, public deployment or new dependency exists.
The existing Mac `127.0.0.1:4176` SSH forwarding remains unchanged.

Current Linux preview is managed by transient systemd unit
`latte-reader-private-preview.service` (restart-on-failure, survives this task, not reboot).
Use `systemctl status latte-reader-private-preview --no-pager` and
`curl --fail http://127.0.0.1:4176/` for health. Restart only that unit after rebuilding.
For intentional server-log clearing, stop that unit, remove only
`.runtime/diagnostics/events.jsonl` (and, if desired, `ingest-rejections.jsonl`), then start
it; do not touch document storage or tunnels.
`.runtime/` is Git-ignored and not served as a static directory.

## Mobile layout

At widths up to 780px or heights up to 600px the console uses the unified Reader layout:
Document, Read and Voices tabs, with play and stop always visible. Read is the default and
contains the PDF, navigation, scope/speed and zoom/fit controls. Tabs support arrow keys,
Home and End; the selected panel is marked with `aria-selected` and a shape marker, not
colour alone. The fixed bottom bar reserves its measured height and safe-area space. Short
viewports, including 200% browser-zoom reflow, use compact Reader rows without dropping
functional controls. Larger viewports use a viewport-bound desktop console whose header,
rail, toolbar and transport remain visible while only the PDF/transcript viewport scrolls.
Metadata, voice lists and diagnostics have bounded local disclosures rather than growing
the body. See [desktop console review](desktop-console-review.md) for measured evidence.

```sh
npm run test:mobile   # bar, panel switching, continuous playback at 390x844
npm run test:layout   # 360, 390, 414, 768, 1024, 1440 overflow and bar-over-content sweep
```

## Verification

```sh
npm test
npm run typecheck
npm run build
LATTE_READER_URL=http://127.0.0.1:4176/ npm run test:browser
LATTE_READER_URL=http://127.0.0.1:4176/ npm run test:workers
npm run test:compatibility
npm run test:diagnostics
LATTE_READER_URL=http://127.0.0.1:4176/ npm run test:diagnostics:sustained
LATTE_READER_URL=http://127.0.0.1:4176/ npm run test:diagnostics:transport
LATTE_READER_URL=http://127.0.0.1:4176/ npm run test:mobile
LATTE_READER_URL=http://127.0.0.1:4176/ npm run test:layout
LATTE_READER_URL=http://127.0.0.1:4176/ npm run test:fit
LATTE_READER_URL=http://127.0.0.1:4176/ npm run test:textpanel
LATTE_READER_URL=http://127.0.0.1:4176/ npm run test:sticky
LATTE_READER_URL=http://127.0.0.1:4176/ npm run test:uploads
```

Diagnostics smoke requires enabled private preview and an existing event log (browser
smoke seeds it), reads back the exact runtime file, tests rejected ingestion, local
export/clear, real invalid PDF/renderer exceptions, uncaught errors/rejections, failed
worker loading, and a separate default production preview with no POSTs. Speech checks
mock SpeechSynthesis; they do **not** verify sound on the user's Mac. The smoke script
prints its session UUID: its deliberately triggered failures are test evidence, not
failures encountered by the user. Keep those sessions separate when triaging live tests.

## Embedded-browser PDF compatibility

The modern PDF.js 6.4.299 build calls `Map.prototype.getOrInsertComputed` in page-render
state and PDF object caches; runtimes lacking that newly available API fail rendering.
Use upstream **legacy** PDF.js and its matching legacy parser worker in both UI and
extraction realms. These include the package's reviewed core-js compatibility before
library execution; no app-authored global polyfill or version downgrade was added.
PDF loading stays lazy and parsing stays in dedicated workers.

`test:compatibility` removes Map upsert APIs from the page and all three worker realms
before execution using recursive CDP attachment, then proves extraction, canvas rendering,
navigation and zoom. Network routing alone does not reach nested workers. The original
modern build failed the canvas test; the legacy build passes. The user-facing renderer
error is now plain recovery guidance, not raw PDF.js internals.

References: [upstream legacy guidance](https://github.com/mozilla/pdfjs-dist),
[Map API compatibility](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Map/getOrInsertComputed).
