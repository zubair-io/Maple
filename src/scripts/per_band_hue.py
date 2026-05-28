#!/usr/bin/env python3
"""per_band_hue.py — per-luma-band a*/b* and bias breakdown.

Splits the image into 5 tonal regions (blacks, shadows, midtones,
highlights, whites — labeled, not just numbers) and reports for each:
  - n pixels
  - per-channel bias R/G/B (Maple − JPEG)
  - mean a* shift (Maple − JPEG): +red, −green
  - mean b* shift: +yellow, −blue
  - hue direction call (magenta / cyan / yellow / green / blue / red / neutral)
  - mean ΔE2000 in that band

No global averages — only per-band so localized casts surface.

Usage:
    per_band_hue.py <candidate.png> <reference.png>
"""

import sys
import numpy as np
from PIL import Image
import colour


BANDS = [
    ("blacks",    0.00, 0.08),
    ("shadows",   0.08, 0.25),
    ("midtones",  0.25, 0.55),
    ("highlights", 0.55, 0.85),
    ("whites",    0.85, 1.001),
]


def hue_call(da, db, mag_threshold=0.5):
    """Translate (a*, b*) shift into a perceptual direction label."""
    import math
    mag = math.sqrt(da * da + db * db)
    if mag < mag_threshold:
        return "neutral"
    # Quadrants (Lab convention: +a=red/magenta, −a=green; +b=yellow, −b=blue)
    if da > 0 and db < 0:
        return "MAGENTA"
    if da < 0 and db > 0:
        return "yellow-green"
    if da > 0 and db > 0:
        return "red/orange"
    if da < 0 and db < 0:
        return "cyan/blue-green"
    if abs(da) >= abs(db):
        return "RED" if da > 0 else "green"
    return "yellow" if db > 0 else "blue"


def main():
    if len(sys.argv) != 3:
        print(__doc__)
        sys.exit(2)
    c_img = Image.open(sys.argv[1]).convert("RGB")
    r_img = Image.open(sys.argv[2]).convert("RGB")
    if c_img.size != r_img.size:
        c_img = c_img.resize(r_img.size, Image.LANCZOS)
    cand = np.asarray(c_img, dtype=np.float32) / 255.0
    ref = np.asarray(r_img, dtype=np.float32) / 255.0

    cand_lab = colour.XYZ_to_Lab(colour.sRGB_to_XYZ(cand)).reshape(-1, 3)
    ref_lab = colour.XYZ_to_Lab(colour.sRGB_to_XYZ(ref)).reshape(-1, 3)
    dE = colour.delta_E(cand_lab, ref_lab, method="CIE 2000")

    # Bin by REFERENCE luma (Rec.709 on the JPEG bytes).
    ref_y = (
        0.2126 * ref[..., 0] + 0.7152 * ref[..., 1] + 0.0722 * ref[..., 2]
    ).ravel()
    flat_cand = cand.reshape(-1, 3)
    flat_ref = ref.reshape(-1, 3)

    print(f"{'band':<11} {'lum range':<13} {'n':>8}  "
          f"{'biasR':>7} {'biasG':>7} {'biasB':>7}  "
          f"{'a*shift':>8} {'b*shift':>8}  {'hue':<18} {'dE':>5}")
    print("-" * 105)

    for name, lo, hi in BANDS:
        m = (ref_y >= lo) & (ref_y < hi)
        n = int(m.sum())
        if n < 100:
            print(f"{name:<11} [{lo:.2f}-{hi:.2f}]   n={n:>5}  (skipped, too few pixels)")
            continue
        bias = (flat_cand[m] - flat_ref[m]).mean(axis=0)
        # a*/b* in Lab. Mean shift = Maple − JPEG.
        a_shift = float(cand_lab[m, 1].mean() - ref_lab[m, 1].mean())
        b_shift = float(cand_lab[m, 2].mean() - ref_lab[m, 2].mean())
        band_de = float(dE[m].mean())
        hue = hue_call(a_shift, b_shift)
        print(f"{name:<11} [{lo:.2f}-{hi:.2f}]   n={n:>5}  "
              f"{bias[0]:+7.3f} {bias[1]:+7.3f} {bias[2]:+7.3f}  "
              f"{a_shift:+8.2f} {b_shift:+8.2f}  {hue:<18} {band_de:>5.2f}")


if __name__ == "__main__":
    main()
