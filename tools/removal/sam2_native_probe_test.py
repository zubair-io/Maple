"""#3941: actual fixture identity refusals before any SAM2 model execution.

Pass the same seven input paths as probe_sam2_people, without an output path.
The real RAW/source/model/proxy/MIMF files are required; nothing skip-passes.
"""

import argparse
import json
import shutil
import tempfile
import unittest
from pathlib import Path

from probe_sam2_people import preflight, run


class ActualSAM2InputTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.paths = dict(INPUTS)
        # Keep real referenced masks/proxy/report bytes in an isolated directory.
        report = self.root / "inputs" / "report.json"
        report.parent.mkdir()
        records = json.loads(self.paths["report_path"].read_text())["detectedMasks"]
        for name in ["report.json", "selection-proxy.rgb8"] + [
            r["file"] for r in records
        ]:
            shutil.copyfile(
                self.paths["report_path"].parent / name, report.parent / name
            )
        self.paths["report_path"] = report
        for key in ["points_path", "pins_path"]:
            destination = self.root / (key + ".json")
            shutil.copyfile(self.paths[key], destination)
            self.paths[key] = destination

    def change_json(self, key, edit):
        value = json.loads(self.paths[key].read_text())
        edit(value)
        self.paths[key].write_text(json.dumps(value) + "\n")

    def refuses(self, reason):
        destination = self.root / "no-publication"
        with self.assertRaisesRegex(ValueError, reason):
            run(**self.paths, output=destination)
        self.assertFalse(destination.exists(), "No model execution/publication prefix")

    def test_real_original_inputs_and_all_mask_records_validate(self):
        paths = {k: v for k, v in self.paths.items() if k != "shared_probe"}
        _, native, _, original, proxy, retained = preflight(**paths)
        self.assertEqual(len(retained), len(native["detected"]))
        self.assertEqual(original, INPUTS["raw"].read_bytes())
        self.assertEqual(len(proxy), 3 * 1024 * 683)

    def test_wrong_original_refuses_before_inference(self):
        self.paths["raw"] = self.root / "changed.nef"
        self.paths["raw"].write_bytes(b"changed original")
        self.refuses("identity changed")

    def test_changed_proxy_refuses_before_inference(self):
        path = self.paths["report_path"].parent / "selection-proxy.rgb8"
        data = bytearray(path.read_bytes())
        data[0] ^= 1
        path.write_bytes(data)
        self.refuses("identity changed")

    def test_other_report_points_refuse_before_inference(self):
        self.change_json("points_path", lambda v: v.update(nativeReportSHA256="0" * 64))
        self.refuses("identity changed")

    def test_outside_point_refuses_before_inference(self):
        self.change_json(
            "points_path", lambda v: v["cases"][0]["positive"].append([1024, 0])
        )
        self.refuses("Invalid visible")

    def test_unverified_model_bytes_refuse_before_inference(self):
        self.change_json("pins_path", lambda v: v.update(weightsSHA256="0" * 64))
        self.refuses("weights changed")

    def test_changed_upstream_source_refuses_before_inference(self):
        self.change_json(
            "pins_path", lambda v: v["files"].update({"sam2/build_sam.py": "0" * 64})
        )
        self.refuses("source file changed")

    def test_corrupt_retained_mask_refuses_before_inference(self):
        record = json.loads(self.paths["report_path"].read_text())["detectedMasks"][0]
        path = self.paths["report_path"].parent / record["file"]
        data = bytearray(path.read_bytes())
        data[-1] ^= 1
        path.write_bytes(data)
        self.refuses("mask digest differs")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    for name in [
        "report_path",
        "raw",
        "source",
        "weights",
        "points_path",
        "pins_path",
        "shared_probe",
    ]:
        parser.add_argument(name, type=Path)
    INPUTS = vars(parser.parse_args())
    unittest.main(argv=["sam2_native_probe_test"], verbosity=2)
