import json
import shutil
import struct
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter
from scipy.spatial import ConvexHull

r = Path(__file__).parent
old = r.parent / "desktop-quality-9ikrgf16"
context = r / "raw-child-mask-v2"
context.mkdir(exist_ok=True)
for name in ["context.json", "scene.f32", "input.f32", "input.png"]:
    shutil.copy2(old / "case-2/maple-sdr-plus2" / name, context / name)
annotations = json.loads((old / "mask-annotations.json").read_text())
points = np.array(annotations["polygons"]["2"]) * 4
hull = points[ConvexHull(points).vertices]
mask = Image.new("L", (2048, 2048))
draw = ImageDraw.Draw(mask)
draw.polygon([tuple(x) for x in hull], fill=255)
draw.ellipse([v * 4 for v in [213, 397, 336, 440]], fill=255)
mask = mask.filter(ImageFilter.MaxFilter(33))
mask.save(context / "selection.png")
box = mask.getbbox()
a = np.array(mask.crop(box)) > 0
(context / "intent-source.mimf").write_bytes(
    b"MIMF\x01\0\0\0"
    + struct.pack(
        "<6I", 8688, 5792, 6272 + box[0], 3072 + box[1], a.shape[1], a.shape[0]
    )
    + np.packbits(a.flatten(), bitorder="little").tobytes()
)
shutil.copy2(old / "case-2/protected.mimf", context / "protection-source.mimf")
