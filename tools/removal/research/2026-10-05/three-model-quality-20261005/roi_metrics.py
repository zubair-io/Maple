import sys

import numpy as np
from PIL import Image

sys.path.insert(
    0, "/Users/riabuz/.codex/worktrees/removal-quality-spike/_Maple/src/scripts"
)
from compare_images import _lab, perceptual_difference


def roi_diff(cand_path, ref_path, roi_path):
    cand = np.asarray(Image.open(cand_path).convert("RGB"), dtype=np.float32) / 255
    ref = np.asarray(Image.open(ref_path).convert("RGB"), dtype=np.float32) / 255
    mask = np.asarray(Image.open(roi_path).convert("L")) > 127
    assert cand.shape == ref.shape and cand.shape[:2] == mask.shape and mask.any()
    # Exact native pixels, only skip unselected pixels before canonical color math.
    a = cand[mask][:, None, :]
    b = ref[mask][:, None, :]
    de, _, _ = perceptual_difference(a, b, _lab, False)
    de = de.ravel()
    bias = (a - b).mean(axis=(0, 1))
    return {
        "mean_deltaE": float(np.mean(de)),
        "p95_deltaE": float(np.percentile(de, 95)),
        "max_deltaE": float(np.max(de)),
        "bias_r": float(bias[0]),
        "bias_g": float(bias[1]),
        "bias_b": float(bias[2]),
        "n_pixels": int(mask.sum()),
    }


if __name__ == "__main__":
    import json
    from pathlib import Path

    r = Path(__file__).parent
    m = r.parent / "moebius-quality-yzitv43p"
    rows = json.loads((m / "raw-verification.json").read_text())
    row = next(
        x
        for x in rows
        if x["case"] == 14
        and x["candidate"] == "moebius-seed0"
        and x["grade"] == "auto_ev+0_wb+0"
    )
    p = m / "case-14/moebius-seed0-grades"
    g = row["grade"]
    actual = roi_diff(p / f"{g}-identity.png", p / f"{g}-truth.png", p / "coverage.png")
    expected = row["identityROI"]
    assert all(abs(actual[k] - expected[k]) < 1e-6 for k in actual), (actual, expected)
    (r / "roi-metric-parity.json").write_text(
        json.dumps(
            {
                "actual": actual,
                "canonicalPreviouslyMeasured": expected,
                "absoluteTolerance": 1e-6,
                "passed": True,
            },
            indent=2,
        )
    )
    print("Exact native ROI metrics match canonical full-frame calculation", flush=True)
