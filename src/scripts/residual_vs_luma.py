#!/usr/bin/env python3
"""residual_vs_luma.py — per-band residual structure of Maple Auto
output vs the embedded JPEG, for the goal's "no hidden structure in the
residual" gate.

Bins pixels by REFERENCE luminance into 20 bands [0..1]. For each band:
  - mean bias per channel (Maple − JPEG, sRGB byte space)
  - mean ΔE2000
  - per-channel bias divergence (max(|R-G|,|R-B|,|G-B|))

Print a per-fixture table plus a one-line classification:
  FLAT      — no per-band trend (irreducible noise)
  SHADOWLIFT — positive bias in low bands (curve doesn't crush shadows enough)
  HIGHLIGHTTAIL — bias rises toward white (HDR clamp signature)
  MIDBUMP   — bias positive in midtones only
  CONTRAST_HIGH — shadows crushed + highlights lifted (Maple too contrasty)
  CONTRAST_LOW  — shadows lifted + highlights crushed (Maple too flat)
  CHANNEL_DIV   — strong per-channel bias divergence in some band
  COMPLEX   — multiple signatures present

Usage:
    residual_vs_luma.py <aligned_harness_dir> [<fixture_stem>...]
"""

import json
import os
import sys

import numpy as np
from PIL import Image
import colour


N_BANDS = 20


def load(p):
    return np.asarray(Image.open(p).convert("RGB"), dtype=np.float32) / 255.0


def analyze(cand_path, ref_path):
    c_img = Image.open(cand_path).convert("RGB")
    r_img = Image.open(ref_path).convert("RGB")
    if c_img.size != r_img.size:
        c_img = c_img.resize(r_img.size, Image.LANCZOS)
    cand = np.asarray(c_img, dtype=np.float32) / 255.0
    ref = np.asarray(r_img, dtype=np.float32) / 255.0

    # Rec.709 luma on reference (sRGB-interpreted) for binning.
    ref_y = (0.2126 * ref[..., 0] + 0.7152 * ref[..., 1] + 0.0722 * ref[..., 2]).ravel()
    flat_cand = cand.reshape(-1, 3)
    flat_ref = ref.reshape(-1, 3)

    cand_lab = colour.XYZ_to_Lab(colour.sRGB_to_XYZ(cand)).reshape(-1, 3)
    ref_lab = colour.XYZ_to_Lab(colour.sRGB_to_XYZ(ref)).reshape(-1, 3)
    dE = colour.delta_E(cand_lab, ref_lab, method="CIE 2000")

    bands = []
    edges = np.linspace(0.0, 1.0, N_BANDS + 1)
    for i in range(N_BANDS):
        lo, hi = edges[i], edges[i + 1]
        if i == N_BANDS - 1:
            m = (ref_y >= lo) & (ref_y <= hi)
        else:
            m = (ref_y >= lo) & (ref_y < hi)
        n = int(m.sum())
        if n < 200:
            bands.append({"lo": float(lo), "hi": float(hi), "n": n})
            continue
        bias = (flat_cand[m] - flat_ref[m]).mean(axis=0)
        bands.append({
            "lo": float(lo), "hi": float(hi), "n": n,
            "br": float(bias[0]), "bg": float(bias[1]), "bb": float(bias[2]),
            "dE": float(dE[m].mean()),
            "div": float(max(abs(bias[0]-bias[1]),
                             abs(bias[0]-bias[2]),
                             abs(bias[1]-bias[2]))),
        })
    return bands


def classify(bands):
    """Return a short label describing the residual shape."""
    valid = [b for b in bands if "br" in b]
    if len(valid) < 8:
        return "INSUFFICIENT"
    # Shadow band: first 4 bands (lum < 0.20). Highlight: last 4 (lum > 0.80).
    shadow_bias = np.mean([(b["br"] + b["bg"] + b["bb"]) / 3.0 for b in valid[:4]])
    high_bias = np.mean([(b["br"] + b["bg"] + b["bb"]) / 3.0 for b in valid[-4:]])
    mid_bias = np.mean([(b["br"] + b["bg"] + b["bb"]) / 3.0 for b in valid[7:13]])
    max_div = max(b["div"] for b in valid)

    signs = []
    if shadow_bias > 0.03:
        signs.append("SHADOWLIFT")
    elif shadow_bias < -0.03:
        signs.append("SHADOWCRUSH")
    if high_bias > 0.03:
        signs.append("HIGHLIGHTLIFT")
    elif high_bias < -0.03:
        signs.append("HIGHLIGHTCRUSH")
    if abs(mid_bias) > 0.02 and abs(shadow_bias) < 0.02 and abs(high_bias) < 0.02:
        signs.append("MIDBUMP" if mid_bias > 0 else "MIDDIP")
    if max_div > 0.04:
        signs.append("CHANNEL_DIV")

    # Special composites
    if "SHADOWCRUSH" in signs and "HIGHLIGHTLIFT" in signs:
        return "CONTRAST_HIGH" + ("+CHANNEL_DIV" if "CHANNEL_DIV" in signs else "")
    if "SHADOWLIFT" in signs and "HIGHLIGHTCRUSH" in signs:
        return "CONTRAST_LOW" + ("+CHANNEL_DIV" if "CHANNEL_DIV" in signs else "")
    # Highlight tail rising — bias monotonically increases in last 4 bands.
    highs = [(b["br"] + b["bg"] + b["bb"]) / 3.0 for b in valid[-4:]]
    if all(highs[i + 1] - highs[i] > 0.005 for i in range(3)) and high_bias > 0.02:
        signs.append("HIGHLIGHTTAIL")

    if not signs:
        return "FLAT"
    if len(signs) >= 3:
        return "COMPLEX"
    return "+".join(signs)


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(2)
    root = sys.argv[1]
    filters = set(sys.argv[2:]) if len(sys.argv) > 2 else None

    per_fix = sorted(os.listdir(os.path.join(root, "per_fixture")))
    print(f"{'fixture':<12} {'class':<32} {'dE':>5} {'sh_bias':>10} {'hi_bias':>10} {'max_div':>8}")
    print("-" * 80)
    for stem in per_fix:
        if filters and stem not in filters:
            continue
        fdir = os.path.join(root, "per_fixture", stem)
        cand = os.path.join(fdir, "auto_1024.png")
        ref = os.path.join(fdir, "embedded_1024.png")
        if not (os.path.isfile(cand) and os.path.isfile(ref)):
            continue
        bands = analyze(cand, ref)
        cls = classify(bands)
        valid = [b for b in bands if "br" in b]
        if not valid:
            continue
        sh = np.mean([(b["br"] + b["bg"] + b["bb"]) / 3.0 for b in valid[:4]])
        hi = np.mean([(b["br"] + b["bg"] + b["bb"]) / 3.0 for b in valid[-4:]])
        mean_de = np.mean([b["dE"] for b in valid])
        max_div = max(b["div"] for b in valid)
        print(f"{stem:<12} {cls:<32} {mean_de:>5.2f} {sh:>+10.3f} {hi:>+10.3f} {max_div:>8.3f}")

    # If a single fixture filtered, show its full per-band table.
    if filters and len(filters) == 1:
        stem = next(iter(filters))
        fdir = os.path.join(root, "per_fixture", stem)
        cand = os.path.join(fdir, "auto_1024.png")
        ref = os.path.join(fdir, "embedded_1024.png")
        bands = analyze(cand, ref)
        print()
        print(f"per-band detail for {stem}:")
        print(f"{'band':<14} {'n':>8} {'biasR':>8} {'biasG':>8} {'biasB':>8} {'div':>7} {'dE':>5}")
        for b in bands:
            if "br" not in b:
                print(f"  [{b['lo']:.2f}-{b['hi']:.2f}] n={b['n']:>5} (skipped)")
                continue
            print(f"  [{b['lo']:.2f}-{b['hi']:.2f}] {b['n']:>6}  {b['br']:>+7.3f} {b['bg']:>+7.3f} {b['bb']:>+7.3f} {b['div']:>7.3f} {b['dE']:>5.2f}")


if __name__ == "__main__":
    main()
