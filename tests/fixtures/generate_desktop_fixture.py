"""A 300-page owned PDF with readable pages and many character labels. No PDF dependencies."""
from pathlib import Path

objects = [b'<< /Type /Catalog /Pages 2 0 R >>', b'', b'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>']
kids = []
for page in range(1, 301):
    page_id = len(objects) + 1
    stream_id = page_id + 1
    kids.append(f'{page_id} 0 R')
    objects.append(f'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 1000] /Resources << /Font << /F1 3 0 R >> >> /Contents {stream_id} 0 R >>'.encode())
    lines = [f'LATTEREADER | DESKTOP READING FIXTURE | PAGE {page}', 'A local reading console, built for a quiet afternoon.', '']
    for line in range(32):
        name = ['ALICE', 'BENJAMIN', 'CHARLOTTE', 'DANIEL', 'ELIZABETH'][line % 5]
        lines.append(f'{name}: Chapter {page}, line {line + 1}. Five friends find fresh coffee.')
    commands = ['BT', '/F1 12 Tf', '48 952 Td']
    for i, text in enumerate(lines):
        if i: commands.append('0 -25 Td')
        commands.append(f'({text}) Tj')
    commands.append('ET')
    stream = '\n'.join(commands).encode()
    objects.append(b'<< /Length %d >>\nstream\n' % len(stream) + stream + b'\nendstream')
objects[1] = f'<< /Type /Pages /Kids [{" ".join(kids)}] /Count 300 >>'.encode()
pdf = bytearray(b'%PDF-1.4\n')
offsets = [0]
for i, obj in enumerate(objects, 1):
    offsets.append(len(pdf))
    pdf.extend(f'{i} 0 obj\n'.encode() + obj + b'\nendobj\n')
xref = len(pdf)
pdf.extend(f'xref\n0 {len(objects) + 1}\n0000000000 65535 f \n'.encode())
for offset in offsets[1:]: pdf.extend(f'{offset:010d} 00000 n \n'.encode())
pdf.extend(f'trailer\n<< /Size {len(objects)+1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n'.encode())
output = Path(__file__).parent / 'desktop-300.pdf'
output.write_bytes(pdf)
print(f'{output}: {len(pdf)} bytes, 300 pages')
