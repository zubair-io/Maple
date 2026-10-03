"""Fail closed when new lens cases hide lost original mode coverage (#4103)."""

import copy
import unittest

from tools.check_web_editor_evidence import split_reports


def report():
    def suite(filename, count):
        return {
            "file": filename,
            "specs": [],
            "suites": [
                {
                    "specs": [
                        {
                            "tests": [
                                {
                                    "expectedStatus": "passed",
                                    "results": [{"status": "passed", "retry": 0}],
                                }
                                for _ in range(count)
                            ]
                        }
                    ]
                }
            ],
        }

    return {
        "stats": {"expected": 26, "unexpected": 0, "skipped": 0, "flaky": 0},
        "suites": [
            suite("white-balance-workflow.spec.ts", 24),
            suite("lens-gesture-workflow.spec.ts", 2),
        ],
        "errors": [],
    }


class EditorEvidenceTests(unittest.TestCase):
    def test_keeps_original_mode_and_lens_evidence_separate(self):
        outputs = split_reports(report())
        self.assertEqual(outputs["wb-auto-tone-results.json"]["stats"]["expected"], 24)
        self.assertEqual(outputs["lens-gesture-results.json"]["stats"]["expected"], 2)

    def test_twenty_six_cases_cannot_hide_a_lost_original_case(self):
        candidate = report()
        original = candidate["suites"][0]["suites"][0]["specs"][0]["tests"].pop()
        candidate["suites"][1]["suites"][0]["specs"][0]["tests"].append(original)
        with self.assertRaises(ValueError):
            split_reports(candidate)

    def test_rejects_skips_retries_unexpected_cases_and_runner_errors(self):
        baseline = report()
        for change in ("skip", "retry", "unexpected", "runner"):
            candidate = copy.deepcopy(baseline)
            test = candidate["suites"][1]["suites"][0]["specs"][0]["tests"][0]
            if change == "skip":
                test["results"][0]["status"] = "skipped"
            elif change == "retry":
                test["results"][0]["retry"] = 1
            elif change == "unexpected":
                candidate["suites"].append(candidate["suites"][1])
            else:
                candidate["errors"].append({"message": "runner error"})
            with self.subTest(change=change), self.assertRaises(ValueError):
                split_reports(candidate)
