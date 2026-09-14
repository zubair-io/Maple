"""Mathematical and real-file failure tests for the Whites response gate."""

import json
import tempfile
import unittest
from pathlib import Path

import numpy as np
import tone_whites_gate as gate
from PIL import Image


class WhitesResponseTests(unittest.TestCase):
    def test_spatial_masks_and_each_renderers_own_baseline(self):
        acr = np.r_[np.full(300, 10.0), np.full(300, 70.0)]
        maple = np.r_[np.full(300, 70.0), np.full(300, 10.0)]
        response = np.r_[np.full(300, 2.0), np.full(300, 8.0)]
        for sign in (1, -1):
            result = gate.measure(
                maple, maple + sign * response, acr, acr + sign * response
            )
            self.assertEqual(result["band_mae"], 0)
            self.assertEqual(result["bands"], 2)
            self.assertFalse(gate.failures(result, {"band_mae": 0.1}, sign))
            reversed_result = gate.measure(
                maple, maple - sign * response, acr, acr + sign * response
            )
            self.assertTrue(gate.failures(reversed_result, {"band_mae": 100}, sign))
            doubled = gate.measure(
                maple, maple + 2 * sign * response, acr, acr + sign * response
            )
            self.assertTrue(gate.failures(doubled, {"band_mae": 0.1}, sign))
            inactive = gate.measure(maple, maple, acr, acr + sign * response)
            self.assertTrue(gate.failures(inactive, {"band_mae": 100}, sign))

    def test_exact_white_negative_response_is_not_omitted(self):
        base = np.r_[np.full(300, 50.0), np.full(300, 100.0)]
        expected = base - 10
        correct = gate.measure(base, expected, base, expected)
        self.assertEqual(correct["band_mae"], 0)
        stuck_white = np.r_[np.full(300, 40.0), np.full(300, 100.0)]
        result = gate.measure(base, stuck_white, base, expected)
        self.assertEqual(result["bands"], 2)
        self.assertEqual(result["band_mae"], 5)
        self.assertTrue(gate.failures(result, {"band_mae": 0.1}, -1))

    def test_prepare_all_raws_absent_skips_but_partial_fails(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            entries = [
                {
                    "name": f"{f}/{c}",
                    "raw": str(root / f"{f}.dng"),
                    "xmp": str(root / f"{f}_{c}.xmp"),
                    "outputs": [
                        {"resolution": "down", "png": str(root / f"{f}_{c}.png")}
                    ],
                }
                for f in gate.FIXTURES
                for c in gate.CASES
            ]
            manifest = root / "manifest.json"
            manifest.write_text(json.dumps({"cases": entries}))
            self.assertEqual(gate.prepare(root / "filtered.json", manifest), 3)
            (root / f"{gate.FIXTURES[0]}.dng").write_bytes(
                b"partial RAW provision for integrity preflight"
            )
            with self.assertRaises((OSError, ValueError)):
                gate.prepare(root / "filtered.json", manifest)

    def test_invalid_arrays_and_reference_direction_fail(self):
        valid = np.full(300, 50.0)
        for invalid in (np.array([]), np.full(299, 50.0), np.full(300, np.nan)):
            with self.assertRaises(ValueError):
                gate.measure(valid, invalid, valid, valid + 1)
        with self.assertRaises(ValueError):
            gate.measure(valid[:10], valid[:10], valid[:10], valid[:10])
        result = gate.measure(valid, valid + 1, valid, valid - 1)
        self.assertIn(
            "wrong reference response direction",
            gate.failures(result, {"band_mae": 100}, 1),
        )

    def test_partial_and_duplicate_manifests_fail(self):
        cases = [{"name": f"{f}/{c}"} for f in gate.FIXTURES for c in gate.CASES]
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "manifest.json"
            path.write_text(json.dumps({"cases": cases}))
            self.assertEqual(len(gate.select_cases(json.loads(path.read_text()))), 54)
        with self.assertRaises(ValueError):
            gate.select_cases({"cases": cases[:-1]})
        with self.assertRaises(ValueError):
            gate.select_cases({"cases": cases + [cases[0]]})
        with self.assertRaises(ValueError):
            gate.reference_path({"name": "case", "outputs": []})

    def test_real_sidecar_and_png_integrity(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            sidecar = root / "baseline.xmp"
            sidecar.write_text('<x:xmpmeta xmlns:x="adobe:ns:meta/"/>')
            digest = gate.sha256(sidecar)
            gate.verify_file(sidecar, digest)
            sidecar.write_text(
                '<x:xmpmeta xmlns:x="adobe:ns:meta/"><changed/></x:xmpmeta>'
            )
            with self.assertRaises(ValueError):
                gate.verify_file(sidecar, digest)
            png = root / "baseline.png"
            Image.new("RGB", (2, 2), "white").save(png)
            digest = gate.sha256(png)
            Image.new("RGB", (2, 2), "black").save(png)
            with self.assertRaises(ValueError):
                gate.verify_file(png, digest)

    def test_missing_and_wrong_size_candidate_files_fail(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            provenance = {
                "fixtures": {f: {"native_size": [2, 2]} for f in gate.FIXTURES}
            }
            for fixture in gate.FIXTURES:
                for case in gate.CASES:
                    Image.new("RGB", (2, 2)).save(root / f"{fixture}_{case}.png")
            self.assertEqual(len(gate.candidate_paths(root, provenance)), 54)
            missing = root / f"{gate.FIXTURES[-1]}_{gate.CASES[-1]}.png"
            missing.unlink()
            with self.assertRaises(FileNotFoundError):
                gate.candidate_paths(root, provenance)
            Image.new("RGB", (3, 2)).save(missing)
            with self.assertRaises(ValueError):
                gate.candidate_paths(root, provenance)


if __name__ == "__main__":
    unittest.main()
