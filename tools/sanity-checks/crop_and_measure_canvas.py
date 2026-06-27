#!/usr/bin/env python3
"""Locate the rendered color-target grid inside a full-screen Maple screenshot,
crop to it, color-manage to sRGB, and measure per-patch CIEDE2000 vs the known
sRGB values.

The Maple canvas sits between the sidebars; within it the image is letterboxed
on a ~uniform dark canvas background. Every row and column of the 6x4 target
contains at least one bright patch, so the image bounding box is found by
thresholding luminance inside the canvas region. Sampling then uses the
sidecar's proportional patch centers, so letterbox / scale doesn't matter.

Usage: crop_and_measure_canvas.py <full_screenshot.png> <color_target.json> <label>
"""

import json
import subprocess
import sys

import numpy as np
from PIL import Image

# canvas region as fraction of the full screen (between the sidebars), generous.
CANVAS_FRAC = (0.18, 0.06, 0.75, 0.63)  # x0,y0,x1,y1
BRIGHT = 150  # luminance threshold marking "image content" vs dark canvas bg


def find_grid_bbox(full: Image.Image):
    W, H = full.size
    cx0, cy0 = int(CANVAS_FRAC[0] * W), int(CANVAS_FRAC[1] * H)
    cx1, cy1 = int(CANVAS_FRAC[2] * W), int(CANVAS_FRAC[3] * H)
    region = np.asarray(full.crop((cx0, cy0, cx1, cy1)).convert("RGB"))
    lum = region.max(axis=2)  # max-channel: bright if any channel bright
    cols = np.where((lum > BRIGHT).any(axis=0))[0]
    rows = np.where((lum > BRIGHT).any(axis=1))[0]
    if len(cols) == 0 or len(rows) == 0:
        return None
    x0, x1 = cols[0], cols[-1]
    y0, y1 = rows[0], rows[-1]
    return (cx0 + x0, cy0 + y0, cx0 + x1 + 1, cy0 + y1 + 1)


def main() -> int:
    shot, meta_path, label = sys.argv[1], sys.argv[2], sys.argv[3]
    full = Image.open(shot)
    bbox = find_grid_bbox(full.convert("RGB"))
    if bbox is None:
        print(json.dumps({"error": "grid not found (canvas dark/empty)", "label": label}))
        return 1
    print(f"[{label}] grid bbox in screenshot px: {bbox}  size={(bbox[2]-bbox[0], bbox[3]-bbox[1])}", file=sys.stderr)

    # Crop from the ORIGINAL (profile-bearing) image so ICC survives.
    crop = full.crop(bbox)
    crop_path = f"/tmp/maple_crop_{label}.png"
    crop.save(crop_path)  # PNG keeps the embedded ICC from the screenshot

    # Delegate to the validated measurement tool (color-manages via ICC).
    here = sys.path[0] or "."
    out = subprocess.run(
        ["python3", f"{here}/measure_color_target.py", crop_path, meta_path],
        capture_output=True, text=True,
    )
    sys.stderr.write(out.stderr)
    print(out.stdout.strip())
    return out.returncode


if __name__ == "__main__":
    sys.exit(main())
