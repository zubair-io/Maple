import json
import subprocess
import sys
import tempfile
import unittest
import venv
from pathlib import Path

from PIL import Image


class QualificationParityTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="maple parity [test] ")
        self.addCleanup(self.temp.cleanup)
        self.work = Path(self.temp.name)
        (self.work / "cpu").mkdir()
        self.exported = self.work / "production export [one].tiff"
        for path in (
            self.work / "app-frame.png",
            self.work / "ref-frame.png",
            self.exported,
        ):
            Image.new("RGB", (16, 12), (100, 120, 140)).save(path)
        (self.work / "cpu" / "export-result.json").write_text(
            json.dumps({"output": str(self.exported)})
        )

    def run_driver(self, *args):
        driver = Path(__file__).with_name("qualification-parity.py")
        return subprocess.run(
            [sys.executable, str(driver), str(self.work), *args],
            capture_output=True,
            text=True,
        )

    def test_equal_images_with_space_and_bracket_paths_pass(self):
        result = self.run_driver()
        self.assertEqual(result.returncode, 0, result.stderr)
        verdict = json.loads((self.work / "parity-verdict.json").read_text())
        self.assertEqual(verdict["mean_budget"], 2.0)
        for name in ("preview", "export", "preview-export"):
            metric = json.loads((self.work / f"{name}-diff.json").read_text())
            self.assertEqual(metric["mean_deltaE"], 0)
            self.assertEqual(metric["n_pixels"], 192)
            self.assertFalse(verdict[name.replace("-", "_") + "_parity_failed"])

    def test_failed_preview_does_not_hide_passing_export(self):
        Image.new("RGB", (16, 12), "red").save(self.work / "app-frame.png")
        result = self.run_driver()
        self.assertEqual(result.returncode, 1, result.stderr)
        verdict = json.loads((self.work / "parity-verdict.json").read_text())
        self.assertTrue(verdict["preview_parity_failed"])
        self.assertTrue(verdict["preview_export_parity_failed"])
        self.assertFalse(verdict["export_parity_failed"])

    def test_export_dimensions_cannot_be_resized_into_a_pass(self):
        Image.new("RGB", (8, 6), (100, 120, 140)).save(self.exported)
        result = self.run_driver()
        self.assertEqual(result.returncode, 2)
        self.assertIn("dimensions", result.stderr)
        self.assertFalse((self.work / "parity-verdict.json").exists())

    def test_missing_image_removes_stale_passing_verdict(self):
        self.assertEqual(self.run_driver().returncode, 0)
        self.exported.unlink()
        self.assertEqual(self.run_driver().returncode, 2)
        self.assertFalse((self.work / "parity-verdict.json").exists())

    def test_invalid_budget_is_a_tooling_failure(self):
        for budget in ("nan", "inf", "-1"):
            with self.subTest(budget=budget):
                result = self.run_driver("--budget", budget)
                self.assertEqual(result.returncode, 2)
                self.assertFalse((self.work / "parity-verdict.json").exists())

    def test_real_interpreter_path_with_spaces(self):
        interpreter_root = self.work / "Python interpreter [one]"
        venv.EnvBuilder(with_pip=False, system_site_packages=True).create(
            interpreter_root
        )
        executable = interpreter_root / (
            "Scripts/python.exe" if sys.platform == "win32" else "bin/python"
        )
        result = subprocess.run(
            [
                str(executable),
                str(Path(__file__).with_name("qualification-parity.py")),
                str(self.work),
            ],
            capture_output=True,
            text=True,
        )
        self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == "__main__":
    unittest.main()
