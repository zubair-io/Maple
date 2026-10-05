"""Unit tests for color_qualification_accounting.py (#4226).

Run: python3 src/scripts/color_qualification_accounting_test.py
"""

from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPTS_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPTS_DIR))

import color_qualification_accounting as cqa


def _rec(f: str, c: str, status: str, res: str = "down", prof: str = "neutral", breaches=None, err=None):
    return {
        "fixture": f, "case": c, "status": status, "resolution": res,
        "profile": prof, "breaches": breaches or [], "error": err,
    }


class ColorQualificationAccountingTests(unittest.TestCase):
    def test_passing_duplicate_resolutions(self):
        """Passing duplicate resolutions (both down and full pass -> 1 executed, 0 failed)."""
        records = [
            _rec("test_0002", "sharpen_amount_max", "passed", res="down", prof="neutral"),
            _rec("test_0002", "sharpen_amount_max", "passed", res="full", prof="detail-fullres"),
        ]
        res = cqa.aggregate_qualification(records)
        self.assertEqual((res.comparisons_executed, res.comparisons_failed), (2, 0))
        self.assertEqual((res.unique_executed, res.unique_failed, res.unique_skipped), (1, 0, 0))
        self.assertEqual(cqa.format_comparison_totals(res), "# comparisons: executed=2 failed=0")
        self.assertEqual(cqa.format_qualification_evidence(res), "qualification: executed=1 failed=0 skipped=0")

    def test_failure_at_either_resolution(self):
        """Failure at either resolution: down fails/full passes, and down passes/full fails."""
        # Down fails, full passes
        res_a = cqa.aggregate_qualification([
            _rec("test_0002", "sharpen_amount_max", "breach", res="down", breaches=["mean 2.5>1.8"]),
            _rec("test_0002", "sharpen_amount_max", "passed", res="full"),
        ])
        self.assertEqual((res_a.comparisons_executed, res_a.comparisons_failed), (2, 1))
        self.assertEqual((res_a.unique_executed, res_a.unique_failed), (1, 1))

        # Down passes, full fails
        res_b = cqa.aggregate_qualification([
            _rec("test_0002", "sharpen_amount_max", "passed", res="down"),
            _rec("test_0002", "sharpen_amount_max", "breach", res="full", breaches=["p95 5.1>4.0"]),
        ])
        self.assertEqual((res_b.comparisons_executed, res_b.comparisons_failed), (2, 1))
        self.assertEqual((res_b.unique_executed, res_b.unique_failed), (1, 1))

        # Down error, full passes
        res_c = cqa.aggregate_qualification([
            _rec("test_0002", "sharpen_amount_max", "error", res="down", err="Decompress error"),
            _rec("test_0002", "sharpen_amount_max", "passed", res="full"),
        ])
        self.assertEqual((res_c.comparisons_executed, res_c.comparisons_failed, res_c.comparisons_errors), (2, 1, 1))
        self.assertEqual((res_c.unique_executed, res_c.unique_failed), (1, 1))

    def test_failure_at_both_resolutions(self):
        """Failure at both resolutions (both fail -> 1 executed, 1 failed, not double counted)."""
        records = [
            _rec("test_0002", "sharpen_amount_max", "breach", res="down", breaches=["mean 2.5>1.8"]),
            _rec("test_0002", "sharpen_amount_max", "breach", res="full", breaches=["mean 3.1>1.8"]),
        ]
        res = cqa.aggregate_qualification(records)
        self.assertEqual((res.comparisons_executed, res.comparisons_failed), (2, 2))
        self.assertEqual((res.unique_executed, res.unique_failed, res.unique_skipped), (1, 1, 0))
        self.assertEqual(cqa.format_comparison_totals(res), "# comparisons: executed=2 failed=2")
        self.assertEqual(cqa.format_qualification_evidence(res), "qualification: executed=1 failed=1 skipped=0")

    def test_missing_references_candidates_and_skips(self):
        """Missing references, candidates, and skips handling across passes."""
        # Case A: detail case skipped_no_reference at down, executed and passed at full
        res_a = cqa.aggregate_qualification([
            _rec("test_0000", "sharpen_amount_max", "skipped_no_reference", res="down"),
            _rec("test_0000", "sharpen_amount_max", "passed", res="full", prof="detail-fullres"),
        ])
        self.assertEqual((res_a.comparisons_executed, res_a.comparisons_skipped), (1, 1))
        self.assertEqual((res_a.unique_executed, res_a.unique_failed, res_a.unique_skipped), (1, 0, 0))

        # Case B: case skipped due to missing raw in all passes -> unique skipped
        res_b = cqa.aggregate_qualification([_rec("test_0009", "baseline", "skipped_no_raw")])
        self.assertEqual((res_b.comparisons_executed, res_b.comparisons_skipped), (0, 1))
        self.assertEqual((res_b.unique_executed, res_b.unique_skipped), (0, 1))

        # Case C: case skipped due to missing candidate
        res_c = cqa.aggregate_qualification([_rec("test_0010", "exposure_max", "skipped_no_candidate")])
        self.assertEqual((res_c.unique_executed, res_c.unique_skipped), (0, 1))

    def test_auto_vs_neutral_identity_distinction(self):
        """Auto vs Neutral identity distinction (test_0000/baseline vs test_0000/baseline_auto)."""
        records = [
            _rec("test_0000", "baseline", "passed", prof="neutral"),
            _rec("test_0000", "baseline_auto", "passed", prof="auto"),
        ]
        res = cqa.aggregate_qualification(records)
        self.assertEqual((res.comparisons_executed, res.comparisons_failed), (2, 0))
        self.assertEqual((res.unique_executed, res.unique_failed), (2, 0))
        self.assertIn(("test_0000", "baseline"), res.cases_by_identity)
        self.assertIn(("test_0000", "baseline_auto"), res.cases_by_identity)

    def test_manifest_with_no_duplicate_references(self):
        """Manifest with all unique declared cases (no dual resolutions)."""
        records = [_rec(f"test_{i:04d}", "baseline", "passed") for i in range(10)]
        res = cqa.aggregate_qualification(records)
        self.assertEqual((res.comparisons_executed, res.comparisons_failed), (10, 0))
        self.assertEqual((res.unique_executed, res.unique_failed, res.unique_skipped), (10, 0, 0))

    def test_inconsistent_and_missing_identity_rejection(self):
        """Reject inconsistent, malformed, or missing identities."""
        bad_records = [
            {"fixture": "", "case": "baseline", "status": "passed"},
            {"fixture": None, "case": "baseline", "status": "passed"},
            {"fixture": "test_0000/baseline", "case": "baseline", "status": "passed"},
            {"fixture": "test 0000", "case": "baseline", "status": "passed"},
            {"fixture": "test_0000", "case": "", "status": "passed"},
            {"fixture": "test_0000", "case": None, "status": "passed"},
            {"fixture": "test_0000", "case": "base line", "status": "passed"},
            {"fixture": "test_0000", "case": "baseline", "status": "unknown_status"},
            {"fixture": "test_0000", "case": "baseline"},
            "not a dict",
        ]
        for bad in bad_records:
            with self.subTest(record=bad):
                with self.assertRaises((ValueError, TypeError)):
                    cqa.validate_case_outcome(bad)

        with self.assertRaises(ValueError):
            cqa.aggregate_qualification([])

    def test_load_qualification_records_jsonl(self):
        """Load records from JSONL file with pass summary and nested cases."""
        with tempfile.NamedTemporaryFile("w+", suffix=".jsonl", delete=False) as tf:
            tf.write(json.dumps({
                "profile": "neutral", "compared": 2, "cases": [
                    {"fixture": "test_0000", "case": "baseline", "status": "passed"},
                    {"fixture": "test_0002", "case": "sharpen_amount_max", "status": "passed"},
                ],
            }) + "\n")
            tf.write(json.dumps({
                "profile": "auto", "compared": 1, "cases": [
                    {"fixture": "test_0000", "case": "baseline_auto", "status": "passed"},
                ],
            }) + "\n")
            tf.write(json.dumps({
                "profile": "detail-fullres", "compared": 1, "cases": [
                    {"fixture": "test_0002", "case": "sharpen_amount_max", "status": "passed"},
                ],
            }) + "\n")
            tf.flush()
            temp_path = Path(tf.name)

        try:
            outcomes = cqa.load_qualification_records(temp_path)
            self.assertEqual(len(outcomes), 4)
            res = cqa.aggregate_qualification(outcomes)
            self.assertEqual((res.comparisons_executed, res.unique_executed, res.unique_failed), (4, 3, 0))
        finally:
            temp_path.unlink(missing_ok=True)

    def test_canonical_run_simulation_numbers(self):
        """Simulate the canonical #4193/#4226 run: 806 comparisons, 796 unique, 96 failed."""
        records: list[dict] = []
        # 10 test_0002 sharpen/nr duplicate cases that pass in both Neutral and Detail
        for i in range(10):
            records.append(_rec("test_0002", f"sharpen_{i}", "passed", res="down", prof="neutral"))
            records.append(_rec("test_0002", f"sharpen_{i}", "passed", res="full", prof="detail-fullres"))

        # Remaining Neutral pass: 596 comparisons (75 failed, 521 passed)
        for i in range(75):
            records.append(_rec(f"test_{i % 20:04d}", f"neu_fail_{i}", "breach", res="down", prof="neutral"))
        for i in range(521):
            records.append(_rec(f"test_{i % 20:04d}", f"neu_pass_{i}", "passed", res="down", prof="neutral"))

        # Auto pass: 20 comparisons (all passed)
        for i in range(20):
            records.append(_rec(f"test_{i:04d}", "baseline_auto", "passed", res="down", prof="auto"))

        # Remaining Detail pass: 170 comparisons (21 failed, 149 passed)
        for i in range(21):
            records.append(_rec(f"test_{i % 20:04d}", f"det_fail_{i}", "breach", res="full", prof="detail-fullres"))
        for i in range(149):
            records.append(_rec(f"test_{i % 20:04d}", f"det_pass_{i}", "passed", res="full", prof="detail-fullres"))

        res = cqa.aggregate_qualification(records)
        # Total comparison executions: 20 + 596 + 20 + 170 = 806
        self.assertEqual(res.comparisons_executed, 806)
        # Total comparison failures: 75 + 21 = 96
        self.assertEqual(res.comparisons_failed, 96)
        # Unique cases executed: 796
        self.assertEqual(res.unique_executed, 796)
        # Unique cases failed: 96
        self.assertEqual(res.unique_failed, 96)
        self.assertEqual(res.unique_skipped, 0)
        self.assertEqual(cqa.format_comparison_totals(res), "# comparisons: executed=806 failed=96")
        self.assertEqual(
            cqa.format_qualification_evidence(res),
            "qualification: executed=796 failed=96 skipped=0",
        )


if __name__ == "__main__":
    unittest.main()
