import json
import shutil
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter
from scipy.ndimage import distance_transform_edt
from scipy.spatial import ConvexHull

r = Path(__file__).parent
old = r.parent / "desktop-quality-9ikrgf16"
annotations = json.loads((old / "mask-annotations.json").read_text())
rows = []
for i in [1, 2, 3, 4]:
    p = r / f"case-{i + 20}"
    p.mkdir(exist_ok=True)
    shutil.copy2(r / f"case-{i}/source.png", p / "source.png")
    points = np.array(annotations["polygons"][str(i)])
    hull = points[ConvexHull(points).vertices]
    mask = Image.new("L", (512, 512))
    ImageDraw.Draw(mask).polygon([tuple(x) for x in hull], fill=255)
    if i in [2, 3]:
        ImageDraw.Draw(mask).ellipse(
            [213, 397, 336, 440] if i == 2 else [209, 397, 294, 445], fill=255
        )
    # Include fuzzy edges and holes between limbs; separate 4px context erasure from 4px selection expansion.
    mask = mask.filter(ImageFilter.MaxFilter(9))
    intent = np.array(mask) > 0
    hole = np.array(mask.filter(ImageFilter.MaxFilter(9))) > 0
    coverage = np.maximum(0, 1 - distance_transform_edt(~intent) / 2).astype("float32")
    coverage[~hole] = 0
    coverage.tofile(p / "coverage.f32")
    Image.fromarray((hole * 255).astype("uint8")).save(p / "hole.png")
    im = np.array(Image.open(p / "source.png"))
    im[intent] = (im[intent] * 0.5 + np.array([255, 30, 30]) * 0.5).astype("uint8")
    Image.fromarray(im).save(p / "mask.png")
    rows.append(
        {
            "case": i + 20,
            "sourceCase": i,
            "hull": hull.tolist(),
            "selectionExpansionPixelsAt512": 4,
            "additionalHoleExpansionPixelsAt512": 4,
            "reviewer": "assistant",
            "reason": "Eliminate missed fabric in concave silhouette and protect test from source-edge contamination",
            "sameInputsForBothModels": True,
        }
    )
(r / "mask-controls.json").write_text(json.dumps(rows, indent=2))
