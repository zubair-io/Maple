import json
import sys
from pathlib import Path

import numpy as np

root = Path(__file__).resolve().parent
sys.path.insert(0, str(root / "source"))
import auto_profile_alignment as alignment
import auto_profile_quality as quality

rows = []
for case in json.loads((root / "full-suite/summary.json").read_text())["cases"]:
    if "quality" not in case:
        continue
    folder = root / "full-suite" / case["fixture"]
    cand, ref = quality.load_display_pair(folder / "auto.png", folder / "embedded.png")
    ref, valid = alignment.resample_reference(
        ref, np.array(case["quality"]["alignment"]["candidate_to_reference_normalized"])
    )
    h, w = valid.shape
    y, x = np.mgrid[:h, :w]
    u = (x + 0.5) / w - 0.5
    v = (y + 0.5) / h - 0.5
    r2 = (u * u + v * v) * 2
    use = valid & ((x + 3 * y) % 8 == 0)
    rgb = cand[use]
    radius = r2[use]
    target = ref[use]
    xx = x[use]
    yy = y[use]
    base = np.column_stack(
        [
            np.ones(len(rgb)),
            rgb,
            rgb * rgb,
            rgb[:, 0] * rgb[:, 1],
            rgb[:, 0] * rgb[:, 2],
            rgb[:, 1] * rgb[:, 2],
        ]
    )
    radial = np.column_stack([base, radius, radius * radius, radius[:, None] * rgb])
    train = ((xx * 8 // w + yy * 8 // h) % 2) == 0
    hold = ~train
    report = {"fixture": case["fixture"], "diagnostic_only": True, "models": []}
    for name, design in [("global_polynomial", base), ("global_plus_radial", radial)]:
        beta = np.linalg.solve(
            design[train].T @ design[train] + np.eye(design.shape[1]) * 1e-4,
            design[train].T @ target[train],
        )
        prediction = design[hold] @ beta
        error = np.abs(prediction - target[hold])
        rad = radius[hold]
        report["models"].append(
            {
                "name": name,
                "heldout_mae_rgb": error.mean(axis=0).tolist(),
                "heldout_outer_mae_rgb": error[rad > 0.6].mean(axis=0).tolist(),
                "heldout_max_region_mae": max(
                    np.abs(prediction - target[hold])[
                        ((xx[hold] * 8 // w) == gx) & ((yy[hold] * 8 // h) == gy)
                    ]
                    .mean(axis=0)
                    .max()
                    for gy in range(8)
                    for gx in range(8)
                    if (gx + gy) % 2
                ),
                "samples": int(hold.sum()),
            }
        )
    report["raw_outer_signed_rgb"] = (
        (cand - ref)[valid & (r2 > 0.6)].mean(axis=0).tolist()
    )
    rows.append(report)
    print(
        case["fixture"],
        [(m["name"], round(m["heldout_max_region_mae"], 4)) for m in report["models"]],
        flush=True,
    )
    (root / "radial-results.json").write_text(json.dumps(rows, indent=2) + "\n")
