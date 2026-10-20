import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

root = Path(__file__).resolve().parent
sys.path.insert(0, str(root / "source"))
import auto_profile_alignment as alignment
import auto_profile_quality as quality

source = root.parent / "auto-jpeg-quality-budget/full-suite"
rows = json.loads((root / "exploratory-regrade.json").read_text())["cases"]
rows = sorted(
    [r for r in rows if r["status"] != "no-preview"], key=lambda r: r["fixture"]
)
gallery = root / "gallery"
gallery.mkdir(exist_ok=True)
sections = []
sheets = []
for index, row in enumerate(rows):
    name = row["fixture"]
    cand, ref = quality.load_display_pair(
        source / name / "auto.png", source / name / "embedded.png"
    )
    aligned, valid = alignment.resample_reference(
        ref, np.array(row["quality"]["alignment"]["candidate_to_reference_normalized"])
    )
    figures = []
    images = []
    for key, label, arr in [
        ("reference", "Embedded JPEG", ref),
        ("aligned", "JPEG at candidate coordinates", aligned),
        ("candidate", "Auto: unchanged rendered pixels", cand),
    ]:
        image = Image.fromarray(np.rint(arr * 255).astype(np.uint8))
        image.save(gallery / f"{name}-{key}.png")
        images.append(image)
        figures.append(
            f'<figure><figcaption>{label}</figcaption><img src="{name}-{key}.png"></figure>'
        )
    if index % 4 == 0:
        sheet = Image.new("RGB", (1350, 1450), "#202124")
        draw = ImageDraw.Draw(sheet)
        for col, label in enumerate(
            ["Embedded JPEG", "Aligned JPEG", "Unchanged Auto"]
        ):
            draw.text((col * 450 + 10, 10), label, fill="white")
        sheets.append(sheet)
    top = 45 + (index % 4) * 350
    draw.text((10, top), f"{name}: {row['status']}", fill="white")
    for col, img in enumerate(images):
        thumb = img.copy()
        thumb.thumbnail((420, 300))
        sheet.paste(
            thumb,
            (
                col * 450 + (450 - thumb.width) // 2,
                top + 25 + (300 - thumb.height) // 2,
            ),
        )
    sections.append(
        f"<section><h2>{name}: {row['status']}</h2><div>"
        + "".join(figures)
        + "</div></section>"
    )
for i, sheet in enumerate(sheets):
    sheet.save(gallery / f"contact-{i + 1}.jpg", quality=93)
(gallery / "index.html").write_text(
    '<!doctype html><meta charset="utf-8"><title>Coordinate alignment qualification</title><style>body{background:#202124;color:white;font:16px system-ui;margin:24px}section div{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}figure{margin:0}img{width:100%;max-height:450px;object-fit:contain}</style><h1>Geometry-only comparison change: all 16 JPEG images</h1><p>Renderer unchanged. Reference alignment only; no color/exposure compensation. Native gate still fails 9 images. Non-overlap is measured separately, never treated as a match.</p>'
    + "".join(sections)
)
