"""Identity accounting must retain every resolution and fail closed (#4226)."""

import importlib.util
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SPEC = importlib.util.spec_from_file_location(
    "color_qualification",
    Path(__file__).parents[1] / "src/scripts/color_qualification.py",
)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


def manifest(outputs=("down", "full"), name="fixture/sharpen_amount_max"):
    return {"cases": [{"name": name, "outputs": [{"resolution": r} for r in outputs]}]}


def summaries(document, overrides=None):
    plans = MODULE.expected_attempts(document, "down", "")
    result = []
    for name, plan in plans.items():
        observations = [
            (
                identity,
                (overrides or {}).get(
                    (name, identity), "passed" if required else "missing_reference"
                ),
            )
            for identity, required in plan.items()
        ]
        row = {"profile": name, "observations": observations}
        for field in (*set(MODULE.STATUSES.values()), "breaches"):
            row[field] = sum(
                status == "failed"
                if field == "breaches"
                else MODULE.STATUSES[status] == field
                for _, status in observations
            )
        result.append(row)
    return result


class ColorQualificationTests(unittest.TestCase):
    def test_passing_duplicates_preserve_both_comparisons(self):
        result = MODULE.aggregate(summaries(manifest()), manifest())
        self.assertEqual(
            (result["executed"], result["comparisons"], result["failed"]), (1, 2, 0)
        )

    def test_failure_at_either_or_both_resolutions_fails_one_case(self):
        for passes in [
            ("neutral",),
            ("detail-fullres",),
            ("neutral", "detail-fullres"),
        ]:
            with self.subTest(passes=passes):
                overrides = {
                    (p, "fixture/sharpen_amount_max"): "failed" for p in passes
                }
                result = MODULE.aggregate(summaries(manifest(), overrides), manifest())
                self.assertEqual(result["failed"], 1)
                self.assertEqual(result["comparisons"], 2)
                self.assertEqual(result["comparison_failures"], len(passes))

    def test_missing_input_cannot_hide_behind_successful_other_resolution(self):
        for status in ("missing_reference", "missing_candidate", "missing_raw"):
            with self.subTest(status=status):
                result = MODULE.aggregate(
                    summaries(
                        manifest(), {("neutral", "fixture/sharpen_amount_max"): status}
                    ),
                    manifest(),
                )
                self.assertEqual((result["executed"], result["skipped"]), (1, 1))

    def test_missing_all_candidates_is_not_executed(self):
        overrides = {
            (p, "fixture/sharpen_amount_max"): "missing_candidate"
            for p in ("neutral", "detail-fullres")
        }
        result = MODULE.aggregate(summaries(manifest(), overrides), manifest())
        self.assertEqual((result["executed"], result["skipped"]), (0, 1))

    def test_full_only_detail_is_not_missing_coverage(self):
        document = manifest(("full",))
        result = MODULE.aggregate(summaries(document), document)
        self.assertEqual(
            (result["executed"], result["comparisons"], result["skipped"]), (1, 1, 0)
        )

    def test_auto_and_neutral_remain_distinct(self):
        document = manifest(name="fixture/baseline")
        result = MODULE.aggregate(summaries(document), document)
        self.assertEqual((result["executed"], result["comparisons"]), (2, 2))

    def test_no_overlap_manifest_counts_every_case(self):
        document = manifest(("down",), "fixture/exposure_max")
        result = MODULE.aggregate(summaries(document), document)
        self.assertEqual((result["executed"], result["comparisons"]), (1, 1))

    def test_diff_error_cannot_be_reported_as_success(self):
        rows = summaries(
            manifest(), {("neutral", "fixture/sharpen_amount_max"): "error"}
        )
        self.assertEqual(MODULE.aggregate(rows, manifest())["failed"], 1)

    def test_missing_duplicate_unknown_and_inconsistent_observations_rejected(self):
        for mutation in ("missing", "duplicate", "unknown", "count"):
            with self.subTest(mutation=mutation):
                rows = summaries(manifest())
                if mutation == "missing":
                    rows[0]["observations"] = []
                elif mutation == "duplicate":
                    rows[0]["observations"] *= 2
                elif mutation == "unknown":
                    rows[0]["observations"] = [("other/case", "passed")]
                else:
                    rows[0]["compared"] += 1
                with self.assertRaises(ValueError):
                    MODULE.aggregate(rows, manifest())

    def test_cli_retains_comparison_totals_and_nonzero_failure(self):
        for status, code in [
            ("passed", 0),
            ("failed", 1),
            ("error", 1),
            ("missing_reference", 1),
            ("missing_candidate", 1),
            ("missing_raw", 1),
        ]:
            with self.subTest(status=status), tempfile.TemporaryDirectory() as temp:
                directory = Path(temp)
                document = manifest()
                rows = summaries(
                    document, {("neutral", "fixture/sharpen_amount_max"): status}
                )
                data = directory / "summaries.jsonl"
                data.write_text("".join(json.dumps(row) + "\n" for row in rows))
                source = directory / "manifest.json"
                source.write_text(json.dumps(document))
                result = subprocess.run(
                    [
                        sys.executable,
                        str(SPEC.origin),
                        str(data),
                        str(source),
                        "down",
                        "",
                    ],
                    capture_output=True,
                    text=True,
                    check=False,
                )
                self.assertEqual(result.returncode, code, result.stderr)
                self.assertIn("qualification: executed=1", result.stdout)
                self.assertIn("comparisons: executed=", result.stdout)

    def test_cli_rejects_zero_and_incomplete_inventory(self):
        for defect in ("zero", "pass", "observation", "contradictory"):
            with self.subTest(defect=defect), tempfile.TemporaryDirectory() as temp:
                document = {"cases": []} if defect == "zero" else manifest()
                rows = summaries(document)
                if defect == "pass":
                    rows.pop()
                elif defect == "observation":
                    rows[0]["observations"] = []
                elif defect == "contradictory":
                    rows[0]["compared"] += 1
                directory = Path(temp)
                data = directory / "summaries.jsonl"
                data.write_text("".join(json.dumps(row) + "\n" for row in rows))
                source = directory / "manifest.json"
                source.write_text(json.dumps(document))
                result = subprocess.run(
                    [
                        sys.executable,
                        str(SPEC.origin),
                        str(data),
                        str(source),
                        "down",
                        "",
                    ],
                    capture_output=True,
                    text=True,
                    check=False,
                )
                self.assertNotEqual(result.returncode, 0)
                if defect != "zero":
                    self.assertNotIn("qualification:", result.stdout)

    def test_duplicate_resolution_and_unexpected_comparison_rejected(self):
        document = manifest(("down", "down"))
        with self.assertRaises(ValueError):
            MODULE.aggregate([], document)
        document = manifest(("full",))
        rows = summaries(
            document, {("neutral", "fixture/sharpen_amount_max"): "passed"}
        )
        with self.assertRaises(ValueError):
            MODULE.aggregate(rows, document)

    def test_missing_pass_and_duplicate_manifest_rejected(self):
        with self.assertRaises(ValueError):
            MODULE.aggregate(summaries(manifest())[:-1], manifest())
        document = manifest()
        document["cases"] *= 2
        with self.assertRaises(ValueError):
            MODULE.aggregate([], document)


if __name__ == "__main__":
    unittest.main()
