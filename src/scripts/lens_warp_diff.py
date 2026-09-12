#!/usr/bin/env python3
"""Compare two `maple-cli render --lens-warp-out` dumps of the same RAW and
gate the difference against recorded ceilings (#3566).

    lens_warp_diff.py <a.json> <b.json> <ceilings.json> [--record]

Per family the script reports, in pixels of the full active area:
  distortion  — |green_a − green_b| per grid point (mean, max)
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


def measure(a, b):
    assert a["grid"] == b["grid"] and a["width"] == b["width"], "dumps are not of the same frame"
    out = {}
    d = [dist(pa["green"], pb["green"]) for pa, pb in zip(a["points"], b["points"])]
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
        print(f"{family:12s} mean {m['mean']:.4f}  max {m['max']:.4f}")
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
