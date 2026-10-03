"""The CI validator cannot accept substituted or incomplete browser evidence."""

import copy
import unittest

from check_export_retry_evidence import scenario_titles, validate


def report(self_hosted=False):
    return {
        "stats": {
            "expected": len(scenario_titles(self_hosted)),
            "unexpected": 0,
            "skipped": 0,
            "flaky": 0,
        },
        "errors": [],
        "suites": [
            {
                "specs": [
                    {
                        "title": title,
                        "tests": [{"results": [{"status": "passed", "retry": 0}]}],
                    }
                    for title in sorted(scenario_titles(self_hosted))
                ]
            }
        ],
    }


class EvidenceTests(unittest.TestCase):
    def test_complete(self):
        self.assertEqual(validate(report()), 5)

    def test_self_hosted_complete(self):
        self.assertEqual(validate(report(True), self_hosted=True), 2)

    def test_self_hosted_missing_duplicate_substitute_skip_retry(self):
        for mutation in (
            "missing",
            "duplicate",
            "substitute",
            "skip",
            "retry",
            "stats",
            "errors",
        ):
            with self.subTest(mutation=mutation):
                value = report(True)
                specs = value["suites"][0]["specs"]
                if mutation == "missing":
                    specs.pop()
                elif mutation == "duplicate":
                    specs[1] = copy.deepcopy(specs[0])
                elif mutation == "substitute":
                    specs[1]["title"] = "browser original-protection smoke"
                elif mutation == "skip":
                    specs[0]["tests"][0]["results"][0]["status"] = "skipped"
                elif mutation == "retry":
                    specs[0]["tests"][0]["results"][0]["retry"] = 1
                elif mutation == "stats":
                    value["stats"]["expected"] = 3
                else:
                    value["errors"] = [{"message": "server crashed"}]
                with self.assertRaises(ValueError):
                    validate(value, self_hosted=True)

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
