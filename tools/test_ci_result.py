"""Result-gate contract: skipped selected work is not passing evidence."""

import unittest

from ci_result import validate


class ResultTests(unittest.TestCase):
    def needs(self, selected="true", result="success"):
        return {
            "changes": {"result": "success", "outputs": {"web": selected}},
            "test": {"result": result},
        }

    def test_selected_success(self):
        validate(self.needs(), {"test": "web"}, "pull_request")

    def test_unselected_skip(self):
        validate(self.needs("false", "skipped"), {"test": "web"}, "push")

    def test_selected_failure_cancel_and_skip(self):
        for result in ("failure", "cancelled", "skipped"):
            with self.subTest(result=result), self.assertRaises(ValueError):
                validate(self.needs(result=result), {"test": "web"}, "push")

    def test_failed_selector(self):
        for result in ("failure", "cancelled", "skipped"):
            needs = self.needs("false", "skipped")
            needs["changes"]["result"] = result
            with self.subTest(result=result), self.assertRaises(ValueError):
                validate(needs, {"test": "web"}, "pull_request")

    def test_missing_or_invalid_output(self):
        for value in (None, "", "False", True):
            with self.subTest(value=value), self.assertRaises(ValueError):
                validate(self.needs(value), {"test": "web"}, "push")

    def test_all_jobs_accounted_for(self):
        with self.assertRaises(ValueError):
            validate(self.needs(), {}, "push")

    def test_unconditional_and_pr_only(self):
        validate(self.needs(), {"test": "always"}, "push")
        validate(self.needs(), {"test": "pr"}, "pull_request")
        validate(self.needs(result="skipped"), {"test": "pr"}, "push")


if __name__ == "__main__":
    unittest.main()
