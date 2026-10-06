import json
from pathlib import Path

import numpy as np
from PIL import Image

r = Path(__file__).parent
old = r.parent / "desktop-quality-9ikrgf16"
for i, context in [(14, r / "raw-case-4"), (12, old / "case-2/maple-sdr-plus2")]:
    p = r / f"case-{i}"
    p.mkdir(exist_ok=True)
    recipe = json.loads((context / "context.json").read_text())
    side = recipe["window"]["width"]
    rgb = np.fromfile(context / "input.f32", dtype="<f4").reshape(3, side, side)
    scaled = np.stack(
        [
            np.array(Image.fromarray(c).resize((512, 512), Image.Resampling.BILINEAR))
            for c in rgb
        ]
    ).clip(0, 1)
    scaled.tofile(p / "input.f32")
    source = np.floor(scaled.transpose(1, 2, 0) * 255 + 0.5).astype("uint8")
    Image.fromarray(source).save(p / "source.png")
    planes = np.fromfile(context / "masks.f32", dtype="<f4").reshape(2, side, side)
    hole = (
        np.array(
            Image.fromarray(planes[0]).resize((512, 512), Image.Resampling.NEAREST)
        )
        > 0
    )
    coverage = np.array(
        Image.fromarray(planes[1]).resize((512, 512), Image.Resampling.BILINEAR)
    )
    coverage[~hole] = 0
    Image.fromarray((hole * 255).astype("uint8")).save(p / "hole.png")
    coverage.tofile(p / "coverage.f32")
    (p / "context-reference.json").write_text(
        json.dumps(
            {
                "path": str(context),
                "generationResolution": 512,
                "sourceWindowSide": side,
                "rgbResampling": "bilinear float32",
                "maskResampling": "nearest",
                "inputExposureEV": recipe["encoding"].get("exposure_ev", 0),
                "nativeDetailQualified": False,
            },
            indent=2,
        )
    )
