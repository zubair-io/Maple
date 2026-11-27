import unittest

import launch_timing


class SummaryTests(unittest.TestCase):
    def test_reports_min_median_and_max_of_the_runs(self) -> None:
        self.assertEqual(
            launch_timing.summary([0.9, 0.5, 0.7]),
            "launch-to-first-frame runs=3 min=0.500s median=0.700s max=0.900s",
        )


if __name__ == "__main__":
    unittest.main()
