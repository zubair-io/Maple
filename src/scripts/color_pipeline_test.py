"""The canonical color gate tests Auto against embedded JPEGs, never ACR."""

import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parent


class CanonicalColorGateTests(unittest.TestCase):
    def run_gate(self, *, bias=0, with_raw=True):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            raws = root / "raws"
            raws.mkdir()
            if with_raw:
                (raws / "test_0000.DNG").write_bytes(b"test fixture")
            cli = root / "maple-cli"
            cli.write_text("""#!/usr/bin/env python3
import sys
from PIL import Image
value = 128 + (int(__import__('os').environ['TEST_GREEN_BIAS']) if sys.argv[1] == 'render' else 0)
Image.new('RGB', (64, 64), (128, value, 128)).save(sys.argv[sys.argv.index('--out') + 1])
""")
            cli.chmod(0o755)
            out = root / "evidence"
            env = {
                k: v
                for k, v in os.environ.items()
                if not k.startswith("MAPLE_")
                and k not in ("FILTER", "MANIFEST", "BUDGET")
            }
            env.update(
                MAPLE_CLI=str(cli),
                RAW_DIR=str(raws),
                OUTPUT_DIR=str(out),
                TEST_GREEN_BIAS=str(bias),
            )
            result = subprocess.run(
                ["bash", str(SCRIPTS / "test_color_pipeline.sh")],
                env=env,
                capture_output=True,
                text=True,
                check=False,
            )
            summary = (
                json.loads((out / "summary.json").read_text())
                if (out / "summary.json").exists()
                else None
            )
            return result, summary

    def test_embedded_jpeg_pass_needs_no_acr_references_or_budgets(self):
        result, summary = self.run_gate()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(summary["target"], "camera-embedded-jpeg")
        self.assertEqual(summary["counts"]["passed"], 1)

    def test_embedded_jpeg_failure_is_canonical_color_failure(self):
        result, summary = self.run_gate(bias=20)
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertEqual(summary["counts"]["failed"], 1)

    def test_missing_raws_fail_instead_of_acr_skip_pass(self):
        result, summary = self.run_gate(with_raw=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIsNone(summary)

    def test_ci_does_not_invoke_retired_acr_comparisons(self):
        workflow = (
            SCRIPTS.parent.parent / ".github/workflows/raw-pipeline.yml"
        ).read_text()
        for retired in (
            "test_tone_exposure.sh",
            "test_tone_whites.sh",
            "diagnose_acr_comparison.sh",
            "acr_comparison_diagnostic_test.py",
            "compare_images_test.py",
            "src/scripts/acr-reference",
        ):
            self.assertNotIn(retired, workflow)
        self.assertIn("run: bash src/scripts/test_color_pipeline.sh", workflow)


if __name__ == "__main__":
    unittest.main()
