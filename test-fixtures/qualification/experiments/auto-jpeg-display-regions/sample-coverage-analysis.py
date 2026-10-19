import json
from pathlib import Path

import colour
import numpy as np
from scipy.sparse import csr_matrix

r = Path(__file__).resolve().parent
d = json.loads((r / "diagnostic/auto_fit_observations.json").read_text())
rows = d["display"] or d["native"]
weights = []
indices = []
pointer = [0]
for row in rows:
    for i, w in row["weights"]:
        indices.append(i)
        weights.append(w)
    pointer.append(len(weights))
a = csr_matrix((weights, indices, pointer), shape=(len(rows), d["grid"] ** 3))
candidate = a @ np.array(d["coarse"]).reshape(-1, 3)
baseline = np.array([row["baseline"] for row in rows])
target = np.array([row["target"] for row in rows])
lab = lambda x: colour.XYZ_to_Lab(colour.sRGB_to_XYZ(x))
lab_target = lab(target)
de = [
    colour.delta_E(lab(image), lab_target, method="CIE 2000")
    for image in [candidate, baseline]
]
regions = np.array([row["region"] for row in rows])
valid = np.array([row["validation"] for row in rows])
result = []
for index in range(64):
    mask = regions == index
    delta = de[0][mask] - de[1][mask]
    hold = (regions == index) & valid
    result.append(
        {
            "region": index,
            "samples": int(mask.sum()),
            "all_sample_increase": float(delta.mean()),
            "held_out_increase": float((de[0][hold] - de[1][hold]).mean()),
            "paired_standard_error": float(delta.std() / np.sqrt(len(delta))),
        }
    )
print("worst all", max(result, key=lambda x: x["all_sample_increase"]))
print("worst holdout", max(result, key=lambda x: x["held_out_increase"]))
(r / "sample-coverage-analysis.json").write_text(json.dumps(result, indent=2) + "\n")
