#!/usr/bin/env python3
"""Contract tests for Auto's embedded-JPEG gate (#5000)."""

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import auto_profile_match as gate
import numpy as np
from PIL import Image


class AutoJpegGateTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.raw = self.root / "test_0000.DNG"
        self.raw.write_bytes(b"immutable fixture marker")
        self.cli = self.root / "maple-cli"
        self.cli.write_bytes(b"pinned binary marker")
        self.out = self.root / "evidence"
        self.out.mkdir()

    def run_gate(self, preview_rc=0, render_rc=0, bias=0, gradient_status="passed"):
        def command(args, **kwargs):
            action = args[1]
            rc = preview_rc if action == "extract-preview" else render_rc
            if rc == 0:
                target = args[args.index("--out") + 1]
                image = np.full((64, 64, 3), 128, dtype=np.uint8)
                if action == "render":
                    image[..., 1] += bias
                Image.fromarray(image).save(target)
            return subprocess.CompletedProcess(args, rc)

        with (
            patch.object(gate.subprocess, "run", side_effect=command),
            patch.object(
                gate.gradients, "check", return_value={"status": gradient_status}
            ),
        ):
            result = gate.qualify(self.cli, [("test_0000", self.raw)], self.out, 0.05)
        return result, json.loads((self.out / "summary.json").read_text())

    def test_matching_embedded_image_passes_with_evidence(self):
        rc, result = self.run_gate()
        self.assertEqual(rc, 0)
        self.assertEqual(result["target"], "camera-embedded-jpeg")
        self.assertEqual(result["counts"]["passed"], 1)
        self.assertIn("reference_sha256", result["cases"][0])

    def test_green_cast_fails(self):
        rc, result = self.run_gate(bias=20)
        self.assertEqual(rc, 1)
        self.assertEqual(result["cases"][0]["breaches"][0]["channel"], "G")

    def test_photo_pass_cannot_hide_gradient_failure(self):
        rc, result = self.run_gate(gradient_status="failed")
        self.assertEqual(rc, 1)
        self.assertEqual(result["cases"][0]["photographic_status"], "passed")
        self.assertEqual(result["cases"][0]["status"], "failed")

    def test_balanced_errors_fail_despite_zero_bias(self):
        reference = self.root / "reference.png"
        candidate = self.root / "candidate.png"
        Image.new("RGB", (64, 64), (128, 128, 128)).save(reference)
        pixels = np.full((64, 64, 3), 128, dtype=np.uint8)
        pixels[:, :32] = 179
        pixels[:, 32:] = 77
        Image.fromarray(pixels).save(candidate)
        result = gate.compare(candidate, reference, 0.05)
        self.assertFalse(result["breaches"])
        self.assertEqual(result["native_absolute"]["status"], "failed")
        self.assertEqual(result["status"], "failed")
        cli = subprocess.run(
            [
                sys.executable,
                str(Path(gate.__file__).with_name("auto_profile_diff.py")),
                str(candidate),
                str(reference),
            ],
            check=False,
            capture_output=True,
            text=True,
        )
        self.assertEqual(cli.returncode, 1)
        self.assertEqual(json.loads(cli.stdout)["status"], "failed")

    def test_render_failure_is_error_not_skip(self):
        rc, result = self.run_gate(render_rc=1)
        self.assertEqual(rc, 1)
        self.assertEqual(result["counts"]["error"], 1)

    def test_real_preview_error_is_not_missing_preview(self):
        rc, result = self.run_gate(preview_rc=1)
        self.assertEqual(rc, 1)
        self.assertEqual(result["counts"]["error"], 1)
        self.assertEqual(result["counts"]["no-preview"], 0)

    def test_all_previewless_cannot_pass(self):
        rc, result = self.run_gate(preview_rc=3)
        self.assertEqual(rc, 1)
        self.assertEqual(result["counts"]["no-preview"], 1)

    def test_previewless_fallback_is_rendered_and_verified(self):
        rc, result = self.run_gate(preview_rc=3)
        self.assertEqual(rc, 1)
        self.assertEqual(result["previewless_fallback_checks"], 1)
        self.assertEqual(result["cases"][0]["fallback"]["status"], "passed")
        self.assertTrue((self.out / "test_0000/fallback-neutral.png").exists())

    def test_previewless_fallback_render_error_fails(self):
        rc, result = self.run_gate(preview_rc=3, render_rc=1)
        self.assertEqual(rc, 1)
        self.assertEqual(result["counts"]["error"], 1)

    def test_previewless_auto_neutral_difference_fails(self):
        def command(args, **kwargs):
            value = 128 if args[-1] == "neutral" else 130
            Image.new("RGB", (64, 64), (value, value, value)).save(
                args[args.index("--out") + 1]
            )
            return subprocess.CompletedProcess(args, 0)

        with (
            patch.object(gate.subprocess, "run", side_effect=command),
            self.assertRaisesRegex(ValueError, "does not equal Neutral"),
        ):
            gate.validate_previewless(self.cli, self.raw, self.out, {})

    def test_empty_filter_fails_closed(self):
        with self.assertRaises(ValueError):
            gate.fixtures(self.root, None, "does-not-exist")

    def test_camera_extensions_discovered(self):
        for extension in ["RW2", "PEF", "ORF", "CR3"]:
            (self.root / f"test_{extension}.{extension}").touch()
        self.assertEqual(len(gate.fixtures(self.root, None, "")), 5)

    def test_manifest_selects_only_baseline_raws(self):
        manifest = self.root / "manifest.json"
        manifest.write_text(
            json.dumps(
                {
                    "cases": [
                        {"name": "test_0000/baseline", "raw": self.raw.name},
                        {"name": "test_0000/exposure_max", "raw": "never-read"},
                    ]
                }
            )
        )
        self.assertEqual(
            gate.fixtures(None, manifest, ""), [("test_0000", self.raw.resolve())]
        )

    def test_too_few_pixels_cannot_pass(self):
        image = self.root / "small.png"
        Image.new("RGB", (5, 5), (128, 128, 128)).save(image)
        with self.assertRaisesRegex(ValueError, "no measurable"):
            gate.compare(image, image, 0.05)


if __name__ == "__main__":
    unittest.main()
