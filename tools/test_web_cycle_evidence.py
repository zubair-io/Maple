"""The release gate rejects vacuous or partial browser qualification."""

import base64
import copy
import json
import unittest

from tools.check_web_cycle_evidence import validate


def report():
    tests = []
    for deployment in ("Hosted", "Self Hosted"):
        cycles = [
            {
                "cycle": cycle,
                "tool": "exposure" if cycle % 2 else "contrast",
                "value": (0.75 if cycle % 4 == 1 else -0.5)
                if cycle % 2
                else (12 if cycle % 4 == 2 else -8),
                "historyCount": min(cycle * 3, 32),
            }
            for cycle in range(1, 101)
        ]
        evidence = {
            "deployment": deployment,
            "expected": 100,
            "completed": 100,
            "historyLimit": 32,
            "cycles": cycles,
        }
        tests.append(
            {
                "results": [
                    {
                        "status": "passed",
                        "retry": 0,
                        "attachments": [
                            {
                                "name": "repeated-workflow-cycles",
                                "contentType": "application/json",
                                "body": base64.b64encode(
                                    json.dumps(evidence).encode()
                                ).decode(),
                            }
                        ],
                    }
                ]
            }
        )
    return {
        "stats": {"expected": 2, "unexpected": 0, "skipped": 0, "flaky": 0},
        "suites": [{"suites": [{"specs": [{"tests": tests}]}]}],
    }


class CycleEvidenceTests(unittest.TestCase):
    def test_complete_evidence(self):
        self.assertEqual(validate(report()), 200)

    def test_incomplete_and_retried_execution(self):
        for key in ("unexpected", "skipped", "flaky", "expected"):
            result = report()
            result["stats"][key] += 1
            with self.subTest(key=key), self.assertRaises(ValueError):
                validate(result)
        for field, value in (("status", "skipped"), ("retry", 1)):
            result = report()
            result["suites"][0]["suites"][0]["specs"][0]["tests"][0]["results"][0][
                field
            ] = value
            with self.subTest(field=field), self.assertRaises(ValueError):
                validate(result)

    def test_missing_duplicate_and_corrupt_cycle_artifacts(self):
        mutations = (
            lambda e: e.update(completed=99),
            lambda e: e.update(deployment="Self Hosted"),
            lambda e: e["cycles"].pop(),
            lambda e: e["cycles"][0].update(cycle=2),
            lambda e: e["cycles"][0].update(value=0),
            lambda e: e["cycles"][-1].update(historyCount=300),
        )
        for mutation in mutations:
            result = copy.deepcopy(report())
            attachment = result["suites"][0]["suites"][0]["specs"][0]["tests"][0][
                "results"
            ][0]["attachments"][0]
            evidence = json.loads(base64.b64decode(attachment["body"]))
            mutation(evidence)
            attachment["body"] = base64.b64encode(
                json.dumps(evidence).encode()
            ).decode()
            with self.assertRaises(ValueError):
                validate(result)
        result = report()
        result["suites"] = []
        with self.assertRaises(ValueError):
            validate(result)


if __name__ == "__main__":
    unittest.main()
