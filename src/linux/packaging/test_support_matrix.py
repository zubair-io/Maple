import copy
import unittest

import support_matrix


class SupportMatrixTest(unittest.TestCase):
    def setUp(self) -> None:
        self.matrix = support_matrix.load()

    def row(self, matrix: dict, status: str) -> dict:
        return next(row for row in matrix["rows"] if row["status"] == status)

    def assert_rejected(self, change: dict, message: str) -> None:
        matrix = copy.deepcopy(self.matrix)
        self.row(matrix, "ci-smoke").update(change)
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
        self.assert_rejected({"package": "snap"}, "Unknown package")
        matrix = copy.deepcopy(self.matrix)
        matrix["rows"].append(self.row(matrix, "ci-smoke"))
        with self.assertRaisesRegex(ValueError, "Duplicate"):
            support_matrix.validate(matrix)

    def test_flatpak_rows_are_accepted_and_scheduled(self) -> None:
        flatpak = [row for row in self.matrix["rows"] if row["package"] == "flatpak"]
        self.assertIn("ci-smoke", {row["status"] for row in flatpak})
        self.assertIn(
            "flatpak",
            {job["package"] for job in support_matrix.ci_smoke(self.matrix)},
        )

    def test_a_stale_table_is_rewritten(self) -> None:
        readme = support_matrix.README.read_text()
        matrix = copy.deepcopy(self.matrix)
        self.row(matrix, "ci-smoke")["status"] = "untested"
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

    def test_ci_smoke_needs_a_container_image(self) -> None:
        matrix = copy.deepcopy(self.matrix)
        distribution = self.row(matrix, "ci-smoke")["distribution"]
        del matrix["distributions"][distribution]["container"]
        with self.assertRaisesRegex(ValueError, "cannot be marked"):
            support_matrix.validate(matrix)

    def test_the_readme_needs_exactly_one_generated_block(self) -> None:
        block = f"{support_matrix.BEGIN}\n{support_matrix.END}"
        for readme in ["no markers", f"{block}\n{block}"]:
            with self.assertRaisesRegex(ValueError, "exactly one"):
                support_matrix.render(readme, self.matrix)

    def test_qualified_evidence_is_linked_in_the_table(self) -> None:
        matrix = copy.deepcopy(self.matrix)
        self.row(matrix, "untested").update(
            {
                "status": "qualified",
                "evidence": "https://github.com/zubair-io/Maple/issues/5449",
            }
        )
        support_matrix.validate(matrix)
        self.assertIn(
            "[qualified](https://github.com/zubair-io/Maple/issues/5449)",
            support_matrix.table(matrix),
        )


if __name__ == "__main__":
    unittest.main()
