"""Owned-fixture font diagnosis. No user PDF, no network.

Proves what the deliberately damaged fixture does and does not establish:
the ToUnicode entry is the only decoded-glyph claim, so a NUL cannot be
turned into f/ff/fi from font data alone. Run via `npm run test:extraction-quality`.
"""
import re
import struct
from pathlib import Path

root = Path(__file__).parent


def cmap_entries(raw: bytes) -> dict[int, str]:
    body = re.search(rb'beginbfchar(.*?)endbfchar', raw, re.S).group(1)
    pairs = re.findall(rb'<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>', body)
    return {int(code, 16): value.decode().upper() for code, value in pairs}


def true_type_tables(raw: bytes) -> tuple[bytes, dict[str, tuple[int, int]]]:
    number = int(re.search(rb'/FontFile2\s+(\d+) 0 R', raw).group(1))
    stream = re.search(rb'(?m)^%d 0 obj\s*<<(.*?)>>\s*stream\r?\n' % number, raw, re.S)
    length = int(re.search(rb'/Length\s+(\d+)', stream.group(1)).group(1))
    data = raw[stream.end():stream.end() + length]
    tables = {}
    for index in range(struct.unpack('>H', data[4:6])[0]):
        offset = 12 + 16 * index
        tag = data[offset:offset + 4].decode()
        start, size = struct.unpack('>II', data[offset + 8:offset + 16])
        tables[tag] = (start, size)
    return data, tables


healthy = (root / 'reading-quality.pdf').read_bytes()
broken = (root / 'reading-quality-unmapped.pdf').read_bytes()
plain = cmap_entries(healthy)
damaged = cmap_entries(broken)
changed = [code for code in plain if plain[code] != damaged.get(code)]
print({'changedToUnicodeCodes': changed,
      'healthyMapping': {hex(code): plain[code] for code in changed},
      'damagedMapping': {hex(code): damaged.get(code) for code in changed}})
assert changed == [0x01], 'the fixture must damage exactly the ff-ligature entry'
assert plain[0x01] == 'FB00' and damaged[0x01] == '0000'

# The embedded subset keeps the drawn glyph. Its own cmap maps character code to
# glyph index, not to Unicode, and post format 3 carries no glyph names, so the
# font file cannot by itself name the character that code 1 draws.
font, tables = true_type_tables(broken)
cmap = tables['cmap'][0]
subtable = cmap + struct.unpack('>I', font[cmap + 4 + 4:cmap + 4 + 8])[0]
fmt, _, _, first, count = struct.unpack('>HHHHH', font[subtable:subtable + 10])
glyphs = struct.unpack('>' + 'H' * count, font[subtable + 10:subtable + 10 + 2 * count])
font_names = tables['post'][0]
font_format = struct.unpack('>I', font[font_names:font_names + 4])[0]
print({'fontGlyphCode1': glyphs[1], 'cmapFormat': fmt,
      'postFormatHasGlyphNames': font_format == 0x20000,
      'numGlyphs': struct.unpack('>H', font[tables['maxp'][0] + 4:tables['maxp'][0] + 6])[0]})
assert glyphs[1] == 1 and font_format != 0x20000
print('Conclusion: only the ToUnicode CMap names the damaged character. '
      'The drawn glyph is intact but unnamed in the font file, so f/ff/fi is not provable.')
