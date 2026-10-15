import json, textwrap
from pathlib import Path
from reportlab.pdfgen import canvas
root = Path(__file__).parent
pages = json.loads((root/'misaki-owned.json').read_text())
c = canvas.Canvas(str(root/'misaki-owned.pdf'), pagesize=(612,792))
for text in pages:
    c.setFont('Helvetica',14)
    for i,line in enumerate(textwrap.wrap(text,65)):
        c.drawString(48,720-i*24,line)
    c.showPage()
c.save()
r = canvas.Canvas(str(root/'misaki-refusal.pdf'), pagesize=(612,792))
r.setFont('Helvetica',8)
r.drawString(30,720,'x'*70)
r.showPage()
r.save()
