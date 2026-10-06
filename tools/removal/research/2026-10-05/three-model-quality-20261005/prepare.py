import json
from pathlib import Path

import numpy as np
from PIL import Image

r = Path(__file__).parent
e = r.parent / "desktop-quality-9ikrgf16"
m = r.parent / "moebius-quality-yzitv43p"
cases = json.loads((e / "cases.json").read_text())
for c in cases:
    i = c["id"]
    p = r / f"case-{i}"
    p.mkdir(exist_ok=True)
    n = c["window"][2]
    prior = m / f"case-{i + 20 if i < 5 else 5}"
    src = Image.open(e / f"case-{i}/source.png").convert("RGB")
    assert src.size == (n, n)
    src.save(p / "source-native.png")
    cov = np.fromfile(prior / "coverage.f32", dtype="<f4").reshape(512, 512)
    # Freeze existing reviewed mask on its original 512 grid, lift once to native;
    # every model resolution derives from this same canonical native geometry.
    native = np.array(
        Image.fromarray(cov).resize((n, n), Image.Resampling.BILINEAR), dtype=np.float32
    )
    keep = (
        Image.open(prior / "protected.png")
        if (prior / "protected.png").exists()
        else Image.new("L", (512, 512))
    )
    keep = keep.resize((n, n), Image.Resampling.NEAREST)
    protected = np.array(keep) > 0
    native[protected] = 0
    native.tofile(p / "coverage-native.f32")
    keep.save(p / "protected-native.png")
    hole = Image.open(prior / "hole.png").resize((n, n), Image.Resampling.NEAREST)
    hole.save(p / "hole-native.png")
    overlay = np.array(src)
    sel = native > 0
    overlay[sel] = (overlay[sel] * 0.5 + np.array([255, 30, 30]) * 0.5).astype("uint8")
    Image.fromarray(overlay).resize((512, 512)).save(p / "mask-review.png")
    for size in [512, 768, 1024]:
        out = p / str(size)
        out.mkdir(exist_ok=True)
        src.resize((size, size), Image.Resampling.LANCZOS).save(out / "source.png")
        hole.resize((size, size), Image.Resampling.NEAREST).save(out / "hole.png")
        np.array(
            Image.fromarray(native).resize((size, size), Image.Resampling.BILINEAR),
            dtype="<f4",
        ).tofile(out / "coverage.f32")
    c["canonicalMaskSource"] = str(prior)
    c["maskReviewer"] = "assistant, not human ground truth"
(r / "cases.json").write_text(json.dumps(cases, indent=2))
print("Prepared five cases, three scales, frozen native coverage")
