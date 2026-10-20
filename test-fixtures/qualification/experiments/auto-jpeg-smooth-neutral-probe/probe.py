import json
import subprocess
import sys
import time
from pathlib import Path

import colour
import numpy as np
from scipy.optimize import minimize
from scipy.sparse import csr_matrix

root = Path(__file__).resolve().parent
base = root.parent
sys.path.insert(
    0, "/Users/riabuz/.codex/worktrees/color-suite-progress/_Maple/src/scripts"
)
import banding_check as band

old = base / "auto-jpeg-fine-neutral-anchors/pilot_0010/diagnostic"
data = json.loads((old / "auto_fit_observations.json").read_text())
n = data["prior_size"]
count = n**3
origin = np.array(
    json.loads((old / "auto_fine_refinement.json").read_text())["selected_artifact"]
).reshape(-1, 3)
candidate = np.array(
    json.loads(
        (
            base
            / "auto-jpeg-fine-refinement/pilot_0010/diagnostic/auto_fine_refinement.json"
        ).read_text()
    )["selected_artifact"]
).reshape(-1, 3)
diag = np.arange(n) * (1 + n + n * n)
t = np.arange(1024, dtype=np.float32) / np.float32(1023)
encoded = (
    np.where(t <= 0.0031308, t * 12.92, 1.055 * np.power(t, 1 / 2.4) - 0.055)
    .astype(np.float32)
    .astype(float)
)
x = encoded * (n - 1)
lo = np.floor(x).astype(int).clip(0, n - 2)
frac = x - lo
h = np.zeros((1024, n))
h[np.arange(1024), lo] = 1 - frac
h[np.arange(1024), lo + 1] = frac
lum = np.array([0.2627, 0.678, 0.0593])
d1 = np.diff(h, axis=0)
lower = np.minimum(np.diff(origin[diag], axis=0), 0.002 / (n - 1))


def decode(z):
    return np.where(z <= 0.04045, z / 12.92, ((z + 0.055) / 1.055) ** 2.4)


def derivative(z):
    return np.where(z <= 0.04045, 1 / 12.92, 2.4 / 1.055 * ((z + 0.055) / 1.055) ** 1.4)


prior_max = np.array(
    [
        np.max(np.abs(origin[diag, c] - origin[diag, d]))
        for c, d in [(0, 1), (0, 2), (1, 2)]
    ]
)


def values(z):
    return decode(h @ z.reshape(n, 3)) @ lum


def constraints(v):
    z = v.reshape(n, 3)
    y = values(v)
    step = np.diff(y)
    curve = np.diff(step)
    drift = np.concatenate(
        [
            prior_max[k] + sign * (z[:, c] - z[:, d])
            for k, (c, d) in enumerate([(0, 1), (0, 2), (1, 2)])
            for sign in [-1, 1]
        ]
    )
    return np.r_[
        step - 1.5e-6,
        0.0038 - curve,
        0.0038 + curve,
        (np.diff(z, axis=0) - lower).ravel(),
        drift,
    ]


def jacobian(v):
    z = v.reshape(n, 3)
    gradient = (
        h[:, :, None] * derivative(h @ z)[:, None, :] * lum[None, None, :]
    ).reshape(1024, -1)
    step = np.diff(gradient, axis=0)
    curve = np.diff(step, axis=0)
    own = np.zeros(((n - 1) * 3, n * 3))
    r = 0
    for i in range(n - 1):
        for c in range(3):
            own[r, (i + 1) * 3 + c] = 1
            own[r, i * 3 + c] = -1
            r += 1
    drift = []
    for c, d in [(0, 1), (0, 2), (1, 2)]:
        for sign in [-1, 1]:
            j = np.zeros((n, n * 3))
            j[np.arange(n), np.arange(n) * 3 + c] = sign
            j[np.arange(n), np.arange(n) * 3 + d] = -sign
            drift.append(j)
    return np.vstack([step, -curve, curve, own, *drift])


target = candidate[diag].ravel()
objective = lambda z: (np.sum((z - target) ** 2), 2 * (z - target))
start = time.monotonic()
result = minimize(
    objective,
    np.repeat(np.linspace(0, 1, n), 3),
    jac=True,
    method="SLSQP",
    bounds=[(0, 1)] * (n * 3),
    constraints=[{"type": "ineq", "fun": constraints, "jac": jacobian}],
    options={"maxiter": 200, "ftol": 1e-12},
)
report = {
    "diagnostic_only": True,
    "source_fixture": "test_0010",
    "success": bool(result.success),
    "message": result.message,
    "iterations": int(result.nit),
    "seconds": time.monotonic() - start,
    "minimum_constraint": float(constraints(result.x).min()),
    "objective": float(result.fun),
}
print(json.dumps(report), flush=True)
(root / "solver.json").write_text(json.dumps(report, indent=2) + "\n")
np.save(root / "gray.npy", result.x.reshape(n, 3))
if not result.success or constraints(result.x).min() < -1e-8:
    raise SystemExit(1)
confidence = np.ones(count)
origin.astype("<f4").tofile(root / "prior.bin")
candidate.astype("<f4").tofile(root / "candidate.bin")
confidence.astype("<f8").tofile(root / "confidence.bin")
anchors = origin.copy()
anchors[diag] = result.x.reshape(n, 3)
anchors.astype("<f4").tofile(root / "anchors.bin")
subprocess.run(
    [
        str(root / "project"),
        str(root / "prior.bin"),
        str(root / "candidate.bin"),
        str(root / "confidence.bin"),
        str(root / "projected.bin"),
        str(root / "anchors.bin"),
    ],
    check=True,
)
projected = np.fromfile(root / "projected.bin", dtype="<f4").reshape(-1, 3)
np.save(root / "projected.npy", projected)
reports = []
for label, lut in [
    ("qualified9eb", origin),
    ("rejected_a431", candidate),
    ("smooth_neutral_projection", projected),
]:
    rgb = (h @ lut[diag])[None, :, :]
    v = band.ramp_axis_values(rgb, "18_auto_tail", "luma")
    row = {
        "label": label,
        "neutral": {
            "second_difference": band.second_difference_spike(v),
            "flat_run": band.flat_run(v),
            "rgb_drift": band.per_row_rgb_drift(rgb),
        },
        "sets": [],
    }
    for name, rows in [("native", data["native"]), ("display", data["display"])]:
        vals = []
        ids = []
        offs = [0]
        for entry in rows:
            for i, w in entry["artifact_weights"]:
                ids.append(i)
                vals.append(w)
            offs.append(len(vals))
        a = csr_matrix((vals, ids, offs), shape=(len(rows), count))
        pred = a @ lut
        target = np.array([r["target"] for r in rows])
        pop = np.array([r["population"] for r in rows])
        hold = np.array([r["validation"] for r in rows])
        region = np.array([r["region"] for r in rows])
        error = np.abs(pred - target)
        de = colour.delta_E(
            colour.XYZ_to_Lab(colour.sRGB_to_XYZ(pred)),
            colour.XYZ_to_Lab(colour.sRGB_to_XYZ(target)),
            method="CIE 2000",
        )
        row["sets"].append(
            {
                "name": name,
                "mean_de": float(np.average(de, weights=pop)),
                "heldout_mae_rgb": np.average(
                    error[hold], axis=0, weights=pop[hold]
                ).tolist(),
                "region_mean_de": [
                    float(np.average(de[region == i], weights=pop[region == i]))
                    for i in range(64)
                ],
                "region_mae_rgb": [
                    np.average(
                        error[region == i], axis=0, weights=pop[region == i]
                    ).tolist()
                    for i in range(64)
                ],
            }
        )
    reports.append(row)
(root / "results.json").write_text(json.dumps(reports, indent=2) + "\n")
print(json.dumps(reports[-1]["neutral"]), flush=True)
