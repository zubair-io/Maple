"""Export the pinned big-LaMa generator using portable ONNX DFT (#3941).

Load the exact upstream training checkpoint with a restricted weights-only
unpickler, discard training metadata, preserve all generator tensors, and
replace only the complex FFT representation for export. Release qualification
still requires the scene plate, browser runtime and supported device gates.
"""

import argparse
import hashlib
import json
import shutil
import subprocess
import sys
import types
import typing
from pathlib import Path

import onnx
import torch
from omegaconf import OmegaConf
from omegaconf.base import ContainerMetadata, Metadata
from omegaconf.dictconfig import DictConfig
from omegaconf.listconfig import ListConfig
from omegaconf.nodes import AnyNode
from pytorch_lightning.callbacks.model_checkpoint import ModelCheckpoint

from lama_fft_onnx import portable_fourier_forward

SOURCE_REVISION = "786f5936b27fb3dacd2b1ad799e4de968ea697e7"
CHECKPOINT_SHA256 = "fccb7adffd53ec0974ee5503c3731c2c2f1e7e07856fd9228cdcc0b46fd5d423"
LICENSE_SHA256 = "4ceeeac5a802e86c413c22b16cce8e9a22027b0250c97e6f8ac97c14cf0542c0"
CONFIG_SHA256 = "4fdeed49926e13b101c4dd9e193acec9e58677dfdb4ba49dd6a3a8927964e2a7"


def sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def metadata_dictionary(*unused_factory):
    # Only discarded training metadata uses defaultdict. Retain its entries in
    # a plain dictionary so the weights-only SETITEMS restriction stays active.
    return {}


def load_generator(source: Path, checkpoint: Path, config_path: Path):
    revision = subprocess.check_output(
        ["git", "-C", str(source), "rev-parse", "HEAD"], text=True
    ).strip()
    if revision != SOURCE_REVISION or sha256(source / "LICENSE") != LICENSE_SHA256:
        raise ValueError(
            "LaMa source or Apache notice differs from the pinned revision"
        )
    if sha256(checkpoint) != CHECKPOINT_SHA256:
        raise ValueError("LaMa checkpoint does not match the pinned upstream artifact")
    if sha256(config_path) != CONFIG_SHA256:
        raise ValueError(
            "LaMa configuration does not match the pinned upstream archive"
        )
    sys.path.insert(0, str(source))
    from saicinpainting.training.modules.ffc import FFCResNetGenerator

    # Allow exactly the known metadata symbols, with no unrestricted pickle
    # loading. ModelCheckpoint is a metadata key, not an instantiated callback.
    allowed = [
        ModelCheckpoint,
        Metadata,
        ContainerMetadata,
        AnyNode,
        DictConfig,
        ListConfig,
        dict,
        list,
        int,
        typing.Any,
        (metadata_dictionary, "collections.defaultdict"),
    ]
    with torch.serialization.safe_globals(allowed):
        loaded = torch.load(checkpoint, map_location="cpu", weights_only=True)
    weights = {
        name.removeprefix("generator."): value
        for name, value in loaded["state_dict"].items()
        if name.startswith("generator.")
    }
    if len(weights) != 989 or not all(
        isinstance(value, torch.Tensor) for value in weights.values()
    ):
        raise ValueError("Pinned generator tensor inventory changed")
    config = OmegaConf.load(config_path)
    settings = OmegaConf.to_container(config.generator, resolve=True)
    if settings.pop("kind") != "ffc_resnet":
        raise ValueError("Unexpected generator architecture")
    model = FFCResNetGenerator(**settings).eval()
    model.load_state_dict(weights, strict=True)
    return model


def export(source: Path, checkpoint: Path, config_path: Path, output: Path, size: int):
    model = load_generator(source, checkpoint, config_path)
    from saicinpainting.training.modules.ffc import FourierUnit

    count = 0
    for module in model.modules():
        if isinstance(module, FourierUnit):
            module.forward = types.MethodType(portable_fourier_forward, module)
            count += 1
    if count == 0:
        raise ValueError("Pinned generator contains no Fourier units")
    torch.set_num_threads(4)
    image = torch.zeros(1, 4, size, size)
    output.mkdir(parents=True, exist_ok=True)
    artifact = output / f"lama-native-{size}.onnx"
    temporary = artifact.with_suffix(".onnx.tmp")
    with torch.inference_mode():
        torch.onnx.export(
            model,
            image,
            str(temporary),
            opset_version=17,
            dynamo=False,
            input_names=["masked_image_and_mask"],
            output_names=["generated_rgb"],
        )
    onnx.checker.check_model(onnx.load(temporary), full_check=True)
    temporary.replace(artifact)
    shutil.copyfile(source / "LICENSE", output / "LICENSE-LAMA")
    report = {
        "build_recipe": "maple-lama-standard-dft-v1",
        "source_revision": SOURCE_REVISION,
        "checkpoint_sha256": CHECKPOINT_SHA256,
        "weights_archive_url": "https://huggingface.co/smartywu/big-lama/resolve/05cb2be7f8dbe6ca7c6e78f4fc827a4b2baaa4a9/big-lama.zip",
        "weights_archive_sha256": "f1b358ca24093b93a106183b98a3dea6e8ed09f3b43ea7251eb2c81e7b4575f6",
        "license_sha256": LICENSE_SHA256,
        "config_sha256": sha256(config_path),
        "artifact": artifact.name,
        "artifact_sha256": sha256(artifact),
        "native_size": size,
        "fourier_units": count,
        "generator_tensors": 989,
        "opset": 17,
        "input": "float32 NCHW: masked RGB [0,1] then mask 1=remove, 0=known",
        "output": "float32 NCHW RGB [0,1], known pixels copied by the shared plate compositor",
        "release_qualified": False,
        "toolchain": {"torch": torch.__version__, "onnx": onnx.__version__},
    }
    artifact.with_suffix(".json").write_text(json.dumps(report, indent=2) + "\n")
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("checkpoint", type=Path)
    parser.add_argument("config", type=Path)
    parser.add_argument("output_directory", type=Path)
    parser.add_argument("--size", type=int, choices=(512, 1024), default=1024)
    args = parser.parse_args()
    print(
        json.dumps(
            export(
                args.source,
                args.checkpoint,
                args.config,
                args.output_directory,
                args.size,
            ),
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
