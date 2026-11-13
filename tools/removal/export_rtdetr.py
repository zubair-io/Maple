"""Export pinned RT-DETRv2 R18 person detection using real upstream modules (#3941)."""

import argparse
import hashlib
import importlib
import json
import subprocess
import sys
import types
from pathlib import Path

import onnx
import torch
import yaml

REVISION = "29320b6fd828f8e0987a71426cf2d961b09dfed7"
CHECKPOINT = "2ace52184b620204004509b72752ac7bfe64aadaf7fc1d076b18df8ab5a5c77e"
DIGESTS = {
    "LICENSE": "c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4",
    "rtdetrv2_pytorch/configs/rtdetrv2/rtdetrv2_r18vd_120e_coco.yml": "93182eb778c58346e31b947dec4cb7e673373d3d93210d271a10cc1c6043a1e9",
    "rtdetrv2_pytorch/configs/rtdetrv2/include/rtdetrv2_r50vd.yml": "57b7fe0920b8c3046f66981f503045023ec68cff0148c88caf7b1e40c9b117c4",
}


def sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def load_model(source, checkpoint):
    revision = subprocess.check_output(
        ["git", "-C", str(source), "rev-parse", "HEAD"], text=True
    ).strip()
    if revision != REVISION or subprocess.check_output(
        ["git", "-C", str(source), "diff", "HEAD", "--"], text=True
    ):
        raise ValueError("RT-DETR source differs from pinned clean revision")
    for name, expected in DIGESTS.items():
        if sha256(source / name) != expected:
            raise ValueError(f"RT-DETR source checksum mismatch: {name}")
    if sha256(checkpoint) != CHECKPOINT:
        raise ValueError("RT-DETR checkpoint checksum mismatch")
    root = source / "rtdetrv2_pytorch"
    # Namespace containers skip the training package initializers, which import
    # COCO datasets, TensorBoard and optimizers. All executed model and registry
    # implementations remain the pinned, unmodified upstream Python modules.
    for name in (
        "src",
        "src.core",
        "src.nn",
        "src.nn.backbone",
        "src.zoo",
        "src.zoo.rtdetr",
    ):
        package = types.ModuleType(name)
        package.__path__ = [str(root / name.replace(".", "/"))]
        sys.modules[name] = package
    registry = importlib.import_module("src.core.workspace")
    sys.modules["src.core"].register = registry.register
    backbone_class = importlib.import_module("src.nn.backbone.presnet").PResNet
    encoder_class = importlib.import_module(
        "src.zoo.rtdetr.hybrid_encoder"
    ).HybridEncoder
    decoder_class = importlib.import_module(
        "src.zoo.rtdetr.rtdetrv2_decoder"
    ).RTDETRTransformerv2
    model_class = importlib.import_module("src.zoo.rtdetr.rtdetr").RTDETR
    post_class = importlib.import_module(
        "src.zoo.rtdetr.rtdetr_postprocessor"
    ).RTDETRPostProcessor
    base = yaml.safe_load(
        (root / "configs/rtdetrv2/include/rtdetrv2_r50vd.yml").read_text()
    )
    override = yaml.safe_load(
        (root / "configs/rtdetrv2/rtdetrv2_r18vd_120e_coco.yml").read_text()
    )
    backbone_args = base["PResNet"] | override["PResNet"] | {"pretrained": False}
    encoder_args = (
        base["HybridEncoder"]
        | override["HybridEncoder"]
        | {"eval_spatial_size": [640, 640]}
    )
    decoder_args = (
        base["RTDETRTransformerv2"]
        | override["RTDETRTransformerv2"]
        | {"eval_spatial_size": [640, 640], "num_classes": 80}
    )
    model = model_class(
        backbone=backbone_class(**backbone_args),
        encoder=encoder_class(**encoder_args),
        decoder=decoder_class(**decoder_args),
    )
    weights = torch.load(checkpoint, weights_only=True, map_location="cpu")
    model.load_state_dict(weights["ema"]["module"], strict=True)
    model.deploy()
    return Detector(model, post_class(**base["RTDETRPostProcessor"]).deploy()).eval()


class Detector(torch.nn.Module):
    def __init__(self, model, postprocessor):
        super().__init__()
        self.model = model
        self.postprocessor = postprocessor

    def forward(self, images, orig_target_sizes):
        return self.postprocessor(self.model(images), orig_target_sizes)


def export(source, checkpoint, output):
    torch.set_num_threads(4)
    model = load_model(source, checkpoint)
    output.mkdir(parents=True, exist_ok=True)
    path = output / "rtdetrv2-r18.onnx"
    with torch.inference_mode():
        torch.onnx.export(
            model,
            (
                torch.zeros(1, 3, 640, 640),
                torch.tensor([[640, 640]], dtype=torch.int64),
            ),
            str(path),
            input_names=["images", "orig_target_sizes"],
            output_names=["labels", "boxes", "scores"],
            opset_version=17,
            dynamo=False,
            external_data=False,
        )
    onnx.checker.check_model(str(path), full_check=True)
    manifest = {
        "source": "https://github.com/lyuwenyu/RT-DETR",
        "source_revision": REVISION,
        "source_digests": DIGESTS,
        "checkpoint": "https://github.com/lyuwenyu/storage/releases/download/v0.2/rtdetrv2_r18vd_120e_coco_rerun_48.1.pth",
        "checkpoint_sha256": CHECKPOINT,
        "artifact_sha256": sha256(path),
        "license": "Apache-2.0",
        "torch": torch.__version__,
        "onnx": onnx.__version__,
        "opset": 17,
        "input": "Upstream evaluation: photographic RGB resize to 640x640, float 0..1, no mean/std normalization; orig_target_sizes is [width,height] for XYXY scaling",
        "output": "Top 300 detections; contiguous COCO class person=0, source-space XYXY boxes, sigmoid scores; filtering and protection are caller policy",
        "release_qualified": False,
        "qualification": "Portable export only; real person detection, recall, protection, browser and physical-device gates remain",
    }
    path.with_suffix(".json").write_text(json.dumps(manifest, indent=2) + "\n")
    (output / "LICENSE").write_bytes((source / "LICENSE").read_bytes())


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("source", "checkpoint", "output"):
        parser.add_argument(name, type=Path)
    export(**vars(parser.parse_args()))


if __name__ == "__main__":
    main()
