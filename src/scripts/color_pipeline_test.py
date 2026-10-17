"""Exercise the canonical harness's detail comparison pass with real PNG/XMP files."""

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
    def run_detail_pass(self, label, protocol, reference_state):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            full, _down, sidecar, _outputs = _qualified_native_pair(root)
            native = {"resolution": "full", "png": str(full)}
            broken = {"resolution": "full", "png": str(root / "missing.png")}
            selected = {
                "present": [native],
                "missing_file": [broken],
                "missing_entry": [],
            }[reference_state]
            cases = [
                {
                    "name": "test_0000/sharpen_detail_max",
                    "raw": str(full),
                    "acr_xmp": str(sidecar),
                    "reference_protocol": "native-pair-lanczos-v1",
                    "outputs": [native],
                },
                {
                    "name": f"test_0000/{label}",
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
                            "test_0000": {
                                name: {
                                    "mean": 0.01,
                                    "p95": 0.01,
                                    "max": 0.01,
                                    "bias": 0.01,
                                }
                                for name in ("sharpen_detail_max", label)
                            }
                        }
                    }
                )
            )
            harness = (SCRIPTS / "test_color_pipeline.sh").read_text()
            body = harness.split("<<'PY_DETAIL'", 1)[1].split("\n", 1)[1]
            body = body.split("\nPY_DETAIL", 1)[0]
            result = subprocess.run(
                [
                    sys.executable,
                    "-",
                    str(manifest),
                    str(root),
                    str(SCRIPTS / "compare_images.py"),
                    "full",
                    "",
                    str(budgets),
                    "",
                    "",
                    "12",
                    "",
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


if __name__ == "__main__":
    unittest.main()
