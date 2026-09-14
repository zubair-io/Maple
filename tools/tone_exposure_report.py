#!/usr/bin/env python3
"""Isolate Auto's fitted tail from its different auto-exposure policy (#3631)."""

import argparse
import json

import numpy as np
from tone_sprint_report import clean_json, lstar


def main():
    from pathlib import Path

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("production", type=Path, help="Complete tone_sprint output")
    parser.add_argument("isolation", type=Path, help="tone_exposure_isolation output")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    baselines = sorted(args.production.glob("test_*_auto_baseline.png"))
    if not baselines:
        raise ValueError("No production baselines found")
    rows = []
    for path in baselines:
        fixture = path.name[:9]
        auto = lstar(path)
        mask = (auto >= 60) & (auto < 80)
        result = {"fixture": fixture, "pixels": int(mask.sum())}
        for profile, directory in [
            ("auto", args.production),
            ("neutral", args.production),
            ("neutral_off", args.isolation),
        ]:
            baseline = lstar(directory / f"{fixture}_{profile}_baseline.png")
            result[profile] = {}
            for case in ["exposure_p1", "exposure_m1"]:
                edited = lstar(directory / f"{fixture}_{profile}_{case}.png")
                result[profile][case] = (
                    float(np.mean((edited - baseline)[mask]))
                    if mask.sum() >= 200
                    else None
                )
        rows.append(result)
    args.output.write_text(json.dumps(clean_json(rows), indent=2, allow_nan=False))
    for profile in ["auto", "neutral", "neutral_off"]:
        means = [
            np.mean(
                [row[profile][case] for row in rows if row[profile][case] is not None]
            )
            for case in ["exposure_p1", "exposure_m1"]
        ]
        print(profile, "+1 / -1 EV:", [round(float(x), 3) for x in means])


if __name__ == "__main__":
    main()
