import copy
import unittest

import support_matrix


class SupportMatrixTest(unittest.TestCase):
    def setUp(self) -> None:
        self.matrix = support_matrix.load()

    def assert_rejected(self, change: dict, message: str) -> None:
        matrix = copy.deepcopy(self.matrix)
        matrix["rows"][0] |= change
        with self.assertRaisesRegex(ValueError, message):
            support_matrix.validate(matrix)

    def test_committed_readme_matches_the_matrix(self) -> None:
        readme = support_matrix.README.read_text()
        self.assertEqual(support_matrix.render(readme, self.matrix), readme)

    def test_qualified_rows_need_an_evidence_link(self) -> None:
        self.assert_rejected({"status": "qualified"}, "evidence")

    def test_rows_ci_cannot_run_cannot_claim_ci_smoke(self) -> None:
        self.assert_rejected(
            {"session": "gnome-wayland", "status": "ci-smoke"}, "cannot be marked"
        )

    def test_unknown_values_and_duplicates_are_rejected(self) -> None:
        self.assert_rejected({"status": "supported"}, "Unknown status")
        self.assert_rejected({"package": "flatpak"}, "Unknown package")
        matrix = copy.deepcopy(self.matrix)
        matrix["rows"].append(matrix["rows"][0])
        with self.assertRaisesRegex(ValueError, "Duplicate"):
            support_matrix.validate(matrix)

    def test_a_stale_table_is_rewritten(self) -> None:
        readme = support_matrix.README.read_text()
        matrix = copy.deepcopy(self.matrix)
        matrix["rows"][0]["status"] = "untested"
        self.assertNotEqual(support_matrix.render(readme, matrix), readme)

    def test_every_ci_smoke_row_becomes_a_container_job(self) -> None:
        jobs = support_matrix.ci_smoke(self.matrix)
        claimed = {
            (row["package"], self.matrix["sessions"][row["session"]]["smoke"])
            for row in self.matrix["rows"]
            if row["status"] == "ci-smoke"
        }
        scheduled = {
            (job["package"], session)
            for job in jobs
            for session in job["sessions"].split(",")
        }
        self.assertEqual(claimed, scheduled)
        self.assertTrue(all(job["container"] == "ubuntu:24.04" for job in jobs))

    def test_qualified_evidence_is_linked_in_the_table(self) -> None:
        matrix = copy.deepcopy(self.matrix)
        matrix["rows"][4] |= {
            "status": "qualified",
            "evidence": "https://github.com/zubair-io/Maple/issues/5449",
        }
        support_matrix.validate(matrix)
        self.assertIn(
            "[qualified](https://github.com/zubair-io/Maple/issues/5449)",
            support_matrix.table(matrix),
        )


if __name__ == "__main__":
    unittest.main()
