import html
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

sys.path.insert(
    0, "/Users/riabuz/.codex/worktrees/color-suite-progress/_Maple/src/scripts"
)
import auto_profile_quality as quality

root = Path(__file__).resolve().parent
summary = json.loads((root / "full-suite/summary.json").read_text())
assert summary["complete"] and len(summary["cases"]) == 20
identity = json.loads((root / "identity.json").read_text())
gallery = root / "gallery"
gallery.mkdir(exist_ok=True)
sections = []
cases = sorted(
    [r for r in summary["cases"] if "quality" in r], key=lambda r: r["fixture"]
)
sheets = []
for index, row in enumerate(cases):
    name = row["fixture"]
    reference = root / "full-suite" / name / "embedded.png"
    before = root.parent / "auto-jpeg-matched-selection/full-suite" / name / "auto.png"
    after = root / "full-suite" / name / "auto.png"
    old, target = quality.load_display_pair(before, reference)
    new, _ = quality.load_display_pair(after, reference)
    images = []
    figures = []
    for label, key, arr, path in [
        ("Previous checkpoint (91fa)", "before", old, before),
        ("Neutral-protected fine fit (9eb)", "after", new, after),
        ("Embedded JPEG", "reference", target, reference),
    ]:
        image = Image.fromarray(np.rint(np.clip(arr, 0, 1) * 255).astype(np.uint8))
        image.save(gallery / f"{name}-{key}.png")
        images.append(image)
        figures.append(
            f'<figure><figcaption>{label}</figcaption><a href="{html.escape(path.as_uri())}"><img src="{name}-{key}.png"></a></figure>'
        )
    sections.append(
        f'<section id="{name}"><h2>{name}: {row["status"].upper()}</h2><p>{len(row["quality"]["breaches"])} strong quality breaches. Click images for original full resolution files.</p><div class="row">'
        + "".join(figures)
        + "</div></section>"
    )
    if index % 4 == 0:
        sheet = Image.new("RGB", (1350, 1450), "#202124")
        draw = ImageDraw.Draw(sheet)
        for column, label in enumerate(
            [
                "Previous checkpoint (91fa)",
                "Neutral-protected fine fit (9eb)",
                "Embedded JPEG",
            ]
        ):
            draw.text((column * 450 + 10, 10), label, fill="white")
        sheets.append(sheet)
    top = 45 + (index % 4) * 350
    draw.text((10, top), f"{name}: {row['status']}", fill="white")
    for col, image in enumerate(images):
        thumb = image.copy()
        thumb.thumbnail((420, 300))
        sheet.paste(
            thumb,
            (
                col * 450 + (450 - thumb.width) // 2,
                top + 25 + (300 - thumb.height) // 2,
            ),
        )
for index, sheet in enumerate(sheets):
    sheet.save(gallery / f"contact-{index + 1}.jpg", quality=93)
notice = f"Source {identity['source_commit'][:10]}. Full run: {summary['counts']}. Incomplete: failures remain; no merge or version bump."
page = (
    '<!doctype html><meta charset="utf-8"><title>Auto full corpus — current checkpoint</title><style>body{font:16px system-ui;background:#202124;color:white;margin:24px}.row{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}figure{margin:0}img{width:100%;max-height:450px;object-fit:contain}section{margin:36px 0}a{color:#aaf}.notice{padding:20px;background:#663322}</style><h1>All 16 embedded-JPEG comparisons</h1><p class="notice">'
    + html.escape(notice)
    + "</p>"
    + "".join(sections)
)
(gallery / "index.html").write_text(page)
print(gallery / "index.html")
