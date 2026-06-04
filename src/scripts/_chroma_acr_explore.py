#!/usr/bin/env python3
"""Offline exploration helper: measures how k affects Auto vs ACR chroma.

Usage (k sweep):
    python3 _chroma_acr_explore.py <bin> <k>

Usage (taper sweep, Task 5):
    python3 _chroma_acr_explore.py --taper-sweep <bin>

The taper sweep iterates (taper_lo, taper_hi) pairs with k=0.5 fixed and
reports per-window:
  - agg_mid_err : mean |auto_mid_C - acr_mid_C|  (lower = better mid fidelity)
  - agg_hi_over : mean (auto_hi_C - acr_hi_C)    (want ≤ 0 = no highlight overshoot)
  - n_hi_over_positive : fixtures whose hi_over > 0
"""
import argparse, json, subprocess, sys, tempfile, os
from pathlib import Path
import numpy as np
from PIL import Image
import colour
Image.MAX_IMAGE_PIXELS = None

ROOT = Path(__file__).parent.parent.parent  # repo root

def zoneC(path, size=None):
    """Return (mid_C, hi_C) for CIELab chroma in L-zones [33.3,66.6) and [66.6,∞)."""
    im = Image.open(path).convert("RGB")
    if size and im.size != size:
        im = im.resize(size, Image.LANCZOS)
    a = np.asarray(im, dtype=np.float32) / 255.0
    lab = colour.XYZ_to_Lab(colour.sRGB_to_XYZ(a))
    L = lab[..., 0].ravel()
    C = np.hypot(lab[..., 1], lab[..., 2]).ravel()
    mid_m = (L >= 33.3) & (L < 66.6)
    hi_m = L >= 66.6
    return (float(C[mid_m].mean()) if mid_m.any() else 0.0,
            float(C[hi_m].mean()) if hi_m.any() else 0.0)

# kept for backwards compat
mid_C = zoneC


def load_fixtures():
    manifest = json.load(open(ROOT / "test-fixtures/references/manifest.json"))["cases"]
    seen = set()
    fixtures = []
    for c in manifest:
        if not c["name"].endswith("/baseline"):
            continue
        fx = c["name"].split("/")[0]
        if fx in seen:
            continue
        seen.add(fx)
        raw = Path(c["raw"])
        acr = Path(c["outputs"][0]["png"])
        xmp = ROOT / f"test-fixtures/references/{fx}/xmp/baseline.xmp"
        if raw.exists() and acr.exists() and xmp.exists():
            fixtures.append((fx, raw, acr, xmp))
    return fixtures


def render(bin_path, raw, xmp, env):
    """Render raw with xmp into a temp PNG. Returns path or None on failure."""
    with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as tmp:
        out = tmp.name
    r = subprocess.run(
        [str(bin_path), "render", str(raw), "--params", str(xmp), "--out", out, "--profile", "auto"],
        capture_output=True, env=env,
    )
    if r.returncode != 0:
        try:
            os.unlink(out)
        except OSError:
            pass
        return None
    return out


def k_sweep_main(args):
    fixtures = load_fixtures()
    rows = []
    for fx, raw, acr, xmp in fixtures:
        env = os.environ.copy()
        env["MAPLE_CHROMA_STRENGTH_OVERRIDE"] = str(args.k)
        out = render(args.bin, raw, xmp, env)
        if out is None:
            continue
        acr_sz = Image.open(acr).size
        auto_mid, auto_hi = zoneC(out, acr_sz)
        acr_mid, acr_hi = zoneC(str(acr))
        rows.append({
            "fx": fx,
            "acr_mid": acr_mid, "auto_mid": auto_mid,
            "acr_hi": acr_hi, "auto_hi": auto_hi,
            "mid_err": abs(auto_mid - acr_mid),
            "hi_over": auto_hi - acr_hi,
        })
        try:
            os.unlink(out)
        except OSError:
            pass

    if not rows:
        print("no rows")
        return
    agg_mid_err = np.mean([r["mid_err"] for r in rows])
    agg_hi_over = np.mean([r["hi_over"] for r in rows])
    agg_hi_over_max = max(r["hi_over"] for r in rows)
    print(f"k={args.k:.1f}  agg_mid_err={agg_mid_err:.2f}  agg_hi_over={agg_hi_over:+.2f}"
          f"  hi_over_max={agg_hi_over_max:+.2f}  n={len(rows)}")


def taper_sweep_main(args):
    """Sweep (taper_lo, taper_hi) pairs at fixed k=0.5 and report highlight-overshoot metrics."""
    fixtures = load_fixtures()
    if not fixtures:
        print("no fixtures")
        return

    windows = [
        (0.10, 0.30),
        (0.15, 0.35),
        (0.20, 0.40),
        (0.25, 0.45),
        (0.30, 0.55),
        (0.35, 0.70),  # current default
    ]

    print(f"n_fixtures={len(fixtures)}")
    print(f"{'taper_lo':>8} {'taper_hi':>8} {'mid_err':>8} {'hi_over':>8} {'n_hi_pos':>9}")

    results = []
    for lo, hi in windows:
        mid_errs, hi_overs = [], []
        for fx, raw, acr, xmp in fixtures:
            env = os.environ.copy()
            env["MAPLE_CHROMA_STRENGTH_OVERRIDE"] = "0.5"
            env["MAPLE_CHROMA_TAPER_LO"] = str(lo)
            env["MAPLE_CHROMA_TAPER_HI"] = str(hi)
            out = render(args.bin, raw, xmp, env)
            if out is None:
                continue
            sz = Image.open(acr).size
            auto_mid, auto_hi = zoneC(out, sz)
            acr_mid, acr_hi = zoneC(str(acr))
            mid_errs.append(abs(auto_mid - acr_mid))
            hi_overs.append(auto_hi - acr_hi)
            try:
                os.unlink(out)
            except OSError:
                pass

        if not mid_errs:
            print(f"{lo:8.2f} {hi:8.2f}  no data")
            continue

        agg_mid_err = float(np.mean(mid_errs))
        agg_hi_over = float(np.mean(hi_overs))
        n_hi_pos = sum(1 for x in hi_overs if x > 0)
        print(f"{lo:8.2f} {hi:8.2f} {agg_mid_err:8.2f} {agg_hi_over:+8.2f} {n_hi_pos:9d}", flush=True)
        results.append((lo, hi, agg_mid_err, agg_hi_over, n_hi_pos))

    # Recommend the best window per the Task 5 criteria:
    #   1. agg_hi_over <= 0 (highest priority)
    #   2. Among those, lowest agg_mid_err
    #   3. Tie-break: larger window (hi - lo)
    under = [(lo, hi, me, ho, np_) for lo, hi, me, ho, np_ in results if ho <= 0]
    if under:
        best = min(under, key=lambda r: (r[2], -(r[1] - r[0])))
        print(f"\nRECOMMENDED: taper_lo={best[0]:.2f} taper_hi={best[1]:.2f}"
              f"  (agg_hi_over={best[3]:+.2f}, agg_mid_err={best[2]:.2f})")
    else:
        best = min(results, key=lambda r: r[3])  # least hi_over even if positive
        print(f"\nNO WINDOW achieved agg_hi_over<=0. Best (least overshoot):"
              f" taper_lo={best[0]:.2f} taper_hi={best[1]:.2f}"
              f"  (agg_hi_over={best[3]:+.2f})")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--taper-sweep", action="store_true",
                    help="Sweep (taper_lo, taper_hi) pairs at k=0.5 (Task 5)")
    ap.add_argument("bin")
    ap.add_argument("k", type=float, nargs="?", default=0.5)
    args = ap.parse_args()

    if args.taper_sweep:
        taper_sweep_main(args)
    else:
        k_sweep_main(args)


if __name__ == "__main__":
    main()
