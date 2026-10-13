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
in the private runtime file. Unsent transport is capped at 250; batches are at most 25,
with a three-second timeout. Failed batches are dropped, not retried indefinitely.
This is best-effort testing evidence, not an audit trail; rapid close/reload may lose
pending events. Diagnostics must never delay document operations.

## Wizzy: live evidence on Linux

Exact file: `/root/Projects/LatteReaderWeb/.runtime/diagnostics/events.jsonl`

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
- No live entries? Check the strip for `live unavailable`, then service health and tunnel;
  use local export rather than weakening the origin or loopback guards.

## Explicit private preview only

Normal `npm run build` produces a backend-free static app. Normal dev/preview has no
transport or ingestion middleware. No `VITE_*` flag is baked into production.
To opt in **only** for the private Linux preview:

```sh
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
`.runtime/diagnostics/events.jsonl`, then start it; do not touch document storage or tunnels.
`.runtime/` is Git-ignored and not served as a static directory.

## Verification

```sh
npm test
npm run typecheck
npm run build
LATTE_READER_URL=http://127.0.0.1:4176/ npm run test:browser
LATTE_READER_URL=http://127.0.0.1:4176/ npm run test:workers
npm run test:compatibility
npm run test:diagnostics
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
