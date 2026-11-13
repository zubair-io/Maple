"""Held-out diagnostic of RGB-only versus local-context predictions, not a gate."""

import argparse
import json
import sys
from pathlib import Path

import numpy as np
import OpenEXR
from PIL import Image
from scipy.ndimage import gaussian_filter
from scipy.spatial import cKDTree


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("evidence", type=Path)
    parser.add_argument("scripts", type=Path)
    args = parser.parse_args()
    sys.path.insert(0, str(args.scripts))
    import auto_profile_alignment as alignment
    import auto_profile_quality as quality

    base = args.evidence.parent
    physical = base / "auto-jpeg-combined-gate"
    row = next(
        r
        for r in json.loads((physical / "summary.json").read_text())["cases"]
        if r["fixture"] == "test_0015"
    )
    actual, reference = quality.load_display_pair(
        physical / "test_0015/auto.png", physical / "test_0015/embedded.png"
    )
    reference, valid = alignment.resample_report(reference, row["quality"]["alignment"])
    linear = (
        OpenEXR.File(str(args.evidence / "prefix-stages/17_srgb_linear.exr"))
        .channels()["RGB"]
        .pixels
    )
    linear = np.clip(linear, 0, 1)
    encoded = np.where(
        linear <= 0.0031308,
        linear * 12.92,
        1.055 * np.maximum(linear, 0) ** (1 / 2.4) - 0.055,
    )
    h, w = reference.shape[:2]
    sh, sw = encoded.shape[:2]
    if abs(sw / sh - w / h) > 0.001:
        if sw / sh > w / h:
            width = round(sh * w / h)
            left = (sw - width) // 2
            encoded = encoded[:, left : left + width]
        else:
            height = round(sw * h / w)
            top = (sh - height) // 2
            encoded = encoded[top : top + height]

    def reduce(values):
        return np.stack(
            [
                np.asarray(
                    Image.fromarray(values[..., c]).resize((w, h), Image.Resampling.BOX)
                )
                for c in range(3)
            ],
            axis=-1,
        ).astype(float)

    source = reduce(encoded)
    variance = np.maximum(reduce(encoded * encoded) - source * source, 0)
    luma = source @ [0.2126, 0.7152, 0.0722]
    context = np.stack([gaussian_filter(luma, sigma) for sigma in (3, 12, 32)], axis=-1)
    yy, xx = np.mgrid[:h, :w]
    fold = (xx // 64 + yy // 64) % 2
    results = []
    for name, features in [
        ("rgb", source),
        (
            "rgb_and_footprint_variance",
            np.concatenate([source, np.sqrt(variance)], axis=-1),
        ),
        ("rgb_and_local_luma", np.concatenate([source, context], axis=-1)),
    ]:
        predicted = np.empty_like(reference)
        for held_out in [0, 1]:
            train = valid & (fold != held_out) & ((xx + yy) % 2 == 0)
            test = valid & (fold == held_out)
            tree = cKDTree(features[train])
            distance, neighbors = tree.query(features[test], k=32, workers=4)
            weights = 1 / np.maximum(distance, 1e-5)
            predicted[test] = (reference[train][neighbors] * weights[..., None]).sum(
                axis=1
            ) / weights.sum(axis=1)[:, None]
        predicted[~valid] = actual[~valid]
        measured = quality.evaluate(predicted, reference, valid)
        measured.pop("tiles", None)
        results.append({"features": name, **measured})
        Image.fromarray(np.uint8(np.clip(predicted, 0, 1) * 255)).save(
            args.evidence / f"held-out-{name}.png"
        )
        print(name, measured["metrics"]["mean_absolute_channel_error"], flush=True)
    (args.evidence / "probe.json").write_text(
        json.dumps(
            {
                "diagnostic_only": True,
                "scope": "test_0015; float pre-Auto data, corrected reference coordinates, disjoint 64px blocks",
                "limitations": "Prediction occurs after BOX reduction; variance feature probes that ambiguity. This is not a production transform, cross-image validation, or gradient-safe solution.",
                "results": results,
            },
            indent=2,
        )
        + "\n"
    )


if __name__ == "__main__":
    main()
