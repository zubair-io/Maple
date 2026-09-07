"""Objective controls for the coherent-source seam metric (#3243)."""

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np
from pano_ghost_metrics import coherent_residual, measure
from PIL import Image


def moving_subjects():
    """Two positions of the same textured object on the same static background."""
    first = np.full((48, 64, 3), 0.125)
    yy, xx = np.indices((24, 12))
    texture = np.repeat((0.5 + 0.375 * ((xx + yy) % 2))[..., None], 3, axis=2)
    second = first.copy()
    first[12:36, 12:24] = texture
    second[12:36, 36:48] = texture
    return first, second


def blur(image):
    padded = np.pad(image, ((1, 1), (1, 1), (0, 0)), mode="edge")
    return (
        sum(
            padded[y : y + image.shape[0], x : x + image.shape[1]]
            for y in range(3)
            for x in range(3)
        )
        / 9.0
    )


class CoherentGhostMetricTests(unittest.TestCase):
    def setUp(self):
        self.first, self.second = moving_subjects()
        self.sources = {"early": self.first, "late": self.second}

    def test_either_whole_capture_is_a_clean_answer(self):
        for image in self.sources.values():
            result = coherent_residual(image, self.sources)
            self.assertEqual(result["photo_rmse"], 0)
            self.assertEqual(result["gradient_rmse"], 0)

            self.assertGreater(result["source_disagreement_rmse"], 0.1)

    def test_shifted_blend_and_blurred_ghost_are_worse_than_clean_capture(self):
        ghost = (self.first + self.second) / 2
        for image in (ghost, blur(ghost), blur(self.first)):
            result = coherent_residual(image, self.sources)
            self.assertGreater(result["photo_rmse"], 0.01)
            self.assertGreater(result["gradient_rmse"], 0.01)

    def test_pixelwise_source_selection_would_falsely_accept_doubled_subject(self):
        doubled = np.maximum(self.first, self.second)
        per_pixel = np.minimum(abs(doubled - self.first), abs(doubled - self.second))
        self.assertEqual(float(per_pixel.max()), 0)
        result = coherent_residual(doubled, self.sources)
        self.assertGreater(result["photo_rmse"], 0.1)
        self.assertGreater(result["gradient_rmse"], 0.1)

    def test_source_order_does_not_change_score_or_selected_source(self):
        candidate = self.first * 0.6 + self.second * 0.4
        self.assertEqual(
            coherent_residual(candidate, self.sources),
            coherent_residual(candidate, dict(reversed(list(self.sources.items())))),
        )

    def test_detail_loss_blocks_blur_that_improves_both_residuals(self):
        doubled = np.maximum(self.first, self.second)
        before = coherent_residual(doubled, self.sources)
        softened = coherent_residual(blur(doubled), self.sources)
        self.assertLess(softened["photo_rmse"], before["photo_rmse"])
        self.assertLess(softened["gradient_rmse"], before["gradient_rmse"])
        self.assertEqual(before["detail_loss_rmse"], 0)
        self.assertGreater(softened["detail_loss_rmse"], 0.05)

    def test_invalid_or_static_evidence_fails_closed(self):
        cases = [
            {"only": self.first},
            {"a": self.first, "b": self.first.copy()},
            {"a": self.first, "b": self.second[:20]},
            {"a": self.first, "b": self.second * np.nan},
        ]
        for sources in cases:
            with self.assertRaises(ValueError):
                coherent_residual(self.first, sources)

    def test_real_png_manifest_roundtrip_and_candidate_name_invariance(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name, pixels in self.sources.items():
                Image.fromarray((pixels * 255).astype(np.uint8)).convert("RGBA").save(
                    root / f"{name}.png"
                )
            candidate = root / "strategy-a.png"
            candidate.write_bytes((root / "early.png").read_bytes())
            renamed = root / "strategy-b.png"
            renamed.write_bytes(candidate.read_bytes())
            roi = {
                "name": "moving-object",
                "subject": "Union of both observed positions of one textured object",
                "rect": [0, 0, 64, 48],
                "sources": [
                    {"name": "early", "path": "early.png"},
                    {"name": "late", "path": "late.png"},
                ],
            }
            manifest = root / "evidence.json"
            manifest.write_text(
                json.dumps({"version": 1, "canvas_size": [64, 48], "rois": [roi]})
            )
            result = measure(candidate, manifest)
            self.assertEqual(result, measure(renamed, manifest))
            self.assertEqual(result["roi_count"], 1)
            self.assertEqual(result["roi_pixels"], 64 * 48)
            self.assertEqual(result["photo_rmse"], 0)
            self.assertEqual(result["gradient_rmse"], 0)

            command = [
                sys.executable,
                str(Path(__file__).with_name("pano_metrics.py")),
                "--candidate",
                str(candidate),
                "--reference",
                str(root / "early.png"),
                "--ghost-evidence",
                str(manifest),
            ]
            completed = subprocess.run(
                command, check=True, capture_output=True, text=True
            )
            self.assertEqual(json.loads(completed.stdout)["ghosting"], result)

            with Image.open(root / "early.png") as image:
                alpha = image.copy()
                alpha.putpixel((10, 10), (0, 0, 0, 0))
                alpha.save(root / "early.png")
            with self.assertRaisesRegex(ValueError, "coverage alpha"):
                measure(candidate, manifest)
            rejected = subprocess.run(
                command, check=False, capture_output=True, text=True
            )
            self.assertEqual(rejected.returncode, 2)
            self.assertIn("coverage alpha", json.loads(rejected.stdout)["error"])
            Image.fromarray((self.first * 255).astype(np.uint8)).save(
                root / "early.png"
            )
            with self.assertRaisesRegex(ValueError, "coverage alpha"):
                measure(candidate, manifest)

            roi["rect"] = [0, 0, 65, 48]
            manifest.write_text(
                json.dumps({"version": 1, "canvas_size": [64, 48], "rois": [roi]})
            )
            with self.assertRaisesRegex(ValueError, "outside"):
                measure(candidate, manifest)


if __name__ == "__main__":
    unittest.main()
