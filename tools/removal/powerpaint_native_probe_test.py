"""Actual source/model identity guards and official removal task conditioning."""

import ast
import json
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np
import torch
from native_probe_pixels import digest
from PIL import Image
from probe_powerpaint_native import NEGATIVE, POSITIVE, load_bin, run, verify_artifacts
from transformers import CLIPTextConfig, CLIPTextModel

PINS = json.loads(
    Path(__file__).with_name("powerpaint-research-models.json").read_text()
)
SOURCE = Path("/tmp/maple-removal-powerpaint-source")
MODEL = Path("/tmp/maple-removal-models/powerpaint-v2-1-native")


class PowerPaintNativeProbeTests(unittest.TestCase):
    def test_actual_learned_tokens_keep_live_parameter_references(self):
        if not MODEL.exists() or not SOURCE.exists():
            self.skipTest("Actual pinned PowerPaint artifacts are not installed")
        for item in PINS["sourceFiles"]:
            self.assertEqual(digest(SOURCE / item["path"]), item["sha256"])
        sys.path.insert(0, str(SOURCE))
        from powerpaint.utils.utils import TokenizerWrapper, add_tokens

        base = MODEL / "realisticVisionV60B1_v51VAE"
        base_weights = base / "text_encoder/pytorch_model.bin"
        trained = MODEL / "PowerPaint_Brushnet/pytorch_model.bin"
        for path in (base_weights, trained):
            pin = next(
                item
                for item in PINS["files"]
                if item["path"] == str(path.relative_to(MODEL))
            )
            self.assertEqual(digest(path), pin["sha256"])
        text = CLIPTextModel(
            CLIPTextConfig.from_pretrained(base / "text_encoder", local_files_only=True)
        )
        load_bin(text, base_weights)
        tokenizer = TokenizerWrapper(
            from_pretrained=str(base), subfolder="tokenizer", local_files_only=True
        )
        add_tokens(tokenizer, text, ["P_ctxt", "P_shape", "P_obj"], ["a", "a", "a"], 10)
        load_bin(text, trained)
        state = torch.load(trained, map_location="cpu", weights_only=True, mmap=True)
        embedding = text.text_model.embeddings.token_embedding
        for external in embedding.external_embeddings:
            name = external["name"]
            self.assertIs(external["embedding"], embedding.trainable_embeddings[name])
            self.assertTrue(
                torch.equal(
                    external["embedding"],
                    state[
                        f"text_model.embeddings.token_embedding.trainable_embeddings.{name}"
                    ],
                )
            )

    def test_changed_upstream_source_refuses_before_model_io(self):
        first = PINS["sourceFiles"][0]
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = root / first["path"]
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b"!" * first["bytes"])
            with self.assertRaisesRegex(ValueError, "identity mismatch"):
                verify_artifacts(root / "absent", root)

    def test_real_artifacts_with_changed_license_record_refuse(self):
        if not MODEL.exists() or not SOURCE.exists():
            self.skipTest("Actual pinned PowerPaint artifacts are not installed")
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for item in PINS["files"]:
                destination = root / item["path"]
                destination.parent.mkdir(parents=True, exist_ok=True)
                os.link(MODEL / item["path"], destination)
            for item in PINS["licenseRecords"]:
                shutil.copyfile(MODEL / item["path"], root / item["path"])
            with (root / PINS["licenseRecords"][0]["path"]).open("ab") as stream:
                stream.write(b"\nChanged license fixture\n")
            with self.assertRaisesRegex(ValueError, "identity mismatch"):
                verify_artifacts(root, SOURCE)

    def test_prompt_matches_verified_upstream_removal_controller(self):
        if not SOURCE.exists():
            self.skipTest("Actual pinned PowerPaint source is not installed")
        app = SOURCE / "app.py"
        pin = next(item for item in PINS["sourceFiles"] if item["path"] == "app.py")
        self.assertEqual(digest(app), pin["sha256"])
        function = next(
            node
            for node in ast.parse(app.read_text()).body
            if isinstance(node, ast.FunctionDef) and node.name == "add_task"
        )
        namespace = {}
        # Execute only this reviewed function from the digest-verified controller.
        exec(
            compile(ast.Module(body=[function], type_ignores=[]), str(app), "exec"),
            namespace,
        )  # noqa: S102
        self.assertEqual(
            namespace["add_task"](" empty scene blur", "", "object-removal", "ppt-v2"),
            (POSITIVE, POSITIVE, NEGATIVE, NEGATIVE),
        )

    def test_partial_selection_refuses_before_model_io_and_output_creation(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            image_path, mask_path = root / "source.png", root / "mask.png"
            Image.new("RGB", (2048, 2048), (80, 100, 120)).save(image_path)
            mask = np.zeros((2048, 2048), dtype=np.uint8)
            mask[600:1800, 700:1000] = 255
            Image.fromarray(mask).save(mask_path)
            output = root / "output"
            with self.assertRaisesRegex(ValueError, "entire selection"):
                run(
                    root / "absent",
                    root / "absent",
                    image_path,
                    mask_path,
                    (0, 0, 1024, 1024),
                    output,
                )
            self.assertFalse(output.exists())


if __name__ == "__main__":
    unittest.main()
