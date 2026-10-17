"""Exercise canonical comparison passes with real PNG/XMP files."""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from compare_images_test import _qualified_native_pair

SCRIPTS = Path(__file__).resolve().parent


class DetailReferenceTests(unittest.TestCase):
    def run_detail_pass(self, label, protocol, reference_state, marker="PY_DETAIL"):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            full, down, sidecar, _outputs = _qualified_native_pair(root)
            resolution = "full" if marker == "PY_DETAIL" else "down"
            suffix = "_auto" if marker == "PY_AUTO" else ""
            control_label = (
                "sharpen_detail_max" if marker == "PY_DETAIL" else "baseline"
            )
            native = {"resolution": "full", "png": str(full)}
            preferred = {
                "resolution": resolution,
                "png": str(full if resolution == "full" else down),
            }
            broken = {"resolution": resolution, "png": str(root / "missing.png")}
            counterpart = [] if resolution == "full" else [native]
            selected = {
                "present": [*counterpart, preferred],
                "missing_file": [*counterpart, broken],
                "missing_entry": counterpart,
            }[reference_state]
            cases = [
                {
                    "name": f"test_0000/{control_label}",
                    "raw": str(full),
                    "acr_xmp": str(sidecar),
                    "reference_protocol": "native-pair-lanczos-v1",
                    "outputs": [*counterpart, preferred],
                },
                {
                    "name": f"test_0001/{label}",
                    "raw": str(full),
                    "acr_xmp": str(sidecar),
                    "outputs": selected,
                    **({"reference_protocol": protocol} if protocol else {}),
                },
            ]
            for case in cases:
                shutil.copyfile(full, root / (case["name"].replace("/", "_") + ".png"))
            manifest, budgets, summary = [
                root / name
                for name in ("manifest.json", "budgets.json", "summary.jsonl")
            ]
            manifest.write_text(json.dumps({"cases": cases}))
            budgets.write_text(
                json.dumps(
                    {
                        "fixtures": {
                            fixture: {
                                name + suffix: {
                                    "mean": 0.01,
                                    "p95": 0.01,
                                    "max": 0.01,
                                    "bias": 0.01,
                                }
                                for name in (control_label, label)
                            }
                            for fixture in ("test_0000", "test_0001")
                        }
                    }
                )
            )
            harness = (SCRIPTS / "test_color_pipeline.sh").read_text()
            body = harness.split(f"<<'{marker}'", 1)[1].split("\n", 1)[1]
            body = body.split(f"\n{marker}", 1)[0]
            result = subprocess.run(
                [
                    sys.executable,
                    "-",
                    str(manifest),
                    str(root),
                    str(SCRIPTS / "compare_images.py"),
                    resolution,
                    "",
                    str(budgets),
                    "",
                    "",
                    "12",
                    suffix,
                ],
                input=body,
                check=False,
                capture_output=True,
                text=True,
                env={**os.environ, "MAPLE_QUAL_SUMMARY": str(summary)},
            )
            self.assertTrue(summary.exists(), result.stdout + result.stderr)
            return result, json.loads(summary.read_text())

    def test_missing_migrated_reference_fails_even_when_another_case_passes(self):
        for label in ("sharpen_amount_max", "nr_luminance_max"):
            for state in ("missing_file", "missing_entry"):
                with self.subTest(label=label, state=state):
                    result, summary = self.run_detail_pass(
                        label, "native-pair-lanczos-v1", state
                    )
                    self.assertEqual(result.returncode, 1, result.stdout)
                    self.assertEqual(summary["compared"], 1)
                    self.assertEqual(summary["errors"], 1)
                    self.assertEqual(summary["skipped_no_reference"], 0)
                    record = next(c for c in summary["cases"] if c["case"] == label)
                    self.assertEqual(record["status"], "error")

    def test_unknown_protocol_cannot_hide_behind_a_missing_reference(self):
        result, summary = self.run_detail_pass(
            "nr_luminance_max", "unknown-v1", "missing_file"
        )
        self.assertEqual(result.returncode, 1, result.stdout)
        self.assertEqual(summary["errors"], 1)
        self.assertIn("unknown reference protocol", result.stderr)

    def test_present_migrated_references_compare_both_cases(self):
        result, summary = self.run_detail_pass(
            "nr_luminance_max", "native-pair-lanczos-v1", "present"
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(summary["compared"], 2)
        self.assertEqual(summary["errors"], 0)
        self.assertEqual(summary["skipped_no_reference"], 0)

    def test_undeclared_legacy_reference_keeps_skip_accounting(self):
        result, summary = self.run_detail_pass("nr_luminance_max", None, "missing_file")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(summary["compared"], 1)
        self.assertEqual(summary["errors"], 0)
        self.assertEqual(summary["skipped_no_reference"], 1)

    def test_missing_down_reference_fails_in_neutral_and_auto(self):
        for marker, label in (("PY", "exposure_min"), ("PY_AUTO", "baseline")):
            for state in ("missing_file", "missing_entry"):
                with self.subTest(marker=marker, state=state):
                    result, summary = self.run_detail_pass(
                        label, "native-pair-lanczos-v1", state, marker
                    )
                    self.assertEqual(result.returncode, 1, result.stdout)
                    self.assertEqual(summary["compared"], 1)
                    self.assertEqual(summary["errors"], 1)
                    self.assertEqual(summary["skipped_no_reference"], 0)

    def test_down_pass_controls(self):
        for marker, label in (("PY", "exposure_min"), ("PY_AUTO", "baseline")):
            for state, protocol, compared, skipped in (
                ("present", "native-pair-lanczos-v1", 2, 0),
                ("missing_file", None, 1, 1),
            ):
                with self.subTest(marker=marker, state=state):
                    result, summary = self.run_detail_pass(
                        label, protocol, state, marker
                    )
                    self.assertEqual(
                        result.returncode, 0, result.stdout + result.stderr
                    )
                    self.assertEqual(summary["compared"], compared)
                    self.assertEqual(summary["errors"], 0)
                    self.assertEqual(summary["skipped_no_reference"], skipped)

    def test_unknown_down_protocol_cannot_hide_behind_missing_reference(self):
        for marker, label in (("PY", "exposure_min"), ("PY_AUTO", "baseline")):
            with self.subTest(marker=marker):
                result, summary = self.run_detail_pass(
                    label, "unknown-v1", "missing_entry", marker
                )
                self.assertEqual(result.returncode, 1, result.stdout)
                self.assertEqual(summary["errors"], 1)
                self.assertIn("unknown reference protocol", result.stderr)

    def test_neutral_defers_native_only_details_to_full_pass(self):
        for label in ("sharpen_amount_max", "nr_luminance_max"):
            with self.subTest(label=label):
                result, summary = self.run_detail_pass(
                    label, "native-pair-lanczos-v1", "missing_entry", "PY"
                )
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                self.assertEqual(summary["compared"], 1)
                self.assertEqual(summary["skipped_no_reference"], 1)

    def test_detail_deferral_does_not_hide_a_broken_down_entry_or_protocol(self):
        for protocol, state in (
            ("native-pair-lanczos-v1", "missing_file"),
            ("unknown-v1", "missing_entry"),
        ):
            with self.subTest(protocol=protocol, state=state):
                result, summary = self.run_detail_pass(
                    "sharpen_amount_max", protocol, state, "PY"
                )
                self.assertEqual(result.returncode, 1, result.stdout)
                self.assertEqual(summary["errors"], 1)
                self.assertEqual(summary["skipped_no_reference"], 0)


if __name__ == "__main__":
    unittest.main()
