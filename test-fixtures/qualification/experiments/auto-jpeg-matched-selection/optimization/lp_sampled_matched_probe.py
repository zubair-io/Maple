import json
from pathlib import Path

import numpy as np
from scipy.sparse import csr_matrix, eye, hstack, vstack

root = Path(__file__).resolve().parent


def rows_matrix(rows, key, count):
    values, indices, offsets = [], [], [0]
    for row in rows:
        for index, weight in row[key]:
            values.append(weight)
            indices.append(index)
        offsets.append(len(values))
    return csr_matrix((values, indices, offsets), shape=(len(rows), count))


def subdivision(size, fine):
    values, indices, offsets = [], [], [0]
    for z in range(fine):
        for y in range(fine):
            for x in range(fine):
                p = np.array([x, y, z]) * (size - 1) / (fine - 1)
                lo = np.minimum(np.floor(p).astype(int), size - 2)
                f = p - lo
                axes = np.argsort(-f, kind="stable")
                stride = np.array([1, size, size * size])
                start = int(lo @ stride)
                indices.extend(
                    [
                        start,
                        start + int(stride[axes[0]]),
                        start + int(stride[axes[0]] + stride[axes[1]]),
                        start + int(stride.sum()),
                    ]
                )
                values.extend(
                    [
                        1 - f[axes[0]],
                        f[axes[0]] - f[axes[1]],
                        f[axes[1]] - f[axes[2]],
                        f[axes[2]],
                    ]
                )
                offsets.append(len(values))
    return csr_matrix((values, indices, offsets), shape=(fine**3, size**3))


import argparse
import hashlib
import time

import scipy
from scipy.optimize import linprog

args = argparse.ArgumentParser()
args.add_argument("--case", default="0010")
args.add_argument("--channel", default="B", choices=list("RGB"))
args.add_argument("--time-limit", type=float, default=120)
options = args.parse_args()
channel = "RGB".index(options.channel)
source = root.parent / "auto-jpeg-matched-selection/pilot_0015/diagnostic"
output = root / ("sampled_matched_" + options.case + "_" + options.channel)
output.mkdir(exist_ok=False)
data = json.loads((source / "auto_fit_observations.json").read_text())
step = json.loads((source / "auto_fit_step.json").read_text())["fraction"]
n = data["prior_size"]
k = 9**3
prior = np.array(data["prior"]).reshape(-1, 3)
current = prior + step * (np.array(data["artifact"]).reshape(-1, 3) - prior)
p = subdivision(9, n)
sets = []
for name, rows in [("native", data["aligned"]), ("display", data["aligned"])]:
    fine = rows_matrix(rows, "artifact_weights", n**3)
    population = np.array([r["population"] for r in rows])
    target = np.array([r["target"] for r in rows])
    train = np.array([not r["validation"] and i % 4 == 0 for i, r in enumerate(rows)])
    base = fine @ current
    sets.append(
        {
            "name": name,
            "rows": rows,
            "fine": fine,
            "a": (fine @ p).tocsr(),
            "population": population,
            "target": target,
            "train": train,
            "base": base,
        }
    )
matrices = []
targets = []
bases = []
populations = []
groups = []
signed = []
offset = 0
for s in sets:
    take = s["train"]
    w = s["population"][take]
    y = s["target"][take]
    base = s["base"][take, channel]
    size = len(w)
    matrices.append(s["a"][take])
    targets.append(y[:, channel])
    bases.append(base)
    populations.append(w)
    if s["name"] == "native":
        bands = np.searchsorted(
            [0.1, 0.25, 0.5, 0.75], y @ np.array([0.2126, 0.7152, 0.0722]), side="right"
        )
        inner = np.array([r["in_bias_region"] for r in s["rows"]])[take]
        selections = [("full", np.ones(size, dtype=bool))] + [
            (f"band{i}", bands == i) for i in range(5)
        ]
        for label, mask in selections:
            if mask.any():
                groups.append(
                    (
                        f"native-{label}",
                        np.flatnonzero(mask) + offset,
                        w[mask],
                        float(
                            np.average(
                                np.abs(base[mask] - y[mask, channel]), weights=w[mask]
                            )
                        ),
                    )
                )
        for i in range(5):
            mask = (bands == i) & inner
            if mask.any():
                signed.append(
                    (
                        f"bias-band{i}",
                        np.flatnonzero(mask) + offset,
                        w[mask],
                        float(
                            np.average(base[mask] - y[mask, channel], weights=w[mask])
                        ),
                    )
                )
    else:
        region = np.array([r["region"] for r in s["rows"]])[take]
        for i in range(64):
            mask = region == i
            if mask.any():
                groups.append(
                    (
                        f"display-tile{i}",
                        np.flatnonzero(mask) + offset,
                        w[mask],
                        float(
                            np.average(
                                np.abs(base[mask] - y[mask, channel]), weights=w[mask]
                            )
                        ),
                    )
                )
    offset += size
A = vstack(matrices, format="csr")
y = np.concatenate(targets)
base = np.concatenate(bases)
w = np.concatenate(populations)
m = len(y)
# Variables are the 9-cube residual, per-observation absolute-error epigraphs, and worst normalized group error.
zero = csr_matrix((m, 1))
identity = eye(m, format="csr")
blocks = [hstack([A, -identity, zero]), hstack([-A, -identity, zero])]
rhs = [y - base, base - y]
group_rows = []
group_cols = []
group_values = []
gb = []
labels = []
for label, indices, weight, before in groups:
    index = len(gb)
    group_rows.extend([index] * len(indices))
    group_cols.extend(k + indices)
    group_values.extend(weight / weight.sum())
    group_rows.append(index)
    group_cols.append(k + m)
    group_values.append(-0.05)
    gb.append(0.0)
    labels.append(label)
    if before <= 0.05:
        index = len(gb)
        group_rows.extend([index] * len(indices))
        group_cols.extend(k + indices)
        group_values.extend(weight / weight.sum())
        gb.append(0.05)
        labels.append(label + "-preserve-pass")
group = csr_matrix((group_values, (group_rows, group_cols)), shape=(len(gb), k + m + 1))
blocks.append(group)
rhs.append(np.array(gb))
for label, indices, weight, before in signed:
    mean = csr_matrix(
        (weight / weight.sum(), (np.zeros(len(indices), dtype=int), indices)),
        shape=(1, m),
    )
    linear = mean @ A
    bias = float((mean @ (base - y)).item())
    tail = csr_matrix((1, m))
    t = csr_matrix([[-0.05]])
    if abs(before) <= 0.05:
        blocks.extend(
            [
                hstack([linear, tail, csr_matrix((1, 1))]),
                hstack([-linear, tail, csr_matrix((1, 1))]),
            ]
        )
        rhs.extend([np.array([0.05 - bias]), np.array([0.05 + bias])])
    else:
        blocks.extend([hstack([linear, tail, t]), hstack([-linear, tail, t])])
        rhs.extend([np.array([-bias]), np.array([bias])])
zfine = csr_matrix((n**3, m + 1))
blocks.extend([hstack([p, zfine]), hstack([-p, zfine])])
rhs.extend([1 - current[:, channel], current[:, channel]])
node = np.arange(n**3)
coordinate = (node // (n**channel)) % n
lo = node[coordinate < n - 1]
hi = lo + n**channel
diagonal = 1 + n + n * n
gray = np.arange(n - 1) * diagonal
lo = np.r_[lo, gray]
hi = np.r_[hi, gray + diagonal]
edge = p[lo] - p[hi]
lower = np.minimum(
    prior[hi, channel] - prior[lo, channel], float(np.float32(0.002 / (n - 1)))
)
bound = current[hi, channel] - current[lo, channel] - lower
blocks.append(hstack([edge, csr_matrix((len(lo), m + 1))]))
rhs.append(bound + 1e-7)
constraint = vstack(blocks, format="csr")
bound = np.concatenate(rhs)
cost = np.zeros(k + m + 1)
cost[-1] = 1.0
bounds = [(None, None)] * k + [(0, None)] * (m + 1)
print(
    json.dumps(
        {
            "case": options.case,
            "channel": options.channel,
            "scipy": scipy.__version__,
            "variables": len(cost),
            "constraints": len(bound),
            "nnz": constraint.nnz,
            "training_rows": m,
            "groups": len(groups),
            "phase": "minimize worst native/display group absolute error with existing bounds and projection inequalities",
        }
    ),
    flush=True,
)
t0 = time.monotonic()
result = linprog(
    cost,
    A_ub=constraint,
    b_ub=bound,
    bounds=bounds,
    method="highs-ipm",
    options={
        "time_limit": options.time_limit,
        "disp": True,
        "dual_feasibility_tolerance": 1e-7,
    },
)
elapsed = time.monotonic() - t0
report = {
    "case": options.case,
    "channel": options.channel,
    "qualification": "cached training-operator feasibility diagnostic, NOT physical qualification or a complete image pass",
    "scipy": scipy.__version__,
    "success": bool(result.success),
    "status": int(result.status),
    "message": result.message,
    "seconds": elapsed,
    "source_observations_sha256": hashlib.sha256(
        (source / "auto_fit_observations.json").read_bytes()
    ).hexdigest(),
    "source_renderer": "91fa556d44",
    "projection_constraints_included": True,
    "float_projection_rounding_tolerance": 1e-7,
    "training_stride": 4,
    "bounds_included": True,
    "heldout_used_for_training": False,
}
if result.x is not None:
    delta = result.x[:k]
    candidate = current.copy()
    candidate[:, channel] += p @ delta
    np.save(output / "candidate.npy", candidate)
    np.save(output / "delta.npy", delta)
    report["optimal_training_worst_ratio"] = float(result.x[-1])
    report["maximum_constraint_residual"] = float(np.max(constraint @ result.x - bound))
    report["node_min_max"] = [float(candidate.min()), float(candidate.max())]
    report["sets"] = []
    for s in sets:
        error = np.abs(s["fine"] @ candidate - s["target"])
        before = np.abs(s["base"] - s["target"])
        weights = s["population"]
        target = s["target"]
        rows = s["rows"]
        details = []
        if s["name"] == "native":
            bands = np.searchsorted(
                [0.1, 0.25, 0.5, 0.75],
                target @ np.array([0.2126, 0.7152, 0.0722]),
                side="right",
            )
            selections = [("full", np.ones(len(rows), dtype=bool))] + [
                (f"band{i}", bands == i) for i in range(5)
            ]
        else:
            region = np.array([r["region"] for r in rows])
            selections = [(f"tile{i}", region == i) for i in range(64)]
        for label, take in selections:
            if take.any():
                details.append(
                    {
                        "group": label,
                        "before": float(
                            np.average(before[take, channel], weights=weights[take])
                        ),
                        "after": float(
                            np.average(error[take, channel], weights=weights[take])
                        ),
                        "represented_pixels": int(weights[take].sum()),
                    }
                )
        report["sets"].append({"name": s["name"], "groups": details})
(output / "result.json").write_text(json.dumps(report, indent=2) + "\n")
print(json.dumps({k: v for k, v in report.items() if k != "sets"}), flush=True)
