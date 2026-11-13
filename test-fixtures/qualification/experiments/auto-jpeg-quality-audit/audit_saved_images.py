"""Audit every saved JPEG comparison without allowing signed errors to cancel.

Diagnostic measurements only: no invented acceptance threshold and no image
quality PASS. Original PNGs remain untouched. Spatial metrics are measured at
an explicitly bounded display resolution and do not qualify native detail.
"""

import argparse
import hashlib
import json
from pathlib import Path

import numpy as np
from PIL import Image


def sha(path):
    with path.open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def display_image(path, size):
    with Image.open(path) as source:
        image = source.convert("RGB")
        width, height = image.size
        ratio = size[0] / size[1]
        if abs(width / height - ratio) > 0.001:
            if width / height > ratio:
                cropped = round(height * ratio)
                left = (width - cropped) // 2
                image = image.crop((left, 0, left + cropped, height))
            else:
                cropped = round(width / ratio)
                top = (height - cropped) // 2
                image = image.crop((0, top, width, top + cropped))
        return (
            np.asarray(image.resize(size, Image.Resampling.BOX), dtype=np.float32) / 255
        )


def metrics(candidate, reference):
    difference = candidate - reference
    absolute = np.abs(difference)
    tiles = [
        float(np.abs(tile).mean())
        for row in np.array_split(difference, 8, axis=0)
        for tile in np.array_split(row, 8, axis=1)
    ]
    return {
        "mean_absolute_rgb_error": float(absolute.mean()),
        "p95_absolute_channel_error": float(np.quantile(absolute, 0.95)),
        "worst_8x8_tile_mean_absolute_error": max(tiles),
        "per_channel_absolute_error": absolute.mean(axis=(0, 1)).tolist(),
        "per_channel_signed_error": difference.mean(axis=(0, 1)).tolist(),
        "black_channel_fraction": float((candidate <= 1 / 255).mean()),
        "white_channel_fraction": float((candidate >= 254 / 255).mean()),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("evidence", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    baseline = args.evidence / "auto-embedded-jpeg-source37"
    rejected = args.evidence / "auto-jpeg-nodefit-restart-pilot"
    cases = json.loads((baseline / "summary.json").read_text())["cases"]
    rows = []
    for case in cases:
        name = case["fixture"]
        if case["status"] == "no-preview":
            rows.append(
                {"fixture": name, "status": "no-preview", "visual_match": "not-tested"}
            )
            continue
        current = rejected / ("leica" if name == "test_0017" else "final-rest") / name
        reference = baseline / name / "embedded.png"
        assert sha(reference) == sha(current / "embedded.png")
        with Image.open(reference) as image:
            width, height = image.size
        scale = min(1, 1024 / max(width, height))
        size = (max(8, round(width * scale)), max(8, round(height * scale)))
        ref = display_image(reference, size)
        prior = metrics(display_image(baseline / name / "auto.png", size), ref)
        new = metrics(display_image(current / "auto.png", size), ref)
        rows.append(
            {
                "fixture": name,
                "baseline_bias_status": case["status"],
                "measurement_size": size,
                "before": prior,
                "rejected_calibration": new,
                "mean_absolute_error_increased": new["mean_absolute_rgb_error"]
                > prior["mean_absolute_rgb_error"],
            }
        )
        print(
            name,
            "MAE before",
            prior["mean_absolute_rgb_error"],
            "rejected",
            new["mean_absolute_rgb_error"],
            flush=True,
        )
    args.output.write_text(
        json.dumps(
            {
                "status": "diagnostic-only-not-image-quality-qualification",
                "geometry": "Display-oriented source PNGs; aspect-center crop to JPEG, BOX resize to at most 1024px; whole frame including borders.",
                "thresholds": "None chosen. Metrics complement visual review; registration and lens geometry differences remain possible.",
                "selected": len(rows),
                "compared": sum("before" in row for row in rows),
                "no_preview": sum(row.get("status") == "no-preview" for row in rows),
                "mean_absolute_error_increased": sum(
                    row.get("mean_absolute_error_increased", False) for row in rows
                ),
                "cases": rows,
            },
            indent=2,
        )
        + "\n"
    )


if __name__ == "__main__":
    main()
