import hashlib
import json
import time

import numpy as np
from common import ROOT
from PIL import Image

r = ROOT
rows = {}
while len(rows) < 90:
    for mode, root in [("photo", r), ("raw-input", r / "raw")]:
        for p in root.glob("case-*/*/*.json"):
            if p.name not in [
                "lama.json",
                "klein-seed0.json",
                "klein-seed1.json",
                "qwen-seed0.json",
                "qwen-seed1.json",
            ]:
                continue
            key = str(p.relative_to(r))
            if key in rows:
                continue
            report = json.loads(p.read_text())
            side = int(p.parent.name)
            parent = p.parent.parent
            label = p.stem
            src = np.asarray(Image.open(parent / "source-native.png"))
            n = src.shape[0]
            out = np.asarray(Image.open(p.with_name(label + "-native.png")))
            cov = np.fromfile(parent / "coverage-native.f32", dtype="<f4").reshape(n, n)
            protect = np.asarray(Image.open(parent / "protected-native.png")) > 0
            assert (
                src.shape == out.shape
                and np.array_equal(src[cov == 0], out[cov == 0])
                and np.array_equal(src[protect], out[protect])
            )
            pred = np.fromfile(
                p.with_name(label + "-prediction.f32"), dtype="<f4"
            ).reshape(side, side, 3)
            assert np.isfinite(pred).all() and pred.min() >= 0 and pred.max() <= 1
            rows[key] = {
                "mode": mode,
                "nativeSide": n,
                "modelSide": side,
                "nativeOutsideCoverageChanged": 0,
                "nativeProtectedChanged": 0,
                "finiteModelSamples": True,
                "inputSha256": hashlib.sha256(
                    (p.parent / "source.png").read_bytes()
                ).hexdigest(),
                "holeSha256": hashlib.sha256(
                    (p.parent / "hole.png").read_bytes()
                ).hexdigest(),
                "predictionSha256": hashlib.sha256(
                    p.with_name(label + "-prediction.f32").read_bytes()
                ).hexdigest(),
            }
    (r / "model-verification.json").write_text(json.dumps(rows, indent=2))
    if len(rows) < 90:
        time.sleep(5)
print("All 90 model outputs verified at native composition geometry", flush=True)
