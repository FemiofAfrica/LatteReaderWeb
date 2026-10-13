"""Owned fixture, no private PDF. Requires reportlab; uses an installed FreeSans font.
Second PDF deliberately corrupts one ToUnicode entry while preserving the drawn glyph.
This reproduces why a rendered letter/ligature can coexist with a NUL extraction.
"""
from pathlib import Path
from reportlab.pdfgen.canvas import Canvas
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont

root = Path(__file__).parent
pdfmetrics.registerFont(TTFont('FixtureSans', '/usr/share/fonts/truetype/freefont/FreeSans.ttf'))
pdf = root / 'reading-quality.pdf'
c = Canvas(str(pdf), pageCompression=0)
c.setFont('FixtureSans', 16)
c.drawString(40, 760, 'f ff fi fl ffi ffl ﬀ ﬁ ﬂ ﬃ ﬄ “fine”')
c.drawString(40, 720, 'Five fine friends')
c.showPage()
c.setFont('FixtureSans', 16)
c.drawString(40, 760, 'find fresh coffee. A well-known difference.')
c.save()
# ReportLab emits a readable ToUnicode CMap. Damage ONLY the ff ligature mapping;
# replacement has equal byte length, so xref offsets remain correct.
raw = pdf.read_bytes()
assert b'<FB00>' in raw
broken = raw.replace(b'<FB00>', b'<0000>')
(root / 'reading-quality-unmapped.pdf').write_bytes(broken)
print('Generated two owned PDFs; second has one deliberately unmapped ligature.')
