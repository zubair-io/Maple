"""The complete reference batch is validated before any output changes (#4784)."""

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from matrix import CASES
from PIL import Image, PngImagePlugin
from write_xmp import reference_settings

MINIMAL = b"""<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF
xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description
xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
crs:CameraProfile="Adobe Standard" crs:Unknown="preserve me"/></rdf:RDF></x:xmpmeta>"""


def save_baseline(path: Path, mode: str, temperature: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    info = PngImagePlugin.PngInfo()
    info.add_itxt(
        "XML:com.adobe.xmp",
        MINIMAL.replace(
            b"crs:Unknown=",
            f'crs:WhiteBalance="{mode}" crs:Temperature="{temperature}" crs:Tint="9" crs:Unknown='.encode(),
        ).decode(),
    )
    Image.new("RGB", (2, 2)).save(path, pnginfo=info)


def snapshot(root: Path) -> tuple[dict, set]:
    return (
        {
            str(p.relative_to(root)): p.read_bytes()
            for p in root.rglob("*")
            if p.is_file()
        },
        {str(p.relative_to(root)) for p in root.rglob("*") if p.is_dir()},
    )


class ReferenceBatchTests(unittest.TestCase):
    def test_all_fixtures_are_preflighted_before_any_existing_output_is_replaced(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            canonical = root / "test_0000" / "xmp"
            canonical.mkdir(parents=True)
            for case in CASES:
                data = MINIMAL
                if case.name in ("tint_min", "tint_max"):
                    tint = "-150" if case.name == "tint_min" else "150"
                    data = MINIMAL.replace(
                        b"crs:Unknown=",
                        f'crs:WhiteBalance="Custom" crs:Tint="{tint}" crs:Unknown='.encode(),
                    )
                (canonical / f"{case.name}.xmp").write_bytes(data)
            originals = {p: p.read_bytes() for p in canonical.glob("*.xmp")}
            raws = [root / f"test_{i:04d}.dng" for i in (1, 2)]
            for raw in raws:
                raw.write_bytes(b"RAW bytes are not decoded by reference preparation")
                for folder in ("xmp", "acr-xmp"):
                    target = root / raw.stem / folder
                    target.mkdir(parents=True)
                    (target / "baseline.xmp").write_bytes(MINIMAL)
            manifest = root / "manifest.json"
            manifest.write_text(json.dumps({"cases": [{"name": "previous/baseline"}]}))
            save_baseline(root / "test_0001/down/baseline.png", "As Shot", "4875")
            command = [
                sys.executable,
                str(Path(__file__).with_name("run.py")),
                "--raws",
                *map(str, raws),
                "--out",
                str(root),
            ]
            for mode in (None, "Custom"):
                if mode:
                    save_baseline(root / "test_0002/down/baseline.png", mode, "5350")
                before = snapshot(root)
                result = subprocess.run(command, check=False, capture_output=True)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(b"recorded As Shot", result.stderr)
                self.assertEqual(snapshot(root), before)

            save_baseline(root / "test_0002/down/baseline.png", "As Shot", "5350")
            result = subprocess.run(command, check=False, capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr.decode())
            cases = json.loads(manifest.read_text())["cases"]
            self.assertEqual(len(cases), 2 * len(CASES))
            for case in cases:
                prepared = Path(case["acr_xmp"])
                self.assertTrue(prepared.is_file())
                self.assertTrue(Path(case["xmp"]).is_file())
                for output in case["outputs"]:
                    self.assertTrue(Path(output["png"]).parent.is_dir())
                fixture, name = case["name"].split("/")
                if name in ("tint_min", "tint_max"):
                    settings = reference_settings(prepared.read_bytes())
                    expected = "4875" if fixture == "test_0001" else "5350"
                    self.assertEqual(settings["Temperature"], expected)
                    self.assertEqual(
                        settings["Tint"], "-150" if name == "tint_min" else "150"
                    )
            for path, data in originals.items():
                self.assertEqual(path.read_bytes(), data)
            for raw in raws:
                self.assertEqual(
                    raw.read_bytes(),
                    b"RAW bytes are not decoded by reference preparation",
                )


if __name__ == "__main__":
    unittest.main()
