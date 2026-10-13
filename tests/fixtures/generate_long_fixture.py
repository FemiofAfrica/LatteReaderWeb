"""Generate a one-page fixture whose extracted text is long enough to be a multi-screen wall.

Used by the mobile/preview smokes to prove the selectable text panel cannot dominate the
viewport when expanded. Written by hand so it needs no PDF library.
"""
from pathlib import Path

LINES = ["LATTEREADER LONG TEXT STORY"]
for index in range(1, 161):
    LINES.append(f"ALICE: This is transcript line {index} with enough words to wrap in the reader panel.")

objects = []
objects.append(b"<< /Type /Catalog /Pages 2 0 R >>")
objects.append(b"<< /Type /Pages /Kids [4 0 R] /Count 1 >>")

commands = ["BT", "/F1 14 Tf", "72 720 Td"]
for line_index, line in enumerate(LINES):
    if line_index:
        commands.append("0 -18 Td")
    escaped = line.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")
    commands.append(f"({escaped}) Tj")
commands.append("ET")
stream = "\n".join(commands).encode("ascii")
objects.append(b"<< /Length %d >>\nstream\n" % len(stream) + stream + b"\nendstream")
objects.append(b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 3 0 R >>")
objects.append(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")

pdf = bytearray(b"%PDF-1.4\n")
offsets = [0]
for index, obj in enumerate(objects, 1):
    offsets.append(len(pdf))
    pdf.extend(f"{index} 0 obj\n".encode("ascii"))
    pdf.extend(obj)
    pdf.extend(b"\nendobj\n")

xref = len(pdf)
pdf.extend(f"xref\n0 {len(objects) + 1}\n".encode("ascii"))
pdf.extend(b"0000000000 65535 f \n")
for offset in offsets[1:]:
    pdf.extend(f"{offset:010d} 00000 n \n".encode("ascii"))
pdf.extend(f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode("ascii"))

output = Path(__file__).parent / "latte-reader-long-text-fixture.pdf"
output.write_bytes(pdf)
print(f"wrote {output} ({len(pdf)} bytes)")
