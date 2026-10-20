"""Measure diagnostic Neutral renders with distortion at 0 and 100 percent."""

import argparse
import hashlib
import json
import sys
from pathlib import Path

from audit import audit


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("checkpoint", type=Path)
    parser.add_argument("scripts", type=Path)
    parser.add_argument("renders", type=Path)
    args = parser.parse_args()
    sys.path.insert(0, str(args.scripts))
    import auto_profile_alignment as alignment
    import auto_profile_quality as quality
    import auto_profile_registration as registration

    records = []
    for fixture in ["test_0015", "test_0006", "test_0007"]:
        for strength in [100, 0]:
            path = args.renders / f"{fixture}-{strength}.png"
            reference_path = args.checkpoint / "full-suite" / fixture / "embedded.png"
            candidate, reference = quality.load_display_pair(path, reference_path)
            warp, levels = registration.estimate(candidate, reference)
            reference, valid = alignment.resample_reference(reference, warp)
            record, canvas = audit(candidate, reference, valid)
            record.update(
                fixture=fixture,
                distortion_strength=strength,
                candidate_sha256=hashlib.sha256(path.read_bytes()).hexdigest(),
                reference_sha256=hashlib.sha256(
                    reference_path.read_bytes()
                ).hexdigest(),
                affine_warp=warp.tolist(),
                affine_fit=levels,
            )
            records.append(record)
            if canvas:
                canvas.save(args.renders / f"{fixture}-{strength}-landmarks.png")
            print(fixture, strength, record["regions"]["outer"], flush=True)
    (args.renders / "summary.json").write_text(
        json.dumps(
            {
                "diagnostic_only": True,
                "profile": "Neutral",
                "auto_exposure": "Off",
                "varied": "LensProfileDistortionScale only",
                "interpretation": (
                    "Measures geometry against embedded JPEG, not optical correctness. "
                    "Neutral brightness is not an Auto appearance acceptance result. "
                    "Production lens corrections remain enabled."
                ),
                "cases": records,
            },
            indent=2,
        )
        + "\n"
    )


if __name__ == "__main__":
    main()
