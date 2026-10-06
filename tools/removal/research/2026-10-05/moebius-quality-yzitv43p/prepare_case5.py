import json
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter
from scipy.ndimage import distance_transform_edt

r = Path(__file__).parent
old = r.parent / "desktop-quality-9ikrgf16"
p = r / "case-5"
p.mkdir(exist_ok=True)
source = Image.open(old / "case-5/source.png").resize(
    (512, 512), Image.Resampling.LANCZOS
)
source.save(p / "source.png")
old_annotations = json.loads((old / "mask-annotations.json").read_text())
polygon = old_annotations["polygons"]["5"]
intent = Image.new("L", (512, 512))
ImageDraw.Draw(intent).polygon([tuple(x) for x in polygon], fill=255)
# Refined ribbon perimeter follows the visible upper edge, not a broad triangle through the pedestrian's leg.
ribbon = [
    (165, 493),
    (221, 414),
    (320, 335),
    (360, 288),
    (337, 341),
    (313, 375),
    (240, 442),
]
gown = old_annotations["protection"]["5"][0]
protection = Image.new("L", (512, 512))
draw = ImageDraw.Draw(protection)
for poly in [ribbon, gown]:
    draw.polygon([tuple(x) for x in poly], fill=255)
keep = np.array(protection) > 0
a = np.array(intent)
a[keep] = 0
intent = a > 0
hole = np.array(Image.fromarray(a).filter(ImageFilter.MaxFilter(9))) > 0
hole[keep] = 0
coverage = np.maximum(0, 1 - distance_transform_edt(~intent) / 2).astype("float32")
coverage[~hole | keep] = 0
Image.fromarray((hole * 255).astype("uint8")).save(p / "hole.png")
coverage.tofile(p / "coverage.f32")
protection.save(p / "protected.png")
overlay = np.array(source)
overlay[intent] = (overlay[intent] * 0.5 + np.array([255, 30, 30]) * 0.5).astype(
    "uint8"
)
overlay[keep] = (overlay[keep] * 0.7 + np.array([30, 220, 60]) * 0.3).astype("uint8")
Image.fromarray(overlay).save(p / "mask.png")
(p / "mask-revision.json").write_text(
    json.dumps(
        {
            "reviewer": "assistant; human review pending",
            "ribbon": ribbon,
            "gown": gown,
            "intentPolygon": polygon,
            "holeDilationAt512": 4,
            "reason": "Previous broad ribbon protection included unwanted pedestrian leg; narrowed to visible ribbon boundary.",
        },
        indent=2,
    )
)
