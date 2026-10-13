"""Generate the upload failure fixtures used by the upload diagnosis tests.

These fixtures exercise every upload failure branch the reader can report:

  latte-reader-text-fixture.pdf        a valid PDF (written by generate_fixture.py)
  latte-reader-valid-marker.pdf        a valid PDF whose header sits after 512 leading bytes
  latte-reader-not-a-pdf.txt           no PDF header anywhere in the first 1024 bytes
  latte-reader-empty.pdf               zero bytes
  latte-reader-truncated.pdf           a real header, then the file stops mid document
  latte-reader-password.pdf            a genuine password protected PDF

The password fixture is written by pypdf, which is a fixture-generation tool only and
never a runtime or application dependency. Install it with `pip install pypdf` before
regenerating that one file, or delete and keep the committed copy.

The valid-marker fixture guards the tolerant header check: a real PDF is allowed to carry
leading bytes before its `%PDF-` marker anywhere inside the first 1024 bytes, so a naive
first-four-bytes test would wrongly reject it.
"""

from pathlib import Path

FIXTURES = Path(__file__).parent
VALID = FIXTURES / "latte-reader-text-fixture.pdf"
HEADER = b"%PDF-"
HEADER_WINDOW = 1024


def read_valid() -> bytes:
    if not VALID.exists():
        raise SystemExit(f"missing {VALID}; run generate_fixture.py first")
    return VALID.read_bytes()


def trim_to_header(pdf: bytes) -> bytes:
    """A real PDF may carry leading bytes before its header; keep only up to the marker."""
    index = pdf.find(HEADER, 0, HEADER_WINDOW)
    if index < 0:
        raise SystemExit(f"{VALID} has no header inside the first {HEADER_WINDOW} bytes")
    return pdf[index:]


def write(name: str, data: bytes) -> None:
    output = FIXTURES / name
    output.write_bytes(data)
    print(f"wrote {output} ({len(data)} bytes)")


def write_not_a_pdf() -> None:
    write("latte-reader-not-a-pdf.txt", b"This is a plain text file, not a PDF at all.\n" * 4)


def write_empty() -> None:
    write("latte-reader-empty.pdf", b"")


def write_truncated() -> None:
    pdf = trim_to_header(read_valid())
    # Keep the header and the start of the body, then stop mid structure so the document
    # cannot be parsed: no cross reference table and no trailer.
    write("latte-reader-truncated.pdf", pdf[: len(pdf) // 2])


def write_valid_with_leading_bytes() -> None:
    pdf = trim_to_header(read_valid())
    # A conforming reader searches for the header inside the first 1024 bytes, so leading
    # bytes before the marker must not cause a rejection.
    write("latte-reader-valid-marker.pdf", b"LATTEREADER MARKER PADDING\n" * 16 + pdf)


def write_password_protected() -> None:
    try:
        from pypdf import PdfReader, PdfWriter
    except ImportError:  # pragma: no cover - fixture tooling only
        print("skipped latte-reader-password.pdf: pip install pypdf to regenerate it")
        return
    reader = PdfReader(str(VALID))
    writer = PdfWriter()
    for page in reader.pages:
        writer.add_page(page)
    writer.encrypt(user_password="latte-reader", owner_password="latte-reader-owner", algorithm="RC4-128")
    output = FIXTURES / "latte-reader-password.pdf"
    with output.open("wb") as handle:
        writer.write(handle)
    print(f"wrote {output} ({output.stat().st_size} bytes)")


if __name__ == "__main__":
    write_not_a_pdf()
    write_empty()
    write_truncated()
    write_valid_with_leading_bytes()
    write_password_protected()
