import json
from pathlib import Path

import numpy as np
from common import ROOT, resized_float
from PIL import Image

jobs = json.loads((ROOT / "jobs.json").read_text())
checks = []
for job in jobs:
    p = Path(job["folder"])
    n = job["nativeSide"]
    src = np.asarray(Image.open(p.parent / "source-native.png"))
    protected = np.asarray(Image.open(p.parent / "protected-native.png")) > 0
    for model in ["lama", f"qwen-seed{job['seed']}"]:
        assert (p / f"{model}.json").exists()
        pred = np.fromfile(p / f"{model}-prediction.f32", dtype="<f4").reshape(
            512, 512, 3
        )
        assert np.isfinite(pred).all()
        native = resized_float(pred, n)
        for coverage in ["expanded", "original"]:
            cov = np.fromfile(
                p.parent
                / (
                    "coverage-native.f32"
                    if coverage == "expanded"
                    else "coverage-original-native.f32"
                ),
                dtype="<f4",
            ).reshape(n, n)
            out = (
                np.floor(
                    (
                        src.astype("float32") / 255 * (1 - cov[:, :, None])
                        + native * cov[:, :, None]
                    )
                    * 255
                    + 0.5
                )
                .clip(0, 255)
                .astype("uint8")
            )
            assert np.array_equal(out[cov == 0], src[cov == 0])
            assert np.array_equal(out[protected], src[protected])
            Image.fromarray(out).save(p / f"{model}-{coverage}-native.png")
            Image.fromarray(out).resize((512, 512), Image.Resampling.LANCZOS).save(
                p / f"{model}-{coverage}-review.png"
            )
            if coverage == "expanded":
                assert np.array_equal(
                    out, np.asarray(Image.open(p / f"{model}-native.png"))
                )
            checks.append(
                {
                    "mode": job["mode"],
                    "case": job["case"],
                    "expansionModelPixels": job["expansionModelPixels"],
                    "model": model,
                    "coverage": coverage,
                    "outsideChangedPixels": 0,
                    "protectedChangedPixels": 0,
                    "rounding": "floor(float32 composite * 255 + 0.5), same as baseline",
                }
            )
(ROOT / "composite-verification.json").write_text(json.dumps(checks, indent=2))
print(f"{len(checks)} composites verified with identical baseline rounding")
