"""#3940: actual before/after traces and observation-integrity refusals.

Both traces must be retained successful real XCTest runs. No synthetic sidecars
or skipped fixtures; altered receipts exercise only the trace verifier.
"""

import argparse
import re
import tempfile
import unittest
from pathlib import Path

from verify_mac_restored_sync import verify


class ActualRestoredTraceTests(unittest.TestCase):
    def changed(self, transform):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        path = Path(temporary.name) / "altered.log"
        path.write_text(transform(FIXED.read_text()))
        return path

    def test_actual_fixed_syncs_each_confirmed_target(self):
        report = verify(FIXED)
        self.assertEqual(set(report["operations"]), {"Keep", "Undo", "Redo", "Reuse"})
        self.assertTrue(report["confirmedAssetOrdering"])
        self.assertFalse(report["releaseQualified"])

    def test_actual_baseline_valid_bytes_lack_visibility_boundary_syncs(self):
        with self.assertRaisesRegex(
            ValueError, "missing referenced immutable file syncs"
        ):
            verify(BASELINE)

    def test_earlier_fixture_syncs_cannot_replace_keep_receipts(self):
        def remove_keep(text):
            before, rest = text.split("MAPLE_RESTORED_BEGIN Keep\n")
            section, after = rest.split("MAPLE_RESTORED_END Keep\n")
            section = re.sub(
                r"^MAPLE_FILE_SYNC .*\.(mask|f16)\n", "", section, flags=re.MULTILINE
            )
            return (
                before
                + "MAPLE_RESTORED_BEGIN Keep\n"
                + section
                + "MAPLE_RESTORED_END Keep\n"
                + after
            )

        with self.assertRaisesRegex(
            ValueError, "Keep: missing referenced immutable file syncs"
        ):
            verify(self.changed(remove_keep))

    def test_failed_real_sync_receipt_refuses_confirmation(self):
        with self.assertRaisesRegex(ValueError, "failed real sync"):
            verify(
                self.changed(
                    lambda t: t.replace(
                        "MAPLE_RESTORED_BEGIN Redo\nMAPLE_FILE_SYNC 0",
                        "MAPLE_RESTORED_BEGIN Redo\nMAPLE_FILE_SYNC -1",
                    )
                )
            )

    def test_missing_redo_operation_cannot_claim_success(self):
        with self.assertRaisesRegex(ValueError, "operation markers"):
            verify(
                self.changed(
                    lambda t: t.replace("MAPLE_RESTORED_END Redo", "MISSING_REDO_END")
                )
            )

    def test_carrier_before_companions_refuses(self):
        def reorder(text):
            before, rest = text.split("MAPLE_RESTORED_BEGIN Keep\n")
            lines = rest.splitlines()
            lines[0], lines[2] = lines[2], lines[0]
            return before + "MAPLE_RESTORED_BEGIN Keep\n" + "\n".join(lines) + "\n"

        with self.assertRaisesRegex(
            ValueError, "missing referenced immutable file syncs"
        ):
            verify(self.changed(reorder))

    def test_missing_xctest_completion_refuses(self):
        with self.assertRaisesRegex(ValueError, "XCTest must complete"):
            verify(
                self.changed(
                    lambda t: t.replace(
                        "Executed 1 test, with 0 failures", "Incomplete test run"
                    )
                )
            )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("baseline", type=Path)
    parser.add_argument("fixed", type=Path)
    args = parser.parse_args()
    BASELINE, FIXED = args.baseline, args.fixed
    unittest.main(argv=["mac_restored_sync_test"], verbosity=2)
