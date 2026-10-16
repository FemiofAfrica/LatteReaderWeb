"""Owned page-follow fixtures: three pages of plain prose, each paragraph tagged with its page.

page-follow.pdf has long pages (about 2,600 characters each), so a 1,200-character speech
chunk always runs across a page break. page-follow-short.pdf has three short sentences per
page for the slower on-device voice.
"""
from pathlib import Path

BASE = ('The morning light came slowly over the hills, and the village woke one window at a time. '
        'Bakers lit their ovens, children argued about shoes, and the river kept its own patient count.')

def build(name, paragraphs, text):
    objects = [b'<< /Type /Catalog /Pages 2 0 R >>', b'', b'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>']
    kids = []
    for page in range(1, 4):
        page_id = len(objects) + 1
        kids.append(f'{page_id} 0 R')
        objects.append(f'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 1000] /Resources << /Font << /F1 3 0 R >> >> /Contents {page_id + 1} 0 R >>'.encode())
        lines = []
        for k in range(paragraphs):
            words, line = text(page, k).split(), ''
            for word in words:
                if len(line) + len(word) > 90: lines.append(line); line = ''
                line = f'{line} {word}'.strip()
            lines.append(line)
        commands = ['BT', '/F1 10 Tf', '48 960 Td']
        for i, line in enumerate(lines):
            if i: commands.append('0 -14 Td')
            commands.append(f'({line}) Tj')
        commands.append('ET')
        stream = '\n'.join(commands).encode()
        objects.append(b'<< /Length %d >>\nstream\n' % len(stream) + stream + b'\nendstream')
    objects[1] = f'<< /Type /Pages /Kids [{" ".join(kids)}] /Count 3 >>'.encode()
    pdf = bytearray(b'%PDF-1.4\n'); offsets = [0]
    for i, obj in enumerate(objects, 1):
        offsets.append(len(pdf)); pdf.extend(f'{i} 0 obj\n'.encode() + obj + b'\nendobj\n')
    xref = len(pdf)
    pdf.extend(f'xref\n0 {len(objects) + 1}\n0000000000 65535 f \n'.encode())
    for offset in offsets[1:]: pdf.extend(f'{offset:010d} 00000 n \n'.encode())
    pdf.extend(f'trailer\n<< /Size {len(objects)+1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n'.encode())
    output = Path(__file__).parent / name
    output.write_bytes(pdf)
    print(f'{output}: {len(pdf)} bytes')

build('page-follow.pdf', 12, lambda page, k: f'Page {page} paragraph {k + 1}. {BASE}')
build('page-follow-short.pdf', 3, lambda page, k: f'Page {page} sentence {k + 1}. The cat sat on the warm mat.')
