import hashlib
import json
import subprocess
from pathlib import Path

import numpy as np
from PIL import Image

root = Path(__file__).resolve().parent
old = root.parent / "auto-jpeg-curve-absence/full-suite"
cases = json.loads((old / "summary.json").read_text())["cases"]
results = []
for c in cases:
    if "quality" not in c:
        continue
    folder = root / "references" / c["fixture"]
    folder.mkdir(parents=True, exist_ok=True)
    out = folder / "embedded.png"
    subprocess.run(
        [str(root / "maple-cli"), "extract-preview", c["raw"], "--out", str(out)],
        check=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    digest = hashlib.sha256(out.read_bytes()).hexdigest()
    results.append(
        {
            "fixture": c["fixture"],
            "old_sha256": c["reference_sha256"],
            "new_sha256": digest,
            "same": digest == c["reference_sha256"],
        }
    )
    print(results[-1], flush=True)
assert [r["fixture"] for r in results if not r["same"]] == ["test_0005"]
jpeg = (
    np.asarray(
        Image.open(root / "test_0005-original-preview.jpg").convert("RGB"), dtype=float
    )
    / 255
)
linear = jpeg ** (563 / 256)
adobe_xyz = np.array(
    [
        [0.5767309, 0.1855540, 0.1881852],
        [0.2973769, 0.6273491, 0.0752741],
        [0.0270343, 0.0706872, 0.9911085],
    ]
)
xyz_srgb = np.array(
    [
        [3.2404542, -1.5371385, -0.4985314],
        [-0.9692660, 1.8760108, 0.0415560],
        [0.0556434, -0.2040259, 1.0572252],
    ]
)
rgb = linear @ adobe_xyz.T @ xyz_srgb.T
expected = np.where(
    rgb <= 0.0031308, 12.92 * rgb, 1.055 * np.maximum(rgb, 0) ** (1 / 2.4) - 0.055
).clip(0, 1)
actual = (
    np.asarray(Image.open(root / "references/test_0005/embedded.png"), dtype=float)
    / 255
)
old_pixels = np.asarray(Image.open(old / "test_0005/embedded.png"), dtype=float) / 255
error = np.abs(actual - expected)
report = {
    "all16": results,
    "independent_adobe_matrix_reference": {
        "mae_rgb": error.mean(axis=(0, 1)).tolist(),
        "p99_abs": float(np.quantile(error, 0.99)),
        "max_abs": float(error.max()),
        "old_vs_jpeg_mae": float(np.abs(old_pixels - jpeg).mean()),
    },
}
(root / "reference-audit.json").write_text(json.dumps(report, indent=2) + "\n")
assert np.quantile(error, 0.99) < 3 / 255, report
print(report["independent_adobe_matrix_reference"])
