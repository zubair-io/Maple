#!/usr/bin/env python3
"""Non-cancelling, full-frame Auto/JPEG checks alongside the legacy bias gate.

The fixed policy is shared by every fixture. No registration, color fitting,
exposure compensation, border exclusion or reference-dependent threshold is
allowed here. A geometry mismatch is a failure to diagnose, not to normalize
away with a fitted transform. This display-scale gate does not qualify native
resolution detail or replace visual review.
"""

import hashlib
from pathlib import Path

import colour
import numpy as np
from PIL import Image

POLICY = {
    "display_long_edge": 1024,
    "tile_grid": 8,
    "mean_absolute_channel_error": 0.05,
    "tile_mean_absolute_channel_error": 0.05,
    "p95_absolute_channel_error": 0.10,
    "mean_delta_e_2000": 5.0,
    "p95_delta_e_2000": 10.0,
    "newly_clipped_channel_fraction": 0.01,
    "gradient_mean_absolute_channel_error": 0.05,
}


def load_display_pair(candidate, reference):
    with Image.open(reference) as image:
        width, height = image.size
        if min(width, height) < 16:
            raise ValueError("no measurable display image")
        scale = min(1.0, POLICY["display_long_edge"] / max(width, height))
        size = (max(16, round(width * scale)), max(16, round(height * scale)))
        ref = (
            np.asarray(
                image.convert("RGB").resize(size, Image.Resampling.BOX),
                dtype=np.float64,
            )
            / 255
        )
    with Image.open(candidate) as source:
        image = source.convert("RGB")
        sw, sh = image.size
        aspect = width / height
        if abs(sw / sh - aspect) > 0.001:
            if sw / sh > aspect:
                cropped = round(sh * aspect)
                left = (sw - cropped) // 2
                image = image.crop((left, 0, left + cropped, sh))
            else:
                cropped = round(sw / aspect)
                top = (sh - cropped) // 2
                image = image.crop((0, top, sw, top + cropped))
        cand = (
            np.asarray(image.resize(size, Image.Resampling.BOX), dtype=np.float64) / 255
        )
    return cand, ref


def evaluate(cand, ref):
    if cand.shape != ref.shape or min(ref.shape[:2]) < 16:
        raise ValueError("no measurable aligned RGB image")
    if not (np.isfinite(cand).all() and np.isfinite(ref).all()):
        raise ValueError("nonfinite display pixels")
    if cand.min() < 0 or ref.min() < 0 or cand.max() > 1 or ref.max() > 1:
        raise ValueError("display pixels outside [0,1]")
    absolute = np.abs(cand - ref)
    lab_c = colour.XYZ_to_Lab(colour.sRGB_to_XYZ(cand))
    lab_r = colour.XYZ_to_Lab(colour.sRGB_to_XYZ(ref))
    delta = colour.delta_E(lab_c, lab_r, method="CIE 2000")
    tiles = []
    for y, row in enumerate(np.array_split(absolute, POLICY["tile_grid"], axis=0)):
        for x, tile in enumerate(np.array_split(row, POLICY["tile_grid"], axis=1)):
            tiles.append(
                {"row": y, "column": x, "mae_rgb": tile.mean(axis=(0, 1)).tolist()}
            )
    newly_clipped = (
        ((cand <= 1 / 255) & (ref > 0.05)) | ((cand >= 254 / 255) & (ref < 0.95))
    ).mean(axis=(0, 1))
    gradients = np.maximum(
        np.abs(np.diff(cand, axis=0) - np.diff(ref, axis=0)).mean(axis=(0, 1)),
        np.abs(np.diff(cand, axis=1) - np.diff(ref, axis=1)).mean(axis=(0, 1)),
    )
    values = {
        "mean_absolute_channel_error": absolute.mean(axis=(0, 1)).tolist(),
        "p95_absolute_channel_error": np.quantile(absolute, 0.95, axis=(0, 1)).tolist(),
        "mean_delta_e_2000": float(delta.mean()),
        "p95_delta_e_2000": float(np.quantile(delta, 0.95)),
        "newly_clipped_channel_fraction": newly_clipped.tolist(),
        "gradient_mean_absolute_channel_error": gradients.tolist(),
    }
    breaches = []
    for metric, value in values.items():
        for index, actual in enumerate(value if isinstance(value, list) else [value]):
            if actual > POLICY[metric]:
                breaches.append(
                    {
                        "metric": metric,
                        "channel": "RGB"[index] if isinstance(value, list) else None,
                        "value": actual,
                        "limit": POLICY[metric],
                    }
                )
    for tile in tiles:
        for channel, actual in zip("RGB", tile["mae_rgb"]):
            if actual > POLICY["tile_mean_absolute_channel_error"]:
                breaches.append(
                    {
                        "metric": "tile_mean_absolute_channel_error",
                        "channel": channel,
                        "row": tile["row"],
                        "column": tile["column"],
                        "value": actual,
                        "limit": POLICY["tile_mean_absolute_channel_error"],
                    }
                )
    return {
        "metrics": values,
        "tiles": tiles,
        "breaches": breaches,
        "status": "failed" if breaches else "passed",
    }


def native_absolute(cand, ref, budget):
    if (
        cand.shape != ref.shape
        or not np.isfinite(cand).all()
        or not np.isfinite(ref).all()
    ):
        raise ValueError("invalid native comparison pixels")
    sums = np.zeros(3, dtype=np.float64)
    band_sums = np.zeros((5, 3), dtype=np.float64)
    counts = np.zeros(5, dtype=np.int64)
    for start in range(0, ref.shape[0], 64):
        target = ref[start : start + 64]
        error = np.abs(cand[start : start + 64] - target)
        sums += error.sum(axis=(0, 1), dtype=np.float64)
        luma = target @ np.array([0.2126, 0.7152, 0.0722])
        edges = [0, 0.10, 0.25, 0.50, 0.75, 1.000001]
        for i, (lo, hi) in enumerate(zip(edges, edges[1:])):
            mask = (luma >= lo) & (luma < hi)
            counts[i] += mask.sum()
            band_sums[i] += error[mask].sum(axis=0, dtype=np.float64)
    means = {"full-frame": (sums / (ref.shape[0] * ref.shape[1])).tolist()}
    for i, count in enumerate(counts):
        if count >= 100:
            means[f"band-{i}"] = (band_sums[i] / count).tolist()
    breaches = [
        {
            "metric": "native_mean_absolute_channel_error",
            "region": region,
            "channel": channel,
            "value": value,
            "limit": budget,
        }
        for region, values in means.items()
        for channel, value in zip("RGB", values)
        if value > budget
    ]
    return {
        "means": means,
        "breaches": breaches,
        "limit": budget,
        "status": "failed" if breaches else "passed",
    }


def compare(candidate, reference):
    cand, ref = load_display_pair(candidate, reference)
    return {
        "size": [ref.shape[1], ref.shape[0]],
        "policy": POLICY,
        "implementation_sha256": hashlib.sha256(
            Path(__file__).read_bytes()
        ).hexdigest(),
        **evaluate(cand, ref),
    }
