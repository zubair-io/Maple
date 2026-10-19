"""Separate measured ACR breaches from proven defects; never waive a gate (#5000)."""

import argparse
import collections
import hashlib
import json
from pathlib import Path

import numpy as np
from PIL import Image

Image.MAX_IMAGE_PIXELS = None


def sha(path):
    with Path(path).open("rb") as file:
        return hashlib.file_digest(file, "sha256").hexdigest()


def native_mean(path):
    with Image.open(path) as im:
        total = np.zeros(3, dtype=np.int64)
        for y in range(0, im.height, 128):
            block = np.asarray(
                im.crop((0, y, im.width, min(y + 128, im.height))).convert("RGB")
            )
            total += block.sum(axis=(0, 1), dtype=np.int64)
        return total.astype(float) / (im.width * im.height * 255), im.size


def audit(repo, suite, output):
    ledger = (
        repo / "test-fixtures/qualification/color-suite-5000-branch37-full-cases.jsonl"
    )
    rows = [json.loads(line) for line in ledger.read_text().splitlines()]
    failures = [row for row in rows if row["status"] == "breach"]
    assert len(failures) == 105
    provenance = json.loads((suite / "identity.json").read_text())
    budgets_path = suite / "source/test-fixtures/budgets.json"
    budgets = json.loads(budgets_path.read_text())["fixtures"]
    manifest = json.loads((suite / "source/test-fixtures/manifest.json").read_text())[
        "cases"
    ]
    baseline_cases = {
        c["name"].split("/")[0]: c for c in manifest if c["name"].endswith("/baseline")
    }
    expected_candidates = {
        r["path"]: r["sha256"]
        for r in map(
            json.loads,
            (suite / "candidates-before-comparisons.jsonl").read_text().splitlines(),
        )
    }
    inputs = {
        r["path"]: r["sha256"]
        for r in map(
            json.loads, (suite / "inputs-before.jsonl").read_text().splitlines()
        )
    }
    full = {}
    # Re-measure current source37, rather than applying the old main attribution.
    for fixture in sorted(
        {r["fixture"] for r in failures if r["profile"] == "detail-fullres"}
    ):
        candidate = suite / "workspace/candidates" / f"{fixture}_baseline.png"
        reference = Path(
            next(
                o["png"]
                for o in baseline_cases[fixture]["outputs"]
                if o["resolution"] == "full"
            )
        )
        assert sha(candidate) == expected_candidates[str(candidate)]
        assert sha(reference) == inputs[str(reference)]
        cand, csize = native_mean(candidate)
        ref, rsize = native_mean(reference)
        assert csize == rsize, (fixture, csize, rsize)
        full[fixture] = {
            "bias": (cand - ref).tolist(),
            "size": list(csize),
            "candidate_sha256": sha(candidate),
            "reference_sha256": sha(reference),
        }
        print("native baseline measured", fixture, flush=True)
    delta = json.loads(
        (
            repo / "test-fixtures/qualification/color-suite-5000-branch37-full.json"
        ).read_text()
    )
    new = set(delta["matched_captured_main"]["new_failures"])
    tint_proposal = (
        repo
        / "test-fixtures/qualification/color-suite-5000-tint-recapture-proposal.json"
    )
    invalid = {row["case"] for row in json.loads(tint_proposal.read_text())["updates"]}
    classified = []
    for row in failures:
        name = row["fixture"] + "/" + row["case"]
        item = dict(
            row, classification="unresolved-processing-or-appearance", waived=False
        )
        item["next_check"] = (
            "Independent stage oracle or baseline-relative edit response; ACR difference alone is insufficient."
        )
        if name in invalid:
            item.update(
                classification="confirmed-reference-settings-defect",
                evidence=tint_proposal.name,
                next_check="Independently recaptured references are preserved; adoption still pending. No renderer diagnosis from this mismatched pair.",
            )
        elif name in new:
            item.update(
                classification="introduced-regression-needs-root-cause",
                evidence="color-suite-5000-branch37-full.json:matched_captured_main",
                next_check="Isolate processing changes against captured main; do not dismiss as intended AgX.",
            )
        elif row["profile"] == "detail-fullres":
            bias = full[row["fixture"]]["bias"]
            limit = budgets[row["fixture"]][row["case"]]["bias"]
            channels = [
                i for i, key in enumerate(["bR", "bG", "bB"]) if abs(row[key]) > limit
            ]
            inherited = bool(channels) and all(
                abs(bias[i]) > limit and bias[i] * row[["bR", "bG", "bB"][i]] > 0
                for i in channels
            )
            item.update(
                native_baseline_bias=bias,
                edit_excess_bias=[
                    row[key] - bias[i] for i, key in enumerate(["bR", "bG", "bB"])
                ],
            )
            if all(b.startswith("bias_") for b in row["breaches"]) and inherited:
                item.update(
                    classification="baseline-appearance-or-calibration-candidate",
                    next_check="Baseline already breaches every failing bias limit. Test decode/calibration and AgX independently before attributing to the detail operator.",
                )
        if (
            item["classification"] == "unresolved-processing-or-appearance"
            and row["fixture"] == "test_0011"
        ):
            item.update(
                classification="baseline-appearance-or-calibration-candidate",
                evidence="Sony baseline itself fails; this does not establish that AgX causes every edit failure.",
                next_check="Independent sensor-linear decode/calibration control, then baseline-relative edit response; preserve AgX.",
            )
        classified.append(item)
    result = {
        "scope": "Evidence triage of all105 source37 ACR failures. No budgets, source images, pass statuses or renderer changes.",
        "renderer_commit": provenance["branch_commit"],
        "binary_sha256": provenance["binary_sha256"],
        "ledger_sha256": sha(ledger),
        "budgets_sha256": sha(budgets_path),
        "classification_is_not_a_waiver": True,
        "confirmed_expected_agx_case_count": 0,
        "expected_agx_note": "Neutral AgX appearance is intentional. The evidence does not yet isolate AgX as the sole cause of a whole failing case; never call unexplained baseline bias expected.",
        "counts": dict(collections.Counter(x["classification"] for x in classified)),
        "native_baseline_measurements": full,
        "cases": classified,
    }
    assert sum(result["counts"].values()) == 105
    output.write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps(result["counts"]), flush=True)


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--repo", required=True, type=Path)
    ap.add_argument("--suite", required=True, type=Path)
    ap.add_argument("--output", required=True, type=Path)
    args = ap.parse_args()
    audit(args.repo, args.suite, args.output)
