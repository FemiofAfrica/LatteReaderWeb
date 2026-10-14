"""Owned selection fixture with repeated text, ligatures and conservative repair cases."""
from pathlib import Path
from reportlab.pdfgen.canvas import Canvas
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
pdfmetrics.registerFont(TTFont('SelectionSans', '/usr/share/fonts/truetype/freefont/FreeSans.ttf'))
c = Canvas(str(Path(__file__).parent / 'selection-quality.pdf'), pageCompression=0)
for lines in [
    ['Earlier page. Do not read this when starting on page two.'],
    ['Same ﬁne sentence.', 'Same ﬁne sentence.', "don’ t I' m we' re. John' s l’ amour don ' t."] + [f'Line {i}: fine fresh coffee continues.' for i in range(80)],
    ['Final page. End of document.'],
]:
    c.setFont('SelectionSans', 10)
    for i, line in enumerate(lines): c.drawString(35, 810 - i * 9, line)
    c.showPage()
c.save()
