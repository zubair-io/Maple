#!/usr/bin/env python3
"""Offline exploration helper: measures how k affects Auto vs ACR chroma.

Usage: MAPLE_CHROMA_STRENGTH_OVERRIDE=0.5 python3 _chroma_acr_explore.py <bin> <k>
"""
import argparse, json, subprocess, sys, tempfile, os
from pathlib import Path
import numpy as np
from PIL import Image
import colour
Image.MAX_IMAGE_PIXELS = None

ROOT = Path(__file__).parent.parent.parent  # repo root

def mid_C(path, size=None):
    im = Image.open(path).convert("RGB")
    if size and im.size != size:
        im = im.resize(size, Image.LANCZOS)
    a = np.asarray(im, dtype=np.float32) / 255.0
    lab = colour.XYZ_to_Lab(colour.sRGB_to_XYZ(a))
    L = lab[..., 0].ravel(); C = np.hypot(lab[..., 1], lab[..., 2]).ravel()
    m = (L >= 33.3) & (L < 66.6)
    hi = L >= 66.6
    return float(C[m].mean()) if m.any() else 0.0, float(C[hi].mean()) if hi.any() else 0.0

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("bin"); ap.add_argument("k", type=float)
    args = ap.parse_args()

    manifest = json.load(open(ROOT / "test-fixtures/references/manifest.json"))["cases"]
    seen = set(); rows = []
    for c in manifest:
        if not c["name"].endswith("/baseline"): continue
        fx = c["name"].split("/")[0]
        if fx in seen: continue
        seen.add(fx)
        raw = Path(c["raw"]); acr = Path(c["outputs"][0]["png"])
        if not raw.exists() or not acr.exists(): continue
        with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as tmp:
            out = tmp.name
        env = os.environ.copy()
        env["MAPLE_CHROMA_STRENGTH_OVERRIDE"] = str(args.k)
        r = subprocess.run([args.bin, "render", str(raw), "--params",
            str(ROOT / f"test-fixtures/references/{fx}/xmp/baseline.xmp"),
            "--out", out, "--profile", "auto"],
            capture_output=True, env=env)
        if r.returncode != 0:
            os.unlink(out); continue
        acr_sz = Image.open(acr).size
        auto_mid, auto_hi = mid_C(out, acr_sz)
        acr_mid, acr_hi = mid_C(str(acr))
        rows.append({"fx": fx, "acr_mid": acr_mid, "auto_mid": auto_mid,
                     "acr_hi": acr_hi, "auto_hi": auto_hi,
                     "mid_err": abs(auto_mid - acr_mid),
                     "hi_over": auto_hi - acr_hi})
        os.unlink(out)

    if not rows: print("no rows"); return
    agg_mid_err = np.mean([r["mid_err"] for r in rows])
    agg_hi_over = np.mean([r["hi_over"] for r in rows])
    agg_hi_over_max = max(r["hi_over"] for r in rows)
    print(f"k={args.k:.1f}  agg_mid_err={agg_mid_err:.2f}  agg_hi_over={agg_hi_over:+.2f}  hi_over_max={agg_hi_over_max:+.2f}  n={len(rows)}")

if __name__ == "__main__":
    main()
