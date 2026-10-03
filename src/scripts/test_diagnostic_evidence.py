"""Real EXR/CLI coverage for non-vacuous halo and hue reports (#4082)."""

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import Imath
import numpy as np
import OpenEXR

SCRIPTS = Path(__file__).resolve().parent
STAGE = "16_agx.exr"


def write_stage(directory, rgb):
    directory.mkdir(parents=True, exist_ok=True)
    height, width, _ = rgb.shape
    header = OpenEXR.Header(width, height)
    channel = Imath.Channel(Imath.PixelType(Imath.PixelType.FLOAT))
    header["channels"] = dict.fromkeys("RGB", channel)
    output = OpenEXR.OutputFile(str(directory / STAGE), header)
    try:
        output.writePixels(
            {
                name: rgb[:, :, i].astype(np.float32).tobytes()
                for i, name in enumerate("RGB")
            }
        )
    finally:
        output.close()


class DiagnosticEvidenceTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="maple-diagnostic-test-")
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.report = self.root / "report.json"

    def run_tool(self, tool, *selection):
        return subprocess.run(
            [
                sys.executable,
                str(SCRIPTS / tool),
                str(self.root),
                "--json",
                str(self.report),
                *selection,
            ],
            capture_output=True,
            text=True,
            check=False,
        )

    def assert_rejected(self, tool, *selection):
        original = b'{"previous_measurement":true}\n'
        self.report.write_bytes(original)
        result = self.run_tool(tool, *selection)
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertEqual(self.report.read_bytes(), original)
        return result

    def hue_selection(self):
        return ("--primaries", "r", "--evs", "-3", "0")

    def write_hue_pair(self):
        for ev in (-3, 0):
            rgb = np.full((4, 4, 3), [0.8, 0.1, 0.05], dtype=np.float32)
            write_stage(self.root / f"r_{ev}", rgb)

    def test_empty_inputs_reject_without_replacing_previous_report(self):
        for tool in ("halo_check.py", "hue_stability.py"):
            with self.subTest(tool=tool):
                self.assert_rejected(tool)

    def test_hue_requires_all_declared_exposures_and_stages(self):
        (self.root / "r_-3").mkdir()
        self.assert_rejected("hue_stability.py", *self.hue_selection())
        (self.root / "r_0").mkdir()
        result = self.assert_rejected("hue_stability.py", *self.hue_selection())
        self.assertIn("missing 16_agx.exr", result.stderr)

    def test_duplicate_equivalent_exposure_directories_reject(self):
        self.write_hue_pair()
        write_stage(self.root / "r_+0", np.ones((4, 4, 3), dtype=np.float32))
        self.assert_rejected("hue_stability.py", *self.hue_selection())

    def test_one_exposure_cannot_claim_zero_drift(self):
        self.write_hue_pair()
        self.assert_rejected("hue_stability.py", "--primaries", "r", "--evs", "0")

    def test_real_selected_hue_pair_reports_exact_coverage(self):
        self.write_hue_pair()
        result = self.run_tool("hue_stability.py", *self.hue_selection())
        self.assertEqual(result.returncode, 0, result.stderr)
        report = json.loads(self.report.read_text())
        self.assertEqual(report["expected_cases"], 2)
        self.assertEqual(report["executed_cases"], 2)
        self.assertEqual(report["primaries"]["r"]["n_samples"], 2)
        self.assertAlmostEqual(report["primaries"]["r"]["max_drift_deg"], 0)

    def test_default_sweep_rejects_partial_primary_coverage(self):
        self.write_hue_pair()
        self.assert_rejected("hue_stability.py")

    def test_non_finite_pixels_reject_without_replacing_report(self):
        self.write_hue_pair()
        write_stage(self.root / "r_0", np.full((4, 4, 3), np.nan, dtype=np.float32))
        self.assert_rejected("hue_stability.py", *self.hue_selection())
        write_stage(self.root, np.full((32, 32, 3), np.inf, dtype=np.float32))
        self.assert_rejected("halo_check.py")

    def test_halo_requires_a_measurable_edge(self):
        write_stage(self.root, np.ones((32, 32, 3), dtype=np.float32))
        self.assert_rejected("halo_check.py")

    def test_real_disk_produces_a_finite_halo_measurement(self):
        y, x = np.mgrid[:64, :64]
        luma = np.where(np.hypot(x - 31.5, y - 31.5) < 15, 0.1, 0.8)
        write_stage(self.root, np.repeat(luma[:, :, None], 3, axis=2))
        result = self.run_tool("halo_check.py")
        self.assertEqual(result.returncode, 0, result.stderr)
        report = json.loads(self.report.read_text())
        self.assertGreater(report["profile_samples"], 0)
        self.assertAlmostEqual(report["overshoot"]["max_overshoot_pct"], 0, places=4)


if __name__ == "__main__":
    unittest.main()
