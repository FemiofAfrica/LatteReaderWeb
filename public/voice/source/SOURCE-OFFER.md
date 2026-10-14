# Corresponding Source offer — eSpeak-NG WebAssembly component

This page is the offer of Corresponding Source for the eSpeak-NG component that
LatteReader Web serves to your browser from `/voice/espeak/`. The source is
served from this same site, at no charge, with no request, registration, e-mail
or password of any kind. It is served for as long as the object code is served.

GNU GPL version 3, section 6(d) is the route we are using: we convey the object
code by offering access from this site, and we offer equivalent access to its
Corresponding Source through the same place.

## Download

| | |
|---|---|
| File | [`/voice/source/espeak-ng-1.52.0-corresponding-source.tar.gz`](./espeak-ng-1.52.0-corresponding-source.tar.gz) |
| Bytes | 18,001,299 |
| SHA-256 | `92a53e12260ad748cb80131b420ab73a4bc3c589296e6dbabd1195aee29a9ca1` |
| Format | gzip-compressed tar. Extract with `tar xzf`. No password, key or special tool is required. |
| Contents | 2,597 files, including a per-file `SOURCE-MANIFEST.sha256` for every file in the archive |

## What this source corresponds to

The exact build whose object code is served at `/voice/espeak/`:

| | |
|---|---|
| Component | eSpeak-NG text-to-speech, English, compiled to WebAssembly |
| Upstream project | <https://github.com/espeak-ng/espeak-ng> |
| Tag | `1.52.0` |
| Commit | `4870adfa25b1a32b4361592f1be8a40337c58d6c` |
| Licence | GNU GPL version 3 or later. There is NO WARRANTY. |
| Toolchain | Emscripten 6.0.12 (release `6e9f6885cb17a3d6c8fd488a5cff730f50aba61d`) |
| Shipped object code | `espeakng.worker.js` (125,613 B), `espeakng.worker.wasm` (371,333 B), `espeakng.worker.data` (904,455 B) |

The three object files are served next to this offer at `/voice/espeak/`, and
their pins and SHA-256 values are recorded in the machine-readable manifest at
[`/voice/espeak/build-manifest.json`](../espeak/build-manifest.json).

## Modification record (GPLv3 sections 5(a) and 5(b))

The archive contains a pristine, unmodified copy of eSpeak-NG at commit
`4870adfa25b1a32b4361592f1be8a40337c58d6c`: the byte-exact output of
`git archive 4870adfa25b1a32b4361592f1be8a40337c58d6c`, verifiable against the
upstream repository. The full notice is in the archive as `MODIFICATIONS`.

We modified the work before compiling it. Three patches were applied, all of them
reproduced in the archive under `build/patches/`, all dated 2026-10-14:

1. `src/include/compat/wchar.h` — lets the system `<wchar.h>` be parsed with its
   own function names, so the wide-character classification prototypes do not
   collide with eSpeak's `ucd_*()` aliases under Emscripten's musl sysroot. No
   behaviour change.
2. `emscripten/Makefile` — accepts a static `libespeak-ng.a` from modern libtool,
   and drops three Emscripten settings that no longer exist
   (`-s RESERVED_FUNCTION_POINTERS`, `--memory-init-file`, `-s WASM=0`) in favour
   of WebAssembly, adding `-s EXPORTED_RUNTIME_METHODS`.
3. `emscripten/espeakng_glue.cpp` — sets the phoneme separator field to 0, which
   is what upstream's own code says it intends. Upstream leaves the "custom
   separator" bit clear but stores a space in the separator bits, which
   libespeak-ng then reads as an active separator between every phoneme. Without
   this patch the output is `h ə l ˈoʊ`; with it, `həlˈoʊ`, matching the
   behaviour this component replaced.

No eSpeak-NG translation, dictionary, phonetic data or synthesis source file is
altered by any of the three patches.

The modified work as a whole is licensed under the GNU GPL version 3 or later,
with no additional restrictions. The patches are licensed on the same terms.

## Rebuilding

```sh
bash build/build-espeak-ng-wasm.sh
```

The script downloads the pinned Emscripten release and checks its SHA-256,
clones eSpeak-NG at the pinned commit, applies the three patches, and runs
upstream's own documented emscripten build. It needs git, curl, tar, xz, gcc,
make, autoconf, automake, libtool, pkg-config, node and python3, and nothing
else.

## Licence texts and notices

- [`/voice/notices/README.md`](../notices/README.md) — every component we ship, with its licence and notice
- [`/voice/notices/LICENSE-GPL-3.0.txt`](../notices/LICENSE-GPL-3.0.txt) — GNU GPL version 3, the licence for this component
- [`/voice/notices/LICENSE-BSD-2-Clause.txt`](../notices/LICENSE-BSD-2-Clause.txt) — for the `getopt` compatibility code inside eSpeak-NG
- [`/voice/notices/LICENSE-UCD.txt`](../notices/LICENSE-UCD.txt) — for the Unicode data files inside eSpeak-NG
- [`/voice/notices/LICENSE-MIT-emscripten.txt`](../notices/LICENSE-MIT-emscripten.txt) — for the Emscripten runtime compiled into `espeakng.worker.js`

## Limits of this offer

This offer covers the eSpeak-NG component and its data. It does not cover
LatteReader Web's own application code, and it does not settle whether our
narrator worker bundle forms a single combined work with the eSpeak-NG
component under GPLv3 section 5(c). That question is open and is not resolved by
publishing these notices; see the "Open question" section of
[`/voice/notices/README.md`](../notices/README.md).
