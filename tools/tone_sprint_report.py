#!/usr/bin/env python3
"""Compare real production tone renders with ACR; never synthesize Maple from ACR."""

import argparse
import json
from pathlib import Path

import numpy as np
from PIL import Image


def lstar(path, size=None):
    im = Image.open(path).convert("RGB")
    if size is not None:
        im = im.resize(size, Image.Resampling.LANCZOS)
    a = np.asarray(im, dtype=np.float64) / 255
    rgb = np.where(a <= 0.04045, a / 12.92, ((a + 0.055) / 1.055) ** 2.4)
    y = 0.2126 * rgb[..., 0] + 0.7152 * rgb[..., 1] + 0.0722 * rgb[..., 2]
    return np.where(y > 0.008856, 116 * np.cbrt(y) - 16, 903.3 * y)


def curve(base, edited):
    return np.array(
        [
            np.mean((edited - base)[mask]) if mask.sum() >= 200 else np.nan
            for lo in range(0, 100, 5)
            for mask in [(base >= lo) & (base < lo + 5)]
        ]
    )


def report(directory, refs):
    rows = []
    fixtures = sorted(
        p.name
        for p in refs.glob("test_*")
        if all(
            (p / "down" / f"{case}.png").is_file()
            for case in ["baseline", "whites_max", "whites_min"]
        )
    )
    if not fixtures:
        raise ValueError("No complete ACR Whites reference fixtures found")
    for fx in fixtures:
        if not (directory / f"{fx}_scene_ae_on.json").exists():
            raise ValueError(f"{fx}: production render is incomplete")
        ref = refs / fx / "down"
        for profile in ["auto", "neutral"]:
            base = lstar(directory / f"{fx}_{profile}_baseline.png")
            size = (base.shape[1], base.shape[0])
            # Same spatial samples for both effects: ACR defines the bands,
            # but Maple's own baseline defines Maple's edit delta.
            ar = lstar(ref / "baseline.png", size)
            for case in ["whites_max", "whites_min"]:
                edited = lstar(directory / f"{fx}_{profile}_{case}.png")
                target = lstar(ref / f"{case}.png", size)
                expected = curve(ar, target)
                actual = curve(ar, ar + edited - base)
                error = float(np.nanmean(np.abs(actual - expected)))
                rows.append(
                    {
                        "fixture": fx,
                        "profile": profile,
                        "case": case,
                        "band_mae": error,
                        "maple_delta": actual.tolist(),
                        "acr_delta": expected.tolist(),
                    }
                )
            for case in ["exposure_p1", "exposure_m1"]:
                edited = lstar(directory / f"{fx}_{profile}_{case}.png")
                mask = (base >= 60) & (base < 80)
                rows.append(
                    {
                        "fixture": fx,
                        "profile": profile,
                        "case": case,
                        "delta": float(np.mean((edited - base)[mask]))
                        if mask.sum() >= 200
                        else None,
                        "count": int(mask.sum()),
                    }
                )
    return rows


def clean_json(value):
    """Empty luminance bands are absent measurements, not JSON NaN values."""
    if isinstance(value, dict):
        return {key: clean_json(item) for key, item in value.items()}
    if isinstance(value, list):
        return [clean_json(item) for item in value]
    if isinstance(value, float) and not np.isfinite(value):
        return None
    return value


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=Path)
    parser.add_argument(
        "--references", type=Path, default=Path("test-fixtures/references")
    )
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    rows = report(args.directory, args.references)
    args.output.write_text(json.dumps(clean_json(rows), indent=2, allow_nan=False))
    for profile in ["auto", "neutral"]:
        for case in ["whites_max", "whites_min"]:
            subset = [r for r in rows if r["profile"] == profile and r["case"] == case]
            if subset:
                print(
                    profile,
                    case,
                    "fixtures",
                    len(subset),
                    "band MAE",
                    round(np.mean([r["band_mae"] for r in subset]), 3),
                )
    for fx in sorted({r["fixture"] for r in rows}):
        effects = {
            (r["profile"], r["case"]): r.get("delta")
            for r in rows
            if r["fixture"] == fx
        }
        print(
            fx,
            [
                (case, effects[("neutral", case)], effects[("auto", case)])
                for case in ["exposure_p1", "exposure_m1"]
            ],
        )


if __name__ == "__main__":
    main()
