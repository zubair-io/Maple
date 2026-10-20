import json
import sys
from pathlib import Path

sys.path.insert(
    0, "/Users/riabuz/.codex/worktrees/color-suite-progress/_Maple/src/scripts"
)
import auto_profile_quality as q
import colour
import numpy as np

b = Path(__file__).resolve().parent.parent
r = Path(__file__).resolve().parent
old = {
    x["fixture"]: x
    for x in json.loads((b / "auto-embedded-jpeg-source37/summary.json").read_text())[
        "cases"
    ]
}
results = []
for row in json.loads((r / "full-suite/summary.json").read_text())["cases"]:
    name = row["fixture"]
    if (
        row.get("candidate_sha256") == old[name].get("candidate_sha256")
        or "quality" not in row
    ):
        continue
    before, reference = q.load_display_pair(
        b / "auto-embedded-jpeg-source37" / name / "auto.png",
        r / "full-suite" / name / "embedded.png",
    )
    after, _ = q.load_display_pair(
        r / "full-suite" / name / "auto.png", r / "full-suite" / name / "embedded.png"
    )
    target = colour.XYZ_to_Lab(colour.sRGB_to_XYZ(reference))
    deltas = []
    for image in [before, after]:
        de = colour.delta_E(
            colour.XYZ_to_Lab(colour.sRGB_to_XYZ(image)), target, method="CIE 2000"
        )
        deltas.append(
            np.array(
                [
                    tile.mean()
                    for row in np.array_split(de, 8, axis=0)
                    for tile in np.array_split(row, 8, axis=1)
                ]
            )
        )
    diffs = deltas[1] - deltas[0]
    result = {
        "fixture": name,
        "worsened_regions": int((diffs > 1e-6).sum()),
        "max_region_increase": float(diffs.max()),
        "regions": [
            {
                "row": i // 8,
                "column": i % 8,
                "before": float(deltas[0][i]),
                "after": float(deltas[1][i]),
            }
            for i in range(64)
        ],
    }
    results.append(result)
    print({k: v for k, v in result.items() if k != "regions"}, flush=True)
(r / "perceptual-region-audit.json").write_text(json.dumps(results, indent=2) + "\n")
