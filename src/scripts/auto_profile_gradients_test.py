"""Gradient orchestration must fail closed; physical checks run separately."""

import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import auto_profile_gradients as gradients


class GradientGateTests(unittest.TestCase):
    def exercise(self, mode):
        with tempfile.TemporaryDirectory() as temp:
            folder = Path(temp)
            budgets = json.loads(
                (gradients.REPO / "test-fixtures/banding_budgets.json").read_text()
            )["fixtures"]

            def command(args, **kwargs):
                if args[1] == "auto-tail-ramp":
                    if mode == "unavailable":
                        return subprocess.CompletedProcess(args, 2)
                    ramps = Path(args[-1])
                    ramps.mkdir()
                    (ramps / "fit-provenance.json").write_text(
                        json.dumps(
                            {
                                "demosaic": "full"
                                if mode == "wrong-quality"
                                else "amaze",
                                "fit_dimensions": [100, 80],
                            }
                        )
                    )
                    return subprocess.CompletedProcess(args, 0)
                key = args[args.index("--budget-key") + 1]
                budget = budgets[key]
                metrics = {key: 0.0 for key in budget}
                failed = mode in ("failure", "dishonest") and "neutral" in key
                if failed:
                    metric = next(iter(budget))
                    metrics[metric] = budget[metric] + 1
                reported_pass = not failed or mode == "dishonest"
                output = Path(args[args.index("--json") + 1])
                output.write_text(
                    json.dumps(
                        {
                            "stage": "18_auto_tail",
                            "ramp_axis": args[args.index("--ramp-axis") + 1],
                            "budget_key": key,
                            "budget": budget,
                            "second_difference": metrics,
                            "flat_run": {},
                            "passed": reported_pass,
                        }
                    )
                )
                return subprocess.CompletedProcess(args, 0 if reported_pass else 1)

            with patch.object(gradients.subprocess, "run", side_effect=command):
                return gradients.check(Path("cli"), Path("raw"), folder, {})

    def test_all_five_measurements_required(self):
        result = self.exercise("pass")
        self.assertEqual(result["status"], "passed")
        self.assertEqual(len(result["ramps"]), 5)

    def test_single_ramp_failure_fails_gate(self):
        self.assertEqual(self.exercise("failure")["status"], "failed")

    def test_missing_producer_fails_closed(self):
        with self.assertRaises(RuntimeError):
            self.exercise("unavailable")

    def test_different_demosaic_is_not_accepted(self):
        with self.assertRaises(ValueError):
            self.exercise("wrong-quality")

    def test_reported_pass_cannot_override_metrics(self):
        with self.assertRaises(ValueError):
            self.exercise("dishonest")


if __name__ == "__main__":
    unittest.main()
