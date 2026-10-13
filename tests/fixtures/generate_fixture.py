from pathlib import Path

pages = [
    [
        "LATTEREADER TEST STORY",
        "ALICE: We should begin with the first page.",
        "ALICE: The local reader keeps this document private.",
        "BOB: I can hear the browser voice clearly.",
        "BOB: Let us continue to page two.",
    ],
    [
        "SECOND PAGE",
        "ALICE: Page navigation is working.",
        "ALICE: Character analysis can find my label.",
        "BOB: Zoom and speech controls are ready.",
        "BOB: This is the end of the fixture.",
    ],
]

objects = []
objects.append(b"<< /Type /Catalog /Pages 2 0 R >>")
objects.append(b"<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>")
objects.append(b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 7 0 R >> >> /Contents 4 0 R >>")

for page_index, lines in enumerate(pages):
    commands = ["BT", "/F1 16 Tf", "72 720 Td"]
    for line_index, line in enumerate(lines):
        if line_index:
            commands.append("0 -32 Td")
        escaped = line.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")
        commands.append(f"({escaped}) Tj")
    commands.append("ET")
    stream = "\n".join(commands).encode("ascii")
    stream_object = b"<< /Length %d >>\nstream\n" % len(stream) + stream + b"\nendstream"
    if page_index == 0:
        objects.append(stream_object)
        objects.append(b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 7 0 R >> >> /Contents 6 0 R >>")
    else:
        objects.append(stream_object)
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

output = Path(__file__).parent / "latte-reader-text-fixture.pdf"
output.write_bytes(pdf)
print(f"wrote {output} ({len(pdf)} bytes)")
