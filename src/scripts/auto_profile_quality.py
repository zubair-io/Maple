#!/usr/bin/env python3
"""Non-cancelling, full-frame Auto/JPEG checks alongside the legacy bias gate.

The fixed color/detail policy is shared by every fixture. Geometry-only affine
correspondence is allowed by the session's explicit lens-correction policy.
Candidate colors are never fitted or resampled; unsupported scene coordinates
are reported and subject to fixed overlap gates. Unaligned scores are retained.
"""

import hashlib
from itertools import pairwise
from pathlib import Path

import auto_profile_alignment as alignment
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


def evaluate(cand, ref, valid=None):
    if cand.shape != ref.shape or min(ref.shape[:2]) < 16:
        raise ValueError("no measurable aligned RGB image")
    if not (np.isfinite(cand).all() and np.isfinite(ref).all()):
        raise ValueError("nonfinite display pixels")
    if cand.min() < 0 or ref.min() < 0 or cand.max() > 1 or ref.max() > 1:
        raise ValueError("display pixels outside [0,1]")
    if valid is None:
        valid = np.ones(ref.shape[:2], dtype=bool)
    if valid.shape != ref.shape[:2] or not valid.any():
        raise ValueError("no measurable comparison support")
    absolute = np.abs(cand - ref)
    lab_c = colour.XYZ_to_Lab(colour.sRGB_to_XYZ(cand))
    lab_r = colour.XYZ_to_Lab(colour.sRGB_to_XYZ(ref))
    delta = colour.delta_E(lab_c, lab_r, method="CIE 2000")
    tiles = []
    for y, rows in enumerate(
        np.array_split(np.arange(ref.shape[0]), POLICY["tile_grid"])
    ):
        for x, columns in enumerate(
            np.array_split(np.arange(ref.shape[1]), POLICY["tile_grid"])
        ):
            tile_valid = valid[np.ix_(rows, columns)]
            if not tile_valid.any():
                raise ValueError("empty comparison tile")
            tile = absolute[np.ix_(rows, columns)][tile_valid]
            tiles.append({"row": y, "column": x, "mae_rgb": tile.mean(axis=0).tolist()})
    newly_clipped = (
        ((cand <= 1 / 255) & (ref > 0.05)) | ((cand >= 254 / 255) & (ref < 0.95))
    )[valid].mean(axis=0)
    gradient_errors = []
    for axis in (0, 1):
        adjacent = (
            (valid[:-1] & valid[1:]) if axis == 0 else (valid[:, :-1] & valid[:, 1:])
        )
        if not adjacent.any():
            raise ValueError("no adjacent comparison support")
        gradient_errors.append(
            np.abs(np.diff(cand, axis=axis) - np.diff(ref, axis=axis))[adjacent].mean(
                axis=0
            )
        )
    gradients = np.maximum(*gradient_errors)
    values = {
        "mean_absolute_channel_error": absolute[valid].mean(axis=0).tolist(),
        "p95_absolute_channel_error": np.quantile(
            absolute[valid], 0.95, axis=0
        ).tolist(),
        "mean_delta_e_2000": float(delta[valid].mean()),
        "p95_delta_e_2000": float(np.quantile(delta[valid], 0.95)),
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


def native_absolute(cand, ref, budget, valid=None):
    if (
        cand.shape != ref.shape
        or not np.isfinite(cand).all()
        or not np.isfinite(ref).all()
    ):
        raise ValueError("invalid native comparison pixels")
    if valid is None:
        valid = np.ones(ref.shape[:2], dtype=bool)
    if valid.shape != ref.shape[:2] or not valid.any():
        raise ValueError("no native comparison support")
    sums = np.zeros(3, dtype=np.float64)
    band_sums = np.zeros((5, 3), dtype=np.float64)
    counts = np.zeros(5, dtype=np.int64)
    for start in range(0, ref.shape[0], 64):
        target = ref[start : start + 64]
        error = np.abs(cand[start : start + 64] - target)
        support = valid[start : start + 64]
        sums += error[support].sum(axis=0, dtype=np.float64)
        luma = target @ np.array([0.2126, 0.7152, 0.0722])
        edges = [0, 0.10, 0.25, 0.50, 0.75, 1.000001]
        for i, (lo, hi) in enumerate(pairwise(edges)):
            mask = (luma >= lo) & (luma < hi) & support
            counts[i] += mask.sum()
            band_sums[i] += error[mask].sum(axis=0, dtype=np.float64)
    means = {"full-frame": (sums / valid.sum()).tolist()}
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


def compare_unaligned(candidate, reference):
    cand, ref = load_display_pair(candidate, reference)
    return {
        "size": [ref.shape[1], ref.shape[0]],
        "policy": POLICY,
        "implementation_sha256": hashlib.sha256(
            Path(__file__).read_bytes()
        ).hexdigest(),
        **evaluate(cand, ref),
    }


def compare(candidate, reference):
    cand, ref = load_display_pair(candidate, reference)
    aligned, valid, geometry = alignment.align(cand, ref)
    measured = evaluate(cand, aligned, valid)
    measured["breaches"].extend(geometry["breaches"])
    measured["status"] = "failed" if measured["breaches"] else "passed"
    return {
        "size": [ref.shape[1], ref.shape[0]],
        "policy": POLICY,
        "implementation_sha256": hashlib.sha256(
            Path(__file__).read_bytes()
        ).hexdigest(),
        "alignment": geometry,
        "unaligned": evaluate(cand, ref),
        **measured,
    }
