"""#4323: research-only native mask geometry; source files remain read-only."""

import math
import struct
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw
from scipy.ndimage import distance_transform_edt

TRANSPOSE = {
    2: Image.Transpose.FLIP_LEFT_RIGHT,
    3: Image.Transpose.ROTATE_180,
    4: Image.Transpose.FLIP_TOP_BOTTOM,
    5: Image.Transpose.TRANSPOSE,
    6: Image.Transpose.ROTATE_270,
    7: Image.Transpose.TRANSVERSE,
    8: Image.Transpose.ROTATE_90,
}


def orient(image, orientation, inverse=False):
    code = {6: 8, 8: 6}.get(orientation, orientation) if inverse else orientation
    return image.transpose(TRANSPOSE[code]) if code in TRANSPOSE else image.copy()


def masks(strokes, metadata):
    """Rasterize normalized upright strokes, then undo EXIF into DefaultCrop."""
    size = (metadata["displayWidth"], metadata["displayHeight"])
    selection, protection = Image.new("L", size), Image.new("L", size)
    for stroke in strokes:
        mode = stroke["mode"]
        if mode not in ("remove", "erase", "protect"):
            raise ValueError("Unknown brush mode")
        radius = float(stroke["radius"]) * max(size)
        if not math.isfinite(radius) or not 0 < radius <= max(size) / 5:
            raise ValueError("Invalid brush radius")
        points = stroke["points"]
        if not points or any(
            len(p) != 2 or any(not math.isfinite(v) or not 0 <= v <= 1 for v in p)
            for p in points
        ):
            raise ValueError("Invalid brush points")
        xy = [(p[0] * (size[0] - 1), p[1] * (size[1] - 1)) for p in points]
        targets = (
            [(selection, 0), (protection, 0)]
            if mode == "erase"
            else [(protection if mode == "protect" else selection, 255)]
        )
        for target, value in targets:
            draw = ImageDraw.Draw(target)
            if len(xy) > 1:
                draw.line(xy, fill=value, width=max(1, round(radius * 2)))
            for x, y in xy:
                draw.ellipse(
                    (x - radius, y - radius, x + radius, y + radius), fill=value
                )
    selected = np.asarray(orient(selection, metadata["orientation"], True)) > 0
    protected = np.asarray(orient(protection, metadata["orientation"], True)) > 0
    return selected & ~protected, protected


def window(intent):
    ys, xs = np.where(intent)
    if not len(xs):
        raise ValueError(
            "Paint an object to remove first. Protected areas are excluded."
        )
    height, width = intent.shape
    extent = max(int(xs.max() - xs.min() + 1), int(ys.max() - ys.min() + 1))
    # Retain room for +16 model-pixel expansion and clean context. Never crop intent.
    side = next(
        (n for n in (1024, 2048) if n <= min(width, height) and extent + n // 4 <= n),
        None,
    )
    if side is None:
        raise ValueError(
            "Selection is too large for this prototype. Try one smaller object or a tighter selection (maximum context 2048 pixels)."
        )
    x = min(max(0, (int(xs.min()) + int(xs.max()) + 1 - side) // 2), width - side)
    y = min(max(0, (int(ys.min()) + int(ys.max()) + 1 - side) // 2), height - side)
    return x, y, side


def mimf(mask, path, metadata, x, y):
    ys, xs = np.where(mask)
    box = (
        (int(xs.min()), int(ys.min()), int(xs.max() + 1), int(ys.max() + 1))
        if len(xs)
        else (0, 0, 1, 1)
    )
    pixels = mask[box[1] : box[3], box[0] : box[2]]
    Path(path).write_bytes(
        b"MIMF\x01\0\0\0"
        + struct.pack(
            "<6I",
            metadata["width"],
            metadata["height"],
            x + box[0],
            y + box[1],
            pixels.shape[1],
            pixels.shape[0],
        )
        + np.packbits(pixels.ravel(), bitorder="little").tobytes()
    )


def expanded_masks(intent, protected, side):
    distance = distance_transform_edt(~intent)
    expanded = (distance <= 16 * side / 512) & ~protected
    # Same model-space expansion used in the reviewed +16 experiment.
    baseline = Image.fromarray((distance <= 8).astype("uint8") * 255).resize(
        (512, 512), Image.Resampling.NEAREST
    )
    model_hole = distance_transform_edt(~(np.asarray(baseline) > 0)) <= 16
    protected512 = (
        np.asarray(
            Image.fromarray(protected).resize((512, 512), Image.Resampling.NEAREST)
        )
        > 0
    )
    return expanded, model_hole & ~protected512
