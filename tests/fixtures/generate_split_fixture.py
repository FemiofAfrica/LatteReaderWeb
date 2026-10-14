"""Owned deterministic split-font-run PDF; no user's document content."""
from pathlib import Path
from reportlab.pdfgen import canvas
from reportlab.pdfbase.pdfmetrics import stringWidth
path = Path(__file__).with_name('split-text-items.pdf')
c = canvas.Canvas(str(path), pagesize=(612, 792), invariant=1)
c.setTitle('Owned split text item spacing fixture')
def runs(y, parts):
    x = 72
    for text, font, gap in parts:
        x += gap
        c.setFont(font, 14)
        c.drawString(x, y, text)
        x += stringWidth(text, font, 14)
runs(720, [('R', 'Helvetica', 0), ('o', 'Helvetica-Bold', 0), (' finds fine coffee.', 'Helvetica', 0)])
runs(690, [('R', 'Helvetica', 0), ('o', 'Helvetica-Bold', 5), (' are separate letters.', 'Helvetica', 0)])
runs(660, [('A.', 'Helvetica', 0), ('B.', 'Helvetica-Bold', 5), (' are initials.', 'Helvetica', 0)])
runs(630, [('Two', 'Helvetica', 0), ('words.', 'Helvetica-Bold', 5)])
runs(600, [('can', 'Helvetica', 0), ("'t", 'Helvetica-Bold', 0), (' stop.', 'Helvetica', 0)])
runs(570, [('ALICE: One.', 'Helvetica', 0)])
runs(540, [('ALICE: Two.', 'Helvetica', 0)])
c.save()
print(path)
