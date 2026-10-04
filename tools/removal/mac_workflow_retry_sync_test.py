"""#3940: require actual before/after retry traces; test receipt integrity."""

import argparse
import re
import tempfile
import unittest
from pathlib import Path

from verify_mac_workflow_retry_sync import verify


class ActualWorkflowRetryTraceTests(unittest.TestCase):
    def changed(self, transform):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        path = Path(temporary.name) / "altered.log"
        path.write_text(transform(FIXED.read_text()))
        return path

    def test_actual_fixed_retry_reconfirms_existing_sidecar_twice(self):
        report = verify(FIXED)
        self.assertTrue(report["existingSidecarDurabilityReconfirmed"])
        self.assertEqual(len(report["operations"]["Restore"]), 7)
        self.assertFalse(report["releaseQualified"])

    def test_actual_baseline_valid_restore_has_no_sidecar_confirmation(self):
        with self.assertRaisesRegex(ValueError, "Missing existing sidecar sync"):
            verify(BASELINE)

    def test_asset_receipts_cannot_replace_sidecar_receipts(self):
        path = self.changed(
            lambda t: re.sub(
                r"^MAPLE_FILE_SYNC 0 .*/source.xmp\n", "", t, flags=re.MULTILINE
            )
        )
        with self.assertRaisesRegex(ValueError, "Missing existing sidecar sync"):
            verify(path)

    def test_failed_sidecar_sync_refuses_confirmation(self):
        path = self.changed(
            lambda t: re.sub(
                r"^MAPLE_FILE_SYNC 0 (.*?/source.xmp)$",
                r"MAPLE_FILE_SYNC -1 \1",
                t,
                count=1,
                flags=re.MULTILINE,
            )
        )
        with self.assertRaisesRegex(ValueError, "Failed real sync"):
            verify(path)

    def test_incomplete_retry_cannot_claim_success(self):
        with self.assertRaisesRegex(ValueError, "restore/repeated-restore markers"):
            verify(
                self.changed(
                    lambda t: t.replace(
                        "MAPLE_WORKFLOW_RETRY_END RepeatedRestore", "MISSING_RETRY_END"
                    )
                )
            )

    def test_incomplete_xctest_cannot_claim_success(self):
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
    unittest.main(argv=["mac_workflow_retry_sync_test"], verbosity=2)
