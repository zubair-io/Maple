"""Export pinned MobileSAM into local portable encoder/decoder artifacts (#3941)."""

import argparse
import hashlib
import importlib
import json
import subprocess
import sys
from pathlib import Path

import onnx
import torch

REVISION = "f706ad9c4eb7f219c00d9050e46328518ffb65d2"
DIGESTS = {
    "LICENSE": "c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4",
    "weights/mobile_sam.pt": "6dbb90523a35330fedd7f1d3dfc66f995213d81b29a5ca8108dbcdd4e37d6c2f",
}


def sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def load_model(source):
    revision = subprocess.check_output(
        ["git", "-C", str(source), "rev-parse", "HEAD"], text=True
    ).strip()
    if revision != REVISION or subprocess.check_output(
        ["git", "-C", str(source), "diff", "HEAD", "--"], text=True
    ):
        raise ValueError("MobileSAM source differs from pinned clean revision")
    for name, expected in DIGESTS.items():
        if sha256(source / name) != expected:
            raise ValueError(f"MobileSAM checksum mismatch: {name}")
    sys.path.insert(0, str(source))
    model = importlib.import_module("mobile_sam").sam_model_registry["vit_t"]()
    weights = torch.load(
        source / "weights/mobile_sam.pt", map_location="cpu", weights_only=True
    )
    model.load_state_dict(weights, strict=True)
    return model.eval()


class PhotographicEncoder(torch.nn.Module):
    """Upstream pixel normalization, with RGB float input in the 0..255 domain."""

    def __init__(self, model):
        super().__init__()
        self.encoder = model.image_encoder
        self.register_buffer("mean", model.pixel_mean)
        self.register_buffer("std", model.pixel_std)

    def forward(self, image):
        return self.encoder((image - self.mean) / self.std)


def export(source, output):
    torch.set_num_threads(4)
    model = load_model(source)
    wrapper = importlib.import_module("mobile_sam.utils.onnx").SamOnnxModel
    encoder = PhotographicEncoder(model).eval()
    decoder = wrapper(model, return_single_mask=False).eval()
    output.mkdir(parents=True, exist_ok=True)
    inputs = {
        "image_embeddings": torch.zeros(1, 256, 64, 64),
        "point_coords": torch.tensor([[[400.0, 500.0], [600.0, 500.0], [0.0, 0.0]]]),
        "point_labels": torch.tensor([[1.0, 0.0, -1.0]]),
        "mask_input": torch.zeros(1, 1, 256, 256),
        "has_mask_input": torch.zeros(1),
        "orig_im_size": torch.tensor([1024.0, 1024.0]),
    }
    artifacts = [
        (
            "encoder",
            encoder,
            (torch.zeros(1, 3, 1024, 1024),),
            ["image"],
            ["image_embeddings"],
            None,
        ),
        (
            "decoder",
            decoder,
            tuple(inputs.values()),
            list(inputs),
            ["masks", "iou_predictions", "low_res_masks"],
            {"point_coords": {1: "num_points"}, "point_labels": {1: "num_points"}},
        ),
    ]
    for name, module, values, input_names, output_names, dynamic in artifacts:
        path = output / f"mobile-sam-{name}.onnx"
        with torch.inference_mode():
            torch.onnx.export(
                module,
                values,
                str(path),
                input_names=input_names,
                output_names=output_names,
                dynamic_axes=dynamic,
                opset_version=17,
                dynamo=False,
                external_data=False,
            )
        onnx.checker.check_model(str(path), full_check=True)
        manifest = {
            "source": "https://github.com/ChaoningZhang/MobileSAM",
            "source_revision": REVISION,
            "source_digests": DIGESTS,
            "license": "Apache-2.0",
            "artifact_sha256": sha256(path),
            "torch": torch.__version__,
            "onnx": onnx.__version__,
            "opset": 17,
            "input": "Fixed photographic RGB 1024 square float 0..255; native ROI or aspect-preserved padded proxy prepared by caller",
            "prompts": "0 negative, 1 positive, 2/3 box corners, -1 padding; point coordinates in the encoder plane",
            "release_qualified": False,
            "qualification": "Portable export only; photographic/native/browser/device gates remain",
        }
        path.with_suffix(".json").write_text(json.dumps(manifest, indent=2) + "\n")
    (output / "LICENSE").write_bytes((source / "LICENSE").read_bytes())


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path)
    export(**vars(parser.parse_args()))


if __name__ == "__main__":
    main()
