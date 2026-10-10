"""#3940: integrity controls for actual baseline and repaired recovery traces."""

import argparse
import re
import tempfile
import unittest
from pathlib import Path

from verify_mac_postrename_recovery import verify


class ActualRecoveryTraceTests(unittest.TestCase):
    def changed(self, transform):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        path = Path(temporary.name) / "altered.log"
        path.write_text(transform(FIXED.read_text()))
        return path

    def refuses(self, transform):
        with self.assertRaises(ValueError):
            verify(self.changed(transform))

    def test_actual_fixed_three_cases_and_five_revocations(self):
        report = verify(FIXED)
        self.assertEqual(report["actualAccessRevocations"], 5)
        self.assertEqual(report["distinctOwnedRoots"], 3)
        self.assertEqual(len(report["reconfirmedOperations"]), 3)
        self.assertFalse(report["releaseQualified"])

    def test_actual_baseline_retry_fails(self):
        text = BASELINE.read_text()
        self.assertIn("MAPLE_REAL_ACCESS_REVOCATION", text)
        self.assertIn("saveConflict", text)
        self.assertRegex(text, r"Executed 1 test, with 1 failure")
        with self.assertRaises(ValueError):
            verify(BASELINE)

    def test_missing_revocations(self):
        self.refuses(
            lambda t: re.sub(
                r"^MAPLE_REAL_ACCESS_REVOCATION .*\n", "", t, flags=re.MULTILINE
            )
        )

    def test_receipts_before_failure_cannot_confirm_retry(self):
        self.refuses(
            lambda t: re.sub(
                r"^MAPLE_FILE_SYNC 0 .*/photo.xmp\n", "", t, flags=re.MULTILINE
            )
        )

    def test_temporary_file_is_not_existing_xmp(self):
        self.refuses(lambda t: t.replace("/photo.xmp\n", "/.photo.xmp.tmp\n"))

    def test_real_sync_failure(self):
        self.refuses(
            lambda t: re.sub(
                r"MAPLE_FILE_SYNC 0 (.*?/photo.xmp)\n", r"MAPLE_FILE_SYNC -1 \1\n", t
            )
        )

    def test_unchanged_inode(self):
        self.refuses(
            lambda t: re.sub(
                r"MAPLE_REAL_ACCESS_REVOCATION (\d+) \d+",
                r"MAPLE_REAL_ACCESS_REVOCATION \1 \1",
                t,
            )
        )

    def test_missing_case(self):
        self.refuses(
            lambda t: t.replace(
                "testChangedOriginalRefusesReconciliationOfAlreadyPublishedRemoval",
                "otherCase",
            )
        )

    def test_skipped_case(self):
        self.refuses(lambda t: t.replace("]' passed", "]' skipped", 1))

    def test_incomplete_selected_run(self):
        self.refuses(
            lambda t: t.replace("Executed 3 tests, with 0 failures", "Incomplete run")
        )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("baseline", type=Path)
    parser.add_argument("fixed", type=Path)
    args = parser.parse_args()
    BASELINE, FIXED = args.baseline, args.fixed
    unittest.main(argv=["mac_postrename_recovery_test"], verbosity=2)
