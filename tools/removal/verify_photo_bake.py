"""#3941: independently compare all 18 native RAW grade PNGs to their truth.

This checks known/protected display samples, not ACR color parity, hidden
background quality or application/export/device qualification. The Rust baker
separately checks every native f32 sample outside coverage in full RAW develops.
"""

import argparse
import json
from pathlib import Path

import numpy as np
from native_probe_pixels import digest
from PIL import Image


def binary(path):
    with Image.open(path) as image:
        values = np.asarray(image)
    if values.shape != (1024, 1024) or not np.isin(values, [0, 255]).all():
        raise ValueError("Expected a binary native1024 mask")
    return values == 255


def verify(bake, protected_path, output):
    if output.exists():
        raise ValueError("Choose a fresh verification output file")
    report_path = bake / "report.json"
    report = json.loads(report_path.read_text())
    protected, coverage = binary(protected_path), binary(bake / "coverage.png")
    if not protected.any() or np.any(protected & coverage):
        raise ValueError("Empty protection or replacement coverage overlaps protection")
    if report["outside_mask_max_error"] != 0:
        raise ValueError("Rust full RAW f32 preservation check failed")
    expected = {
        f"{profile}_ev{ev:+d}_wb{wb:+d}"
        for profile in ("neutral", "auto")
        for ev in (-3, 0, 3)
        for wb in (-1000, 0, 1000)
    }
    cases = [row["case"] for row in report["grades"]]
    if len(cases) != 18 or set(cases) != expected:
        raise ValueError("Missing, repeated or unexpected RAW grade cases")
    rows = []
    for case in cases:
        paths = [
            bake / f"{case}-{name}.png" for name in ("truth", "identity", "removal")
        ]
        arrays = []
        for path in paths:
            with Image.open(path) as image:
                if image.mode != "RGB":
                    raise ValueError("Expected native RGB grade image")
                values = np.asarray(image)
            if values.shape != (1024, 1024, 3):
                raise ValueError("RAW grade image differs from native mask geometry")
            arrays.append(values)
        truth, identity, removal = arrays
        counts = {
            "outside_u8_samples_changed": int(
                np.count_nonzero(removal[~coverage] != truth[~coverage])
            ),
            "protected_u8_samples_changed": int(
                np.count_nonzero(removal[protected] != truth[protected])
            ),
            "identity_outside_u8_samples_changed": int(
                np.count_nonzero(identity[~coverage] != truth[~coverage])
            ),
        }
        if any(counts.values()):
            raise ValueError(f"Known/protected RAW grade sample changed: {case}")
        rows.append(
            {"case": case, **counts, "file_sha256": {p.name: digest(p) for p in paths}}
        )
    evidence = {
        "bake_report_sha256": digest(report_path),
        "protected_sha256": digest(protected_path),
        "coverage_sha256": digest(bake / "coverage.png"),
        "protected_pixels": int(protected.sum()),
        "coverage_pixels": int(coverage.sum()),
        "native_extent_hw": [1024, 1024],
        "grades": rows,
        "releaseQualified": False,
        "scope": "Independent known/protected native display sample equality for these 18 grade images only; Rust report independently records full-frame f32 equality. No ACR or photographic/performance/cross-platform claim.",
    }
    output.write_text(json.dumps(evidence, indent=2) + "\n")
    print(f"All {len(rows)} native grade comparisons passed")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("bake", "protected", "output"):
        parser.add_argument(f"--{name}", type=Path, required=True)
    args = parser.parse_args()
    verify(args.bake, args.protected, args.output)
