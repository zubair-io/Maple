"""The CI validator cannot accept substituted or incomplete browser evidence."""

import copy
import unittest

from check_export_retry_evidence import validate


def report():
    return {
        "stats": {"expected": 5, "unexpected": 0, "skipped": 0, "flaky": 0},
        "errors": [],
        "suites": [
            {
                "specs": [
                    {
                        "title": f"browser export retry protects original identities: {scenario}",
                        "tests": [{"results": [{"status": "passed", "retry": 0}]}],
                    }
                    for scenario in (
                        "new",
                        "legacy",
                        "legacy-filtered",
                        "missing",
                        "unrelated",
                    )
                ]
            }
        ],
    }


class EvidenceTests(unittest.TestCase):
    def test_complete(self):
        self.assertEqual(validate(report()), 5)

    def test_missing_duplicate_substitute(self):
        for mutation in ("missing", "duplicate", "substitute"):
            with self.subTest(mutation=mutation):
                value = report()
                specs = value["suites"][0]["specs"]
                if mutation == "missing":
                    specs.pop()
                elif mutation == "duplicate":
                    specs[3] = copy.deepcopy(specs[0])
                else:
                    specs[3]["title"] = "unrelated smoke test"
                with self.assertRaises(ValueError):
                    validate(value)

    def test_errors_skips_failures_and_retries(self):
        for mutation in (
            "errors",
            "skipped",
            "unexpected",
            "flaky",
            "result",
            "retry",
            "extra",
        ):
            with self.subTest(mutation=mutation):
                value = report()
                results = value["suites"][0]["specs"][0]["tests"][0]["results"]
                if mutation == "errors":
                    value["errors"] = [{"message": "browser crashed"}]
                elif mutation in value["stats"]:
                    value["stats"][mutation] = 1
                elif mutation == "result":
                    results[0]["status"] = "skipped"
                elif mutation == "retry":
                    results[0]["retry"] = 1
                else:
                    results.append(copy.deepcopy(results[0]))
                with self.assertRaises(ValueError):
                    validate(value)


if __name__ == "__main__":
    unittest.main()
