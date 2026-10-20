"""Rasterize generated labels at the Zebra ZD220D's 203 dpi and decode every QR.
Run after LABEL_TEST_OUTPUT=/tmp/mawaid-labels npm test:
  python scripts/verify_labels.py /tmp/mawaid-labels
Dependencies: python -m pip install pymupdf Pillow zxing-cpp
"""
import json
import sys
from pathlib import Path
import fitz
from PIL import Image
import zxingcpp

folder = Path(sys.argv[1])
expected = json.loads((folder / 'expected.json').read_text())
with fitz.open(folder / '50-labels.pdf') as doc:
    assert len(doc) == len(expected) == 50, 'Expected one label page per person'
    decoded = []
    for number, page in enumerate(doc):
        pix = page.get_pixmap(dpi=203)
        image = Image.frombytes('RGB', (pix.width, pix.height), pix.samples)
        found = zxingcpp.read_barcodes(image)
        assert len(found) == 1, f'Page {number + 1}: expected one decodable QR'
        decoded.append(found[0].text)
        if number == 0:
            image.save(folder / 'label-preview.png')
    assert decoded == expected, 'PDF contains unexpected QR values'
    assert len(set(decoded)) == 50, 'QR values must be unique'
    assert 'Departure: 2026-10-23' in doc[0].get_text(), 'Departure date missing from the compact label'
    assert 'Person: 1' in doc[0].get_text(), 'Person number missing from the compact label'
    assert abs(doc[0].rect.width * 25.4 / 72 - 76.2) < .1
    assert abs(doc[0].rect.height * 25.4 / 72 - 50.8) < .1
print('50 / 50 labels: unique expected QR values decoded at 203 dpi; 3 × 2 inch (76.2 × 50.8 mm) pages verified.')
for name, width_mm, height_mm in [('min', 40, 80), ('compact-min', 70, 50.8), ('actual', 76.2, 50.8), ('max', 104, 200)]:
    with fitz.open(folder / f'boundary-{name}.pdf') as doc:
        assert len(doc) == 1, f'{name} layout overflowed onto another page'
        page = doc[0]
        assert abs(page.rect.width * 25.4 / 72 - width_mm) < .1
        assert abs(page.rect.height * 25.4 / 72 - height_mm) < .1
        pix = page.get_pixmap(dpi=203)
        image = Image.frombytes('RGB', (pix.width, pix.height), pix.samples)
        decoded = zxingcpp.read_barcodes(image)
        assert len(decoded) == 1 and decoded[0].text == 'MW1:' + 'A' * 43, f'{name} QR did not decode'
print('Actual 3 × 2 inch and supported boundary layouts: one page each; QR decodes at 203 dpi.')
with fitz.open(folder / 'browser-label.pdf') as doc:
    assert len(doc) == 1
    page = doc[0]
    assert abs(page.rect.width * 25.4 / 72 - 76.2) < .1
    assert abs(page.rect.height * 25.4 / 72 - 50.8) < .1
    pix = page.get_pixmap(dpi=203)
    decoded = zxingcpp.read_barcodes(Image.frombytes('RGB', (pix.width, pix.height), pix.samples))
    assert len(decoded) == 1 and decoded[0].text == 'MW1:' + 'A' * 43
    assert 'Departure: 2026-10-24' in page.get_text()
print('Browser-generated 3 × 2 inch label: expected QR decodes at 203 dpi and departure text verified.')
