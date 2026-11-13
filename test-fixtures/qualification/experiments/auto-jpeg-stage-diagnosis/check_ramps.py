"""Measure every JPEG-bearing fixture's actual-quality Auto tail; no new budgets."""

import argparse
import hashlib
import json
import os
import subprocess
import sys
from pathlib import Path


def sha(path):
    with Path(path).open("rb") as file:
        return hashlib.file_digest(file, "sha256").hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cli", type=Path, required=True)
    parser.add_argument("--summary", type=Path, required=True)
    parser.add_argument("--repo", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    summary = json.loads(args.summary.read_text())
    assert summary["complete"] and len(summary["cases"]) == 20
    cases = [case for case in summary["cases"] if "quality" in case]
    assert len(cases) == 16 and len({case["fixture"] for case in cases}) == 16
    cases.sort(key=lambda case: (case["fixture"] != "test_0015", case["fixture"]))
    args.out.mkdir(parents=True, exist_ok=False)
    report = {
        "complete": False,
        "binary_sha256": sha(args.cli),
        "selected": 16,
        "scope": "All JPEG-bearing fixtures, AMaZE native fit. Unchanged test0000 ceilings applied to all cameras; diagnostic failures cannot be waived as image passes.",
        "cases": [],
    }
    env = {
        key: value for key, value in os.environ.items() if not key.startswith("MAPLE_")
    }
    env["RAYON_NUM_THREADS"] = "4"
    for case in cases:
        folder = args.out / case["fixture"]
        folder.mkdir()
        row = {"fixture": case["fixture"], "raw_sha256": sha(case["raw"]), "ramps": []}
        assert row["raw_sha256"] == case["raw_sha256"]
        with (folder / "producer.log").open("w") as log:
            run = subprocess.run(
                [
                    str(args.cli),
                    "auto-tail-ramp",
                    "--raw",
                    case["raw"],
                    "--out-dir",
                    str(folder / "ramps"),
                ],
                check=False,
                env=env,
                stdout=log,
                stderr=subprocess.STDOUT,
            )
        row["producer_exit"] = run.returncode
        if run.returncode == 0:
            provenance = json.loads((folder / "ramps/fit-provenance.json").read_text())
            assert provenance["demosaic"] == "amaze"
            row["provenance_sha256"] = sha(folder / "ramps/fit-provenance.json")
            for ramp in ["neutral", "foliage", "blue", "magenta", "skin"]:
                axis = "luma" if ramp == "neutral" else "chroma"
                budget = f"test_0000_auto2_{ramp}/18_auto_tail/{axis}"
                with (folder / f"{ramp}.log").open("w") as log:
                    check = subprocess.run(
                        [
                            sys.executable,
                            str(args.repo / "src/scripts/banding_check.py"),
                            str(folder / "ramps" / ramp),
                            "--stage",
                            "18_auto_tail",
                            "--ramp-axis",
                            axis,
                            "--json",
                            str(folder / f"{ramp}.json"),
                            "--budgets",
                            str(args.repo / "test-fixtures/banding_budgets.json"),
                            "--budget-key",
                            budget,
                            "--require-budget",
                        ],
                        check=False,
                        env=env,
                        stdout=log,
                        stderr=subprocess.STDOUT,
                    )
                row["ramps"].append(
                    {"name": ramp, "exit": check.returncode, "budget_key": budget}
                )
        row["raw_unchanged"] = sha(case["raw"]) == row["raw_sha256"]
        assert row["raw_unchanged"]
        row["passed"] = len(row["ramps"]) == 5 and all(
            r["exit"] == 0 for r in row["ramps"]
        )
        report["cases"].append(row)
        (args.out / "summary.json").write_text(json.dumps(report, indent=2) + "\n")
        print(json.dumps(row), flush=True)
    report["complete"] = True
    report["binary_unchanged"] = sha(args.cli) == report["binary_sha256"]
    report["passed"] = sum(row["passed"] for row in report["cases"])
    (args.out / "summary.json").write_text(json.dumps(report, indent=2) + "\n")
    return 0 if report["passed"] == 16 and report["binary_unchanged"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
