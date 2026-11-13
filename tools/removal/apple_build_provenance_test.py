"""#4183: integrity controls on actual Apple build logs and final plist snapshots."""

import argparse
import hashlib
import json
import plistlib
import tempfile
import unittest
from pathlib import Path

from verify_apple_build_provenance import verify


class ActualBuildProvenanceTests(unittest.TestCase):
    def changed(self, alter):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        directory = Path(temporary.name)
        rows = [row for path in MANIFESTS for row in json.loads(path.read_text())]
        alter(rows, directory)
        first, second = directory / "mac.json", directory / "ios.json"
        first.write_text(json.dumps([r for r in rows if r["platform"] == "mac"]))
        second.write_text(json.dumps([r for r in rows if r["platform"] == "ios"]))
        return [first, second]

    def plist_change(self, transform):
        def alter(rows, directory):
            row = rows[0]
            info = plistlib.loads(Path(row["plist"]).read_bytes())
            transform(info)
            data = plistlib.dumps(info)
            output = directory / "altered.plist"
            output.write_bytes(data)
            row.update(plist=str(output), plistSHA256=hashlib.sha256(data).hexdigest())

        return self.changed(alter)

    def test_actual_six_builds_preserve_provenance_and_signatures(self):
        report = verify(MANIFESTS)
        self.assertEqual(report["buildsPassed"], 6)
        self.assertFalse(report["releaseQualified"])

    def test_actual_baseline_mixed_binary_xml_cannot_parse(self):
        data = BASELINE.read_bytes()
        self.assertTrue(data.startswith(b"bplist00"))
        self.assertTrue(data.rstrip().endswith(b"</plist>"))
        with self.assertRaises(plistlib.InvalidFileException):
            plistlib.loads(data)

    def test_stale_sha_cannot_identify_the_tested_code(self):
        with self.assertRaisesRegex(ValueError, "provenance SHA"):
            verify(self.plist_change(lambda d: d.update(MapleBuildGitSHA="stale")))

    def test_timestamp_from_an_earlier_build_is_refused(self):
        with self.assertRaisesRegex(ValueError, "timestamp"):
            verify(
                self.plist_change(
                    lambda d: d.update(MapleBuildDate="2000-01-01T00:00:00Z")
                )
            )

    def test_string_flag_cannot_replace_a_boolean_or_absent_default(self):
        with self.assertRaisesRegex(ValueError, "early-feature policy"):
            verify(self.plist_change(lambda d: d.update(MapleEarlyFeatures="true")))

    def test_deep_signature_failure_refuses_confirmation(self):
        with self.assertRaisesRegex(ValueError, "signature verification"):
            verify(self.changed(lambda rows, _: rows[0].update(codesignExit=1)))

    def test_partial_build_matrix_is_not_qualified(self):
        with self.assertRaisesRegex(ValueError, "six distinct"):
            verify(self.changed(lambda rows, _: rows.pop()))

    def test_actual_processing_order_cannot_be_reversed(self):
        def alter(rows, directory):
            row = rows[0]
            lines = Path(row["log"]).read_text().splitlines()
            process = next(
                i
                for i, line in enumerate(lines)
                if line.startswith("ProcessInfoPlistFile ")
                and "/Maple.app/" in line
                and "(in target 'Maple'" in line
            )
            stamp = next(
                i
                for i, line in enumerate(lines)
                if line.startswith("PhaseScriptExecution Stamp")
            )
            lines[process], lines[stamp] = lines[stamp], lines[process]
            data = ("\n".join(lines) + "\n").encode()
            output = directory / "altered.log"
            output.write_bytes(data)
            row.update(log=str(output), logSHA256=hashlib.sha256(data).hexdigest())

        with self.assertRaisesRegex(ValueError, "processing must precede"):
            verify(self.changed(alter))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("manifests", type=Path, nargs=2)
    parser.add_argument("--baseline", type=Path, required=True)
    args = parser.parse_args()
    MANIFESTS, BASELINE = args.manifests, args.baseline
    unittest.main(argv=["apple_build_provenance_test"], verbosity=2)
