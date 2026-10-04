"""#3940: actual baseline/fixed syscall traces and corrupted-receipt refusals.

Pass both retained real XCTest traces; missing fixtures are errors, never skips.
These tests validate observation integrity, not mocked sidecar/filesystem I/O.
"""

import argparse
import re
import tempfile
import unittest
from pathlib import Path

from verify_mac_directory_sync import verify


class ActualDirectoryTraceTests(unittest.TestCase):
    def changed(self, transform):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        path = Path(temporary.name) / "altered.log"
        path.write_text(transform(FIXED.read_text()))
        return path

    def test_actual_fixed_calls_prove_complete_ordered_carriers(self):
        report = verify(FIXED)
        self.assertEqual(len(report["successfulDirectorySyncs"]), 14)
        self.assertTrue(report["sidecarFollowsCompanions"])
        self.assertFalse(report["releaseQualified"])

    def test_actual_old_implementation_has_a_directory_durability_gap(self):
        with self.assertRaisesRegex(ValueError, "Missing bottom-up carrier"):
            verify(BASELINE)

    def test_absent_interposition_cannot_claim_syncs(self):
        path = self.changed(
            lambda text: re.sub(
                r"^MAPLE_DIRECTORY_SYNC .*\n", "", text, flags=re.MULTILINE
            )
        )
        with self.assertRaisesRegex(ValueError, "successful real directory syncs"):
            verify(path)

    def test_failed_syscall_cannot_claim_confirmation(self):
        path = self.changed(
            lambda text: text.replace(
                "MAPLE_DIRECTORY_SYNC 0", "MAPLE_DIRECTORY_SYNC -1", 1
            )
        )
        with self.assertRaisesRegex(ValueError, "successful real directory syncs"):
            verify(path)

    def test_reordered_parent_receipts_refuse(self):
        def reorder(text):
            lines = text.splitlines()
            indices = [
                i
                for i, line in enumerate(lines)
                if line.startswith("MAPLE_DIRECTORY_SYNC")
            ]
            first, second = indices[:2]
            lines[first], lines[second] = lines[second], lines[first]
            return "\n".join(lines) + "\n"

        with self.assertRaisesRegex(ValueError, "Missing bottom-up carrier"):
            verify(self.changed(reorder))

    def test_incomplete_xctest_run_cannot_claim_success(self):
        path = self.changed(
            lambda text: text.replace(
                "Executed 1 test, with 0 failures", "Incomplete test run"
            )
        )
        with self.assertRaisesRegex(ValueError, "XCTest must complete"):
            verify(path)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("baseline", type=Path)
    parser.add_argument("fixed", type=Path)
    args = parser.parse_args()
    BASELINE, FIXED = args.baseline, args.fixed
    unittest.main(argv=["mac_directory_sync_test"], verbosity=2)
