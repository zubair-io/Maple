#!/usr/bin/env python3
"""Compare two `maple-cli render --lens-warp-out` dumps of the same RAW and
gate the difference against recorded ceilings (#3566).

    lens_warp_diff.py <a.json> <b.json> <ceilings.json> [--record]

Per family the script reports, in pixels of the full active area:
  zoom        — the uniform zoom between the two fields (|z − 1|), a framing
                convention (Adobe scale factor vs Lensfun's fixed image circle)
  distortion  — |green_a − zoom·green_b| per grid point (mean, max), i.e. shape
  tca         — |(red − green)_a − (red − green)_b| and the blue equivalent
  vignetting  — |gain_a / gain_b − 1| (mean, max)

`--record` writes ceilings 10 % above the measured values instead of gating,
for the first run of a new pair. Exit 1 when any measure exceeds its ceiling.
"""
import json, math, sys


def load(path):
    with open(path) as f:
        return json.load(f)


def dist(p, q):
    return math.hypot(p[0] - q[0], p[1] - q[1])


def zoom_between(a, b):
    """Least-squares uniform zoom z with source_a ≈ centre + z · (source_b − centre).

    Adobe's LCP carries a scale factor and Lensfun's convention fixes the
    image circle instead, so two calibrations of one lens differ by a pure
    zoom that is framing, not optics. It is reported on its own and removed
    before the shape comparison."""
    cx, cy = (a["width"] - 1) / 2, (a["height"] - 1) / 2
    num = den = 0.0
    for pa, pb in zip(a["points"], b["points"]):
        ra = (pa["green"][0] - cx, pa["green"][1] - cy)
        rb = (pb["green"][0] - cx, pb["green"][1] - cy)
        num += ra[0] * rb[0] + ra[1] * rb[1]
        den += rb[0] * rb[0] + rb[1] * rb[1]
    return num / den


def measure(a, b):
    assert a["grid"] == b["grid"] and a["width"] == b["width"], "dumps are not of the same frame"
    out = {}
    z = zoom_between(a, b)
    cx, cy = (a["width"] - 1) / 2, (a["height"] - 1) / 2
    out["zoom"] = {"ratio_minus_one": abs(z - 1.0)}
    d = []
    for pa, pb in zip(a["points"], b["points"]):
        zb = [cx + z * (pb["green"][0] - cx), cy + z * (pb["green"][1] - cy)]
        d.append(dist(pa["green"], zb))
    out["distortion"] = {"mean": sum(d) / len(d), "max": max(d)}
    for ch in ("red", "blue"):
        t = []
        for pa, pb in zip(a["points"], b["points"]):
            ra = [pa[ch][i] - pa["green"][i] for i in range(2)]
            rb = [pb[ch][i] - pb["green"][i] for i in range(2)]
            t.append(dist(ra, rb))
        out[f"tca_{ch}"] = {"mean": sum(t) / len(t), "max": max(t)}
    g = [abs(pa["gain"] / pb["gain"] - 1.0) for pa, pb in zip(a["points"], b["points"])]
    out["vignetting"] = {"mean": sum(g) / len(g), "max": max(g)}
    return out


def main(argv):
    if len(argv) < 4:
        print(__doc__)
        return 2
    a, b = load(argv[1]), load(argv[2])
    measured = measure(a, b)
    for family, m in measured.items():
        print(f"{family:12s} " + "  ".join(f"{k} {v:.4f}" for k, v in m.items()))
    if "--record" in argv:
        ceilings = {f: {k: round(v * 1.1, 4) for k, v in m.items()} for f, m in measured.items()}
        with open(argv[3], "w") as f:
            json.dump({"note": "10 % above the first measured run; ratchet down only", "ceilings": ceilings}, f, indent=2)
        print(f"recorded ceilings to {argv[3]}")
        return 0
    ceilings = load(argv[3])["ceilings"]
    failed = [
        f"{family}.{k}: {m[k]:.4f} > {ceilings[family][k]:.4f}"
        for family, m in measured.items()
        for k in m
        if m[k] > ceilings[family][k]
    ]
    for line in failed:
        print("FAIL", line)
    print("lensfun-vs-lcp:", "FAIL" if failed else "PASS")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
