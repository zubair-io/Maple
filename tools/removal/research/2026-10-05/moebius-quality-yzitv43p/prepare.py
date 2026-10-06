import json
from pathlib import Path

import numpy as np
from PIL import Image
from scipy.ndimage import distance_transform_edt

r = Path(__file__).parent
old = r.parent / "desktop-quality-9ikrgf16"
for i in [4, 1, 2, 3]:
    p = r / f"case-{i}"
    p.mkdir(exist_ok=True)
    im = (
        Image.open(old / f"case-{i}/source.png")
        .convert("RGB")
        .resize((512, 512), Image.Resampling.LANCZOS)
    )
    im.save(p / "source.png")
    intent = (
        np.asarray(
            Image.open(old / f"case-{i}/intent.png").resize(
                (512, 512), Image.Resampling.NEAREST
            )
        )
        > 0
    )
    hole = (
        np.asarray(
            Image.open(old / f"case-{i}/hole.png").resize(
                (512, 512), Image.Resampling.NEAREST
            )
        )
        > 0
    )
    # Both models share exactly the same input hole and output coverage.
    coverage = np.maximum(0, 1 - distance_transform_edt(~intent) / 2).astype("float32")
    coverage[~hole] = 0
    Image.fromarray((hole * 255).astype("uint8")).save(p / "hole.png")
    coverage.tofile(p / "coverage.f32")
    a = np.array(im)
    a[intent] = (a[intent] * 0.5 + np.array([255, 30, 30]) * 0.5).astype("uint8")
    Image.fromarray(a).save(p / "mask.png")
(r / "protocol.json").write_text(
    json.dumps(
        {
            "cases": [4, 1, 2, 3],
            "input": "Full-resolution embedded camera JPEG, same frozen crop resized once to512 using Lanczos",
            "mask": "Frozen prior hole resized nearest to512, same for both models",
            "coverage": "Prior intent resized nearest,2px linear external feather clipped to hole",
            "rawQualification": False,
            "case5": "Deferred until overlap mask independently reviewed",
            "model": "Official Moebius ft_places2",
            "steps": 20,
            "strength": 0.99,
            "guidance": 2.5,
            "noiseOffset": 0.0357,
            "paste": False,
            "seeds": [0, 1],
            "precision": "float32",
            "resolution": 512,
        },
        indent=2,
    )
)
