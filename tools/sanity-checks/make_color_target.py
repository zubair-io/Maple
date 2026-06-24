#!/usr/bin/env python3
"""Generate a known-color sRGB test target + a sidecar JSON of patch metadata.

Purpose: a controlled input for diagnosing the reported color shift. The image
is a grid of solid patches with documented 8-bit sRGB values, tagged with an
sRGB ICC profile so any consumer interprets the bytes unambiguously. The sidecar
records each patch's name, sRGB value, and PROPORTIONAL center (fraction of
width/height) so a downstream sampler can locate patch centers in a rescaled
screenshot without depending on absolute pixel size.

Patch set is chosen to separate two hypotheses for the shift:
  * neutrals            -> any global tint / channel bias
  * saturated primaries -> a wide-gamut (display-P3) canvas mismatch hits these
                           hard while leaving grays ~neutral
  * real-world tones     -> AgX / Auto-Profile view-transform tone effects

Usage:
    make_color_target.py <out.png> <out.json>
"""

import json
import sys

import numpy as np
from PIL import Image, ImageCms

# (name, (r, g, b)) in 8-bit sRGB.
PATCHES = [
    # --- neutrals: a perceptual ramp + the two photographic grays ---
    ("K_black", (0, 0, 0)),
    ("N20", (51, 51, 51)),
    ("N40", (102, 102, 102)),
    ("N60", (153, 153, 153)),
    ("N80", (204, 204, 204)),
    ("W_white", (255, 255, 255)),
    # --- pure primaries / secondaries: stress the gamut boundary ---
    ("red", (255, 0, 0)),
    ("green", (0, 255, 0)),
    ("blue", (0, 0, 255)),
    ("cyan", (0, 255, 255)),
    ("magenta", (255, 0, 255)),
    ("yellow", (255, 255, 0)),
    # --- mid-saturation chromatics ---
    ("dk_red", (150, 40, 40)),
    ("dk_green", (40, 120, 50)),
    ("dk_blue", (40, 60, 150)),
    ("orange", (240, 140, 0)),
    ("purple", (120, 60, 160)),
    ("teal", (0, 140, 140)),
    # --- memory / real-world reference tones ---
    ("skin_light", (238, 195, 170)),
    ("skin_dark", (170, 110, 90)),
    ("sky_blue", (120, 170, 220)),
    ("foliage", (80, 130, 60)),
    ("gray18", (118, 118, 118)),  # ~18% reflectance encoded
    ("gray50", (128, 128, 128)),
]

COLS, ROWS = 6, 4
PW = PH = 240  # patch size in source pixels


def build(out_png: str, out_json: str) -> None:
    # Explicit raise (not `assert`): `python -O` strips asserts, which would let a
    # patch/grid mismatch silently generate an incorrect target.
    if len(PATCHES) != COLS * ROWS:
        raise ValueError(f"need {COLS * ROWS} patches, have {len(PATCHES)}")
    w, h = COLS * PW, ROWS * PH
    arr = np.zeros((h, w, 3), dtype=np.uint8)
    meta = []
    for idx, (name, rgb) in enumerate(PATCHES):
        c, r = idx % COLS, idx // COLS
        x0, y0 = c * PW, r * PH
        arr[y0 : y0 + PH, x0 : x0 + PW] = rgb
        cx, cy = x0 + PW / 2.0, y0 + PH / 2.0
        meta.append(
            {
                "name": name,
                "srgb": list(rgb),
                "center_px": [int(cx), int(cy)],
                "center_frac": [round(cx / w, 6), round(cy / h, 6)],
            }
        )

    img = Image.fromarray(arr, mode="RGB")
    srgb_icc = ImageCms.ImageCmsProfile(ImageCms.createProfile("sRGB")).tobytes()
    img.save(out_png, format="PNG", icc_profile=srgb_icc)

    with open(out_json, "w") as f:
        json.dump(
            {
                "width": w,
                "height": h,
                "cols": COLS,
                "rows": ROWS,
                "color_space": "sRGB (IEC 61966-2-1), ICC embedded",
                "patches": meta,
            },
            f,
            indent=2,
        )
    print(f"wrote {out_png} ({w}x{h}, {len(PATCHES)} patches) + {out_json}")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print(__doc__)
        sys.exit(2)
    build(sys.argv[1], sys.argv[2])
