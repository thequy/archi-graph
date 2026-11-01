#!/usr/bin/env python3
"""Generates deterministic .docx and .pdf fixtures for the ingest extract tests.

No third-party deps:
  - .docx is just an OOXML ZIP; we write the minimal parts mammoth needs
    ([Content_Types].xml, _rels/.rels, word/document.xml) with one paragraph.
  - .pdf is a minimal, well-formed PDF (one page, one text showing op) whose
    cross-reference offsets are computed from the actual byte layout so the
    (old) pdf.js bundled in pdf-parse accepts it.

Run:  python3 make-fixtures.py   (writes sample.docx / sample.pdf beside it)
"""
import os
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))

DOCX_TEXT = "Hello from a docx fixture."
PDF_TEXT = "Hello from a pdf fixture."

CONTENT_TYPES = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    '<Default Extension="xml" ContentType="application/xml"/>'
    '<Override PartName="/word/document.xml" '
    'ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
    '</Types>'
)

RELS = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    '<Relationship Id="rId1" '
    'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" '
    'Target="word/document.xml"/>'
    '</Relationships>'
)

DOCUMENT = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
    '<w:body><w:p><w:r><w:t>' + DOCX_TEXT + '</w:t></w:r></w:p></w:body>'
    '</w:document>'
)


def make_docx(path: str) -> None:
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", CONTENT_TYPES)
        z.writestr("_rels/.rels", RELS)
        z.writestr("word/document.xml", DOCUMENT)


def make_pdf(path: str) -> None:
    # Build the five objects, laying bytes out sequentially and recording the
    # exact byte offset of each "N 0 obj" token so the xref table is correct.
    header = b"%PDF-1.4\n"

    stream = b"BT /F1 24 Tf 72 700 Td (" + PDF_TEXT.encode("latin-1") + b") Tj ET\n"
    objs = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792]"
        b" /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
        b"<< /Length " + str(len(stream)).encode("ascii") + b" >>\nstream\n"
        + stream + b"endstream",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ]

    body = bytearray()
    offsets = []
    for i, o in enumerate(objs, start=1):
        offsets.append(len(header) + len(body))
        body += str(i).encode("ascii") + b" 0 obj\n" + o + b"\nendobj\n"

    xref_offset = len(header) + len(body)
    count = len(objs) + 1  # + free object 0

    xref = bytearray()
    xref += b"xref\n"
    xref += b"0 " + str(count).encode("ascii") + b"\n"
    xref += b"0000000000 65535 f \n"
    for off in offsets:
        xref += ("%010d 00000 n \n" % off).encode("ascii")

    trailer = (
        b"trailer\n<< /Size " + str(count).encode("ascii") + b" /Root 1 0 R >>\n"
        b"startxref\n" + str(xref_offset).encode("ascii") + b"\n%%EOF\n"
    )

    with open(path, "wb") as f:
        f.write(header + bytes(body) + bytes(xref) + trailer)


if __name__ == "__main__":
    make_docx(os.path.join(HERE, "sample.docx"))
    make_pdf(os.path.join(HERE, "sample.pdf"))
    print("wrote sample.docx + sample.pdf in", HERE)
