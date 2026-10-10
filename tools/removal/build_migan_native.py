"""Reproducible, pinned MI-GAN native-context candidates for #3941.

This is model qualification tooling, not an editor runtime or a release
approval. The upstream graph accepts arbitrary dimensions but resizes its
reconstruction input to 512. Static 512/1024 candidates process that context
size directly; convolution weights stay unchanged. Frozen spatial noise is
periodically extended, so perceptual qualification remains necessary.
"""

import argparse
import hashlib
import json
import shutil
from pathlib import Path

import numpy as np
import onnx
from onnx import numpy_helper

SOURCE_SHA256 = "593eba0b7e04730f1b61c0a3cbca68d97d8d6a7ff5c6a44a7b9d7fcd880fc5ae"
LICENSE_SHA256 = "674e33456b8d03693b84ab305aa7372d93c91e68b234651b0adad106d518e6eb"
SOURCE_URL = (
    "https://huggingface.co/andraniksargsyan/migan/resolve/"
    "406830d0fa60666da0071c342ad2fbc8f30c5c64/migan.onnx"
)
NOISE_NAMES = {
    "1433",
    "1438",
    "1455",
    "1460",
    "1477",
    "1482",
    "1499",
    "1504",
    "1521",
    "1526",
    "1543",
    "1548",
    "1565",
    "1570",
}


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def build(source: Path, license_path: Path, directory: Path, size: int) -> dict:
    if size not in (512, 1024):
        raise ValueError(
            "Only the qualified build experiment sizes 512 and 1024 are supported"
        )
    if sha256(source) != SOURCE_SHA256:
        raise ValueError("MI-GAN source does not match the pinned upstream artifact")
    if sha256(license_path) != LICENSE_SHA256:
        raise ValueError(
            "Weights license does not match the pinned upstream MIT notice"
        )
    model = onnx.load(source)
    if len(model.graph.node) != 708 or len(model.graph.initializer) != 344:
        raise ValueError("Pinned graph inventory changed")
    tensors = {tensor.name: tensor for tensor in model.graph.initializer}
    filters = {name for name in tensors if name.endswith("filter_const")}
    if len(filters) != 14 or not NOISE_NAMES.issubset(tensors):
        raise ValueError("Pinned spatial buffers changed")
    ratio = size // 512
    spatial_names = filters | NOISE_NAMES | {"1347", "1348"}
    # Preserve every initializer outside the explicitly identified spatial
    # buffers. No learned convolution/bias/normalization tensor is altered.
    learned_before = {
        name: tensor.SerializeToString()
        for name, tensor in tensors.items()
        if name not in spatial_names
    }
    for name in sorted(spatial_names):
        tensor = tensors[name]
        array = numpy_helper.to_array(tensor)
        if name in {"1347", "1348"}:
            if array.tolist() != [512, 512]:
                raise ValueError("Pinned input resize shape changed")
            replacement = np.array([size, size], dtype=array.dtype)
        elif name in filters:
            if array.ndim != 4 or array.shape[:2] != (1, 1):
                raise ValueError("Unexpected upsampling filter dimensions")
            expected = np.zeros_like(array)
            expected[:, :, ::2, ::2] = 1
            if not np.array_equal(array, expected):
                raise ValueError("Pinned upsampling phase changed")
            replacement = np.tile(array, (1, 1, ratio, ratio))
        else:
            if array.ndim != 2 or array.shape[0] != array.shape[1]:
                raise ValueError("Unexpected frozen noise dimensions")
            replacement = np.tile(array, (ratio, ratio))
        if ratio != 1:
            tensor.CopyFrom(numpy_helper.from_array(replacement, name))
    if any(
        tensors[name].SerializeToString() != value
        for name, value in learned_before.items()
    ):
        raise ValueError("Learned weights changed")
    for value, dimensions in (
        (model.graph.input[0], [1, 3, size, size]),
        (model.graph.input[1], [1, 1, size, size]),
        (model.graph.output[0], [1, 3, size, size]),
    ):
        for dimension, count in zip(
            value.type.tensor_type.shape.dim, dimensions, strict=True
        ):
            dimension.ClearField("dim_param")
            dimension.dim_value = count
    if [value.name for value in model.graph.input] != ["image", "mask"]:
        raise ValueError("Pinned input contract changed")
    onnx.checker.check_model(model, full_check=True)
    directory.mkdir(parents=True, exist_ok=True)
    artifact = directory / f"migan-native-{size}.onnx"
    temporary = artifact.with_suffix(".onnx.tmp")
    onnx.save(model, temporary)
    temporary.replace(artifact)
    shutil.copyfile(license_path, directory / "LICENSE-WEIGHTS")
    report = {
        "build_recipe": "maple-migan-static-native-v1",
        "upstream_url": SOURCE_URL,
        "upstream_sha256": SOURCE_SHA256,
        "upstream_code_revision": "2b793c5ece43f4253e32d4afc257120a5deed6f5",
        "license_sha256": LICENSE_SHA256,
        "artifact": artifact.name,
        "artifact_sha256": sha256(artifact),
        "size": size,
        "input": "uint8 NCHW RGB, mask 0=remove 255=known",
        "output": "uint8 NCHW RGB, native square context",
        "learned_initializers_unchanged": len(learned_before),
        "noise_extension": "periodic" if ratio != 1 else "unchanged",
        "release_qualified": False,
        "toolchain": {"onnx": onnx.__version__, "numpy": np.__version__},
    }
    artifact.with_suffix(".json").write_text(json.dumps(report, indent=2) + "\n")
    return report


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("weights_license", type=Path)
    parser.add_argument("output_directory", type=Path)
    parser.add_argument("--size", type=int, choices=(512, 1024), default=1024)
    args = parser.parse_args()
    print(
        json.dumps(
            build(args.source, args.weights_license, args.output_directory, args.size),
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
