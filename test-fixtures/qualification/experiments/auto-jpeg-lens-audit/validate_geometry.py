"""Check radial diagnostic maps at display and embedded-preview resolution."""

import argparse
import json
import sys
from pathlib import Path

import numpy as np
from geometry import geometry_checks, resample


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("checkpoint", type=Path)
    parser.add_argument("scripts", type=Path)
    parser.add_argument("probe", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    sys.path.insert(0, str(args.scripts))
    import auto_profile_diff as diff
    import auto_profile_quality as quality

    original = json.loads((args.checkpoint / "full-suite/summary.json").read_text())
    records = []
    for row in json.loads(args.probe.read_text())["cases"]:
        if "probe" not in row:
            records.append({"fixture": row["fixture"], "geometry": "unchanged affine"})
            continue
        name = row["fixture"]
        prior = next(r for r in original["cases"] if r["fixture"] == name)
        affine = np.array(
            prior["quality"]["alignment"]["candidate_to_reference_normalized"]
        )
        coefficients = np.array(row["geometry"]["coefficients"])
        folder = args.checkpoint / "full-suite" / name
        cand, ref = quality.load_display_pair(
            folder / "auto.png", folder / "embedded.png"
        )
        fit_size = np.array(cand.shape[1::-1])
        checks = geometry_checks(ref.shape, affine, coefficients, fit_size)
        display, valid = resample(ref, affine, coefficients, fit_size)
        measured = quality.evaluate(cand, display, valid)
        ref = diff.load(folder / "embedded.png")
        cand = diff.match_shape(diff.load(folder / "auto.png"), ref)
        target, valid = resample(ref, affine, coefficients, fit_size)
        native = quality.native_absolute(cand, target, 0.05, valid)
        h, w = ref.shape[:2]
        y, x = round(h * 0.1), round(w * 0.1)
        bands = diff.per_band_bias(
            cand[y : h - y, x : w - x],
            target[y : h - y, x : w - x],
            valid[y : h - y, x : w - x],
        )
        bias_failed = not bands or any(
            not np.isfinite(v[c]) or abs(v[c]) > 0.05
            for v in bands.values()
            for c in "RGB"
        )
        measured.pop("tiles", None)
        records.append(
            {
                "fixture": name,
                "geometry": checks,
                "display": measured,
                "native": native,
                "bands": bands,
                "bias_failed": bias_failed,
                "diagnostic_pass": not (
                    checks["breaches"]
                    or measured["breaches"]
                    or native["breaches"]
                    or bias_failed
                ),
                "native_size": [w, h],
            }
        )
        print(
            name,
            "geometry",
            checks["breaches"],
            "display",
            len(measured["breaches"]),
            "native",
            len(native["breaches"]),
            "bias",
            bias_failed,
            flush=True,
        )
    args.output.write_text(
        json.dumps(
            {
                "diagnostic_only": True,
                "note": "Native means embedded-preview resolution, not full RAW sensor resolution.",
                "cases": records,
            },
            indent=2,
        )
        + "\n"
    )


if __name__ == "__main__":
    main()
