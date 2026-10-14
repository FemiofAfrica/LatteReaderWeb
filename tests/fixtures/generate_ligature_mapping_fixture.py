"""Owned fixture for the dropped-ligature failure mode. No private PDF.

Builds a small PDF whose body font reproduces the exact shape of the reported
failure: an embedded TrueType program whose own cmap names the ligatures
(U+FB00..U+FB04) while the document's ToUnicode CMap maps the ligature character
codes to U+0000. PDF.js therefore extracts a dropped character for every
ligature, and the only evidence left in the file is the font program itself.

Glyph plan (glyph id == character code, /CIDToGIDMap /Identity):

  17 'ff'    U+FB00    drawn, named by cmap        -> recovered from the cmap
  18 'fi'    U+FB01    drawn, named by cmap
  19 'fl'    U+FB02    drawn, named by cmap        -> tier 1: cmap names the glyph
  20 'ffi'   U+FB03    drawn, named by cmap
  21 'ffl'   U+FB04    EMPTY placeholder, named   -> tier 4: unnamed twin of an
  22 'fflD'  unnamed   drawn, same advance width     empty named placeholder
  23 'ffD'   unnamed   composite drawing 'ff'      -> tier 2: composite of a named glyph
  24 'fiD'   unnamed   composite drawing 'fi'
  25 'orphan' unnamed  drawn, unique advance, no named twin and no named
                       component: the font cannot name it, so it must stay
                       unmapped instead of gaining an invented letter

Requires fontTools. Run with the fixture virtualenv:
  /root/.hermes/cache/scratch/latte-fixture-venv/bin/python \
      tests/fixtures/generate_ligature_mapping_fixture.py
"""

import zlib
from pathlib import Path

from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.ttLib.tables._g_l_y_f import Glyph, GlyphComponent

ROOT = Path(__file__).parent
FONT_PATH = ROOT / "ligature-mapping.ttf"
PDF_PATH = ROOT / "ligature-mapping.pdf"

LETTERS = ["f", "i", "l", "o", "r", "s", "t", "c", "e", "d", "n", "a", "u", "y", "w"]
LETTER_GID = {name: 2 + index for index, name in enumerate(LETTERS)}
NAMED_LIGATURES = {"ff": (17, 0xFB00), "fi": (18, 0xFB01), "fl": (19, 0xFB02), "ffi": (20, 0xFB03)}
PLACEHOLDER_LIGATURE = ("ffl", 21, 0xFB04)
DRAWN_TWIN = ("fflD", 22)
COMPOSITES = {"ffD": (23, "ff"), "fiD": (24, "fi")}
ORPHAN = ("orphan", 25)


def glyph_order() -> list[str]:
    order = [".notdef", "space"]
    order += [f"g{name}" for name in LETTERS]
    order += ["g" + name for name in NAMED_LIGATURES]
    order += ["g" + PLACEHOLDER_LIGATURE[0], "g" + DRAWN_TWIN[0]]
    order += ["g" + name for name in COMPOSITES]
    order += ["g" + ORPHAN[0]]
    return order


def rectangle(pen: TTGlyphPen, offset: int, height: int = 600) -> None:
    pen.moveTo((offset, 0))
    pen.lineTo((offset, height))
    pen.lineTo((offset + 120, height))
    pen.lineTo((offset + 120, 0))
    pen.closePath()


def build_font(path: Path) -> None:
    order = glyph_order()
    glyphs = {}
    metrics = {}

    empty = TTGlyphPen(None)
    glyphs[".notdef"] = empty.glyph()
    metrics[".notdef"] = (500, 0)
    glyphs["space"] = TTGlyphPen(None).glyph()
    metrics["space"] = (500, 0)

    for name in LETTERS:
        pen = TTGlyphPen(None)
        rectangle(pen, 0)
        glyphs[f"g{name}"] = pen.glyph()
        metrics[f"g{name}"] = (400 + LETTER_GID[name], 0)

    for name, (gid, _codepoint) in NAMED_LIGATURES.items():
        pen = TTGlyphPen(None)
        rectangle(pen, 0)
        rectangle(pen, 160)
        glyphs[f"g{name}"] = pen.glyph()
        metrics[f"g{name}"] = ({17: 900, 18: 850, 19: 800, 20: 1000}[gid], 0)

    # A named glyph with no outline at all: the placeholder a producer leaves
    # behind when it copies a shape into a second glyph.
    glyphs[f"g{PLACEHOLDER_LIGATURE[0]}"] = TTGlyphPen(None).glyph()
    metrics[f"g{PLACEHOLDER_LIGATURE[0]}"] = (700, 0)

    pen = TTGlyphPen(None)
    rectangle(pen, 0)
    rectangle(pen, 160)
    rectangle(pen, 320)
    glyphs[f"g{DRAWN_TWIN[0]}"] = pen.glyph()
    metrics[f"g{DRAWN_TWIN[0]}"] = (700, 0)

    for name, (gid, component) in COMPOSITES.items():
        glyph = Glyph()
        glyph.numberOfContours = -1
        part = GlyphComponent()
        part.glyphName = f"g{component}"
        part.flags = 0
        part.x = 0
        part.y = 0
        glyph.components = [part]
        glyphs[f"g{name}"] = glyph
        metrics[f"g{name}"] = ({23: 900, 24: 850}[gid], 0)

    pen = TTGlyphPen(None)
    rectangle(pen, 0, height=400)
    glyphs[f"g{ORPHAN[0]}"] = pen.glyph()
    metrics[f"g{ORPHAN[0]}"] = (421, 0)

    cmap = {ord(name): f"g{name}" for name in LETTERS}
    for name, (_gid, codepoint) in NAMED_LIGATURES.items():
        cmap[codepoint] = f"g{name}"
    cmap[PLACEHOLDER_LIGATURE[2]] = f"g{PLACEHOLDER_LIGATURE[0]}"

    builder = FontBuilder(1000, isTTF=True)
    builder.setupGlyphOrder(order)
    builder.setupCharacterMap(cmap)
    builder.setupGlyf(glyphs)
    builder.setupHorizontalMetrics(metrics)
    builder.setupHorizontalHeader(ascent=800, descent=-200)
    builder.setupNameTable({"familyName": "FixtureGaramond", "styleName": "Regular",
                            "fullName": "FixtureGaramond Regular",
                            "psName": "FixtureGaramond-Regular",
                            "version": "Version 1.000"})
    builder.setupOS2(sTypoAscender=800, sTypoDescender=-200, usWinAscent=800, usWinDescent=200)
    builder.setupPost()
    builder.save(path)


def word(codes: list[int]) -> bytes:
    return "".join(f"{code:04X}" for code in codes).encode()


def build_pdf(path: Path, font_bytes: bytes) -> None:
    def letter(name: str) -> int:
        return LETTER_GID[name]

    words = {
        "different": [letter("d"), letter("i"), 23, letter("e"), letter("r"), letter("e"), letter("n"), letter("t")],
        "coffee": [letter("c"), letter("o"), 23, letter("e"), letter("e")],
        "first": [24, letter("r"), letter("s"), letter("t")],
        "officer": [letter("o"), 23, letter("i"), letter("c"), letter("e"), letter("r")],
        "floor": [19, letter("o"), letter("o"), letter("r")],
        "definitely": [letter("d"), letter("e"), 24, letter("n"), letter("i"), letter("t"), letter("e"), letter("l"), letter("y")],
        "financial": [24, letter("n"), letter("a"), letter("n"), letter("c"), letter("i"), letter("a"), letter("l")],
        "difficult": [letter("d"), letter("i"), 20, letter("c"), letter("u"), letter("l"), letter("t")],
        "waffle": [letter("w"), letter("a"), 22, letter("e")],
        "no?e": [letter("n"), letter("o"), 25, letter("e")],
    }

    lines = ["BT", "/F1 20 Tf", "1 0 0 1 60 760 Tm"]
    for index, codes in enumerate(words.values()):
        if index:
            lines.append("0 -24 Td")
        lines.append(f"<{word(codes).decode()}> Tj")
    lines.append("ET")
    content = ("\n".join(lines) + "\n").encode()

    to_unicode = ["/CIDInit /ProcSet findresource begin", "12 dict begin", "begincmap",
                  "/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def",
                  "/CMapName /Adobe-Identity-UCS def", "/CMapType 2 def",
                  "1 begincodespacerange", "<0000> <FFFF>", "endcodespacerange"]
    entries = []
    for name in LETTERS:
        entries.append(f"<{LETTER_GID[name]:04X}> <{ord(name):04X}>")
    # The failure: every ligature character code is stated as U+0000 (or left out).
    for broken in (17, 18, 20, 21, 22, 23, 24, 19, 25):
        entries.append(f"<{broken:04X}> <0000>")
    to_unicode.append(f"{len(entries)} beginbfchar")
    to_unicode += entries
    to_unicode += ["endbfchar", "endcmap",
                   "CMapName currentdict /CMap defineresource pop", "end", "end"]
    cmap_stream = ("\n".join(to_unicode) + "\n").encode()

    objects: list[bytes] = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
        b"/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
        f"<< /Length {len(content)} >>\nstream\n".encode() + content + b"endstream",
        b"<< /Type /Font /Subtype /Type0 /BaseFont /FixtureGaramond-Regular "
        b"/Encoding /Identity-H /DescendantFonts [6 0 R] /ToUnicode 9 0 R >>",
        b"<< /Type /Font /Subtype /CIDFontType2 /BaseFont /FixtureGaramond-Regular "
        b"/CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> "
        b"/FontDescriptor 7 0 R /CIDToGIDMap /Identity "
        b"/DW 500 /W [1 [500] 2 [402 403 404 405 406 407 408 409 410 411 412 413 414 415 416] "
        b"17 [900] 18 [850] 19 [800] 20 [1000] 21 [700] 22 [700] 23 [900] 24 [850] 25 [421]] >>",
        b"<< /Type /FontDescriptor /FontName /FixtureGaramond-Regular /Flags 32 "
        b"/FontBBox [0 -200 1000 800] /ItalicAngle 0 /Ascent 800 /Descent -200 "
        b"/CapHeight 700 /StemV 80 /FontFile2 8 0 R >>",
    ]

    def stream_object(payload: bytes) -> bytes:
        compressed = zlib.compress(payload)
        return (f"<< /Length {len(compressed)} /Filter /FlateDecode >>\nstream\n".encode()
                + compressed + b"\nendstream")

    objects.append(stream_object(font_bytes))
    objects.append(stream_object(cmap_stream))

    out = bytearray(b"%PDF-1.7\n%\xe2\xe3\xcf\xd3\n")
    offsets = [0]
    for number, body in enumerate(objects, start=1):
        offsets.append(len(out))
        out += f"{number} 0 obj\n".encode() + body + b"\nendobj\n"
    xref = len(out)
    out += f"xref\n0 {len(objects) + 1}\n".encode()
    out += b"0000000000 65535 f \n"
    for offset in offsets[1:]:
        out += f"{offset:010d} 00000 n \n".encode()
    out += (f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n").encode()
    path.write_bytes(bytes(out))


if __name__ == "__main__":
    build_font(FONT_PATH)
    build_pdf(PDF_PATH, FONT_PATH.read_bytes())
    print(f"wrote {FONT_PATH.name} ({FONT_PATH.stat().st_size} bytes) and "
          f"{PDF_PATH.name} ({PDF_PATH.stat().st_size} bytes)")
