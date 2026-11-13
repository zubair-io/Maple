"""Verify immutable physical outputs and recompare with committed Auto gate code."""

import argparse
import json
import sys
from pathlib import Path


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--repo", type=Path, required=True)
    ap.add_argument("--evidence", type=Path, required=True)
    args = ap.parse_args()
    sys.path.insert(0, str(args.repo.resolve() / "src/scripts"))
    import auto_profile_match as gate

    summary = json.loads((args.evidence / "summary.json").read_text())
    assert summary["complete"] and len(summary["cases"]) == summary["selected"] == 20
    assert (
        summary["binary_unchanged"]
        and gate.sha(summary["binary"]) == summary["binary_sha256"]
    )
    rows = []
    for row in summary["cases"]:
        assert gate.sha(row["raw"]) == row["raw_sha256"], row["fixture"]
        assert row["status"] in ("passed", "failed", "no-preview"), row
        if row["status"] == "no-preview":
            # Validate the extractor sentinel again; it must still be3.
            import subprocess

            result = subprocess.run(
                [
                    summary["binary"],
                    "extract-preview",
                    row["raw"],
                    "--out",
                    str(args.evidence / "unexpected-preview.png"),
                ],
                check=False,
                capture_output=True,
            )
            assert result.returncode == 3, (row["fixture"], result.returncode)
        else:
            folder = args.evidence / row["fixture"]
            candidate, reference = folder / "auto.png", folder / "embedded.png"
            assert gate.sha(candidate) == row["candidate_sha256"]
            assert gate.sha(reference) == row["reference_sha256"]
            actual = gate.compare(candidate, reference, summary["budget"])
            assert all(
                actual[key] == row[key] for key in ("status", "bands", "breaches")
            ), row["fixture"]
        rows.append(
            {"fixture": row["fixture"], "status": row["status"], "verified": True}
        )
        print("verified", row["fixture"], flush=True)
    receipt = {
        "verified": True,
        "cases": rows,
        "binary_sha256": summary["binary_sha256"],
        "runner_sha256": gate.sha(gate.__file__),
        "comparator_sha256": gate.sha(gate.diff.__file__),
        "note": "Final formatted gate code independently re-compares all retained physical images; no rerender or reference substitution.",
    }
    (args.evidence / "final-code-verification.json").write_text(
        json.dumps(receipt, indent=2) + "\n"
    )


if __name__ == "__main__":
    main()
