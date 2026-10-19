"""Replay both saved versions of every JPEG-bearing fixture, without rendering."""

import argparse
import hashlib
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[4] / "src/scripts"))
import auto_profile_match as gate
import auto_profile_quality as quality


def sha(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("evidence", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    base = args.evidence / "auto-embedded-jpeg-source37"
    rejected = args.evidence / "auto-jpeg-nodefit-restart-pilot"
    baseline = json.loads((base / "summary.json").read_text())
    rows = []
    for case in baseline["cases"]:
        name = case["fixture"]
        if case["status"] == "no-preview":
            rows.append(
                {"fixture": name, "status": "no-preview-not-image-quality-tested"}
            )
            continue
        newer = rejected / ("leica" if name == "test_0017" else "final-rest") / name
        reference = base / name / "embedded.png"
        assert sha(reference) == case["reference_sha256"] == sha(newer / "embedded.png")
        images = {
            "original": base / name / "auto.png",
            "rejected_calibration": newer / "auto.png",
        }
        row = {
            "fixture": name,
            "reference_sha256": sha(reference),
            "original_signed_bias_status": case["status"],
        }
        for label, image in images.items():
            row[label] = {"sha256": sha(image), **gate.compare(image, reference, 0.05)}
        rows.append(row)
        print(
            name, *(f"{label}={row[label]['status']}" for label in images), flush=True
        )
    results = {
        "status": "quality-harness-regression-replay-not-a-new-render",
        "quality_policy": quality.POLICY,
        "selected": len(rows),
        "compared": sum("original" in row for row in rows),
        "no_preview": sum("original" not in row for row in rows),
        "original_quality_failures": sum(
            row.get("original", {}).get("status") == "failed" for row in rows
        ),
        "rejected_calibration_quality_failures": sum(
            row.get("rejected_calibration", {}).get("status") == "failed"
            for row in rows
        ),
        "cases": rows,
    }
    assert (
        results["selected"] == 20
        and results["compared"] == 16
        and results["no_preview"] == 4
    )
    for fixture in ["test_0005", "test_0015", "test_0017"]:
        assert (
            next(row for row in rows if row["fixture"] == fixture)[
                "rejected_calibration"
            ]["status"]
            == "failed"
        )
    args.output.write_text(json.dumps(results, indent=2) + "\n")
    print(
        {
            key: value
            for key, value in results.items()
            if key not in ["cases", "quality_policy"]
        }
    )


if __name__ == "__main__":
    main()
