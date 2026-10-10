"""Compare pinned portable LaMa inference with its PyTorch reference (#3941)."""

import argparse
import json
import time
from pathlib import Path

import numpy as np
import onnxruntime as ort
import torch
from export_lama_native import load_generator, sha256
from PIL import Image


def probe(source, checkpoint, config, artifact, images, output, hole=None):
    manifest = json.loads(artifact.with_suffix(".json").read_text())
    if manifest["artifact_sha256"] != sha256(artifact):
        raise ValueError("Portable model checksum mismatch")
    size = manifest["native_size"]
    if size not in (512, 1024, 2048):
        raise ValueError("Unsupported native qualification extent")
    bounds = hole if hole is not None else (size // 2 - 100, size // 2 - 100, 200, 200)
    x, y, width, height = bounds
    if (
        min(x, y) < 0
        or min(width, height) <= 0
        or x + width > size
        or y + height > size
    ):
        raise ValueError("Qualification hole is outside the native context")
    if width == size and height == size:
        raise ValueError("Qualification requires known context")
    model = load_generator(source, checkpoint, config)
    torch.set_num_threads(4)
    options = ort.SessionOptions()
    options.intra_op_num_threads = 4
    options.inter_op_num_threads = 1
    runtime = ort.InferenceSession(
        str(artifact), sess_options=options, providers=["CPUExecutionProvider"]
    )
    if runtime.get_inputs()[0].shape != [1, 4, size, size]:
        raise ValueError("Portable model input differs from its native manifest")
    output.mkdir(parents=True, exist_ok=True)
    cases = []
    for path in images:
        with Image.open(path) as opened:
            if opened.size != (size, size):
                raise ValueError(
                    f"Probe requires a native {size}px context, without resampling"
                )
            image = np.asarray(opened.convert("RGB")).copy()
        rgb = image.transpose(2, 0, 1)[None].astype(np.float32) / 255
        mask = np.zeros((1, 1, size, size), dtype=np.float32)
        mask[:, :, y : y + height, x : x + width] = 1
        inputs = np.concatenate([rgb * (1 - mask), mask], axis=1)
        with torch.inference_mode():
            expected = model(torch.from_numpy(inputs)).numpy()
        started = time.perf_counter()
        actual = runtime.run(None, {"masked_image_and_mask": inputs})[0]
        elapsed = (time.perf_counter() - started) * 1000
        if actual.shape != rgb.shape or not np.isfinite(actual).all():
            raise ValueError("Portable model output shape or finiteness check failed")
        error = np.abs(actual - expected)
        actual_path = output / f"{path.stem}-onnx.f32"
        reference_path = output / f"{path.stem}-torch.f32"
        actual.astype("<f4").tofile(actual_path)
        expected.astype("<f4").tofile(reference_path)
        integer = (
            (actual[0].transpose(1, 2, 0) * 255).round().clip(0, 255).astype(np.uint8)
        )
        reference = (
            (expected[0].transpose(1, 2, 0) * 255).round().clip(0, 255).astype(np.uint8)
        )
        integer_error = int(np.abs(integer.astype(int) - reference.astype(int)).max())
        if integer_error > 1:
            raise ValueError("Portable model differs by more than one SDR code value")
        result = image.copy()
        result[y : y + height, x : x + width] = integer[y : y + height, x : x + width]
        Image.fromarray(result).save(output / f"{path.stem}-lama-onnx.png")
        cases.append(
            {
                "image": path.name,
                "image_sha256": sha256(path),
                "native_size": size,
                "onnx_f32_sha256": sha256(actual_path),
                "torch_f32_sha256": sha256(reference_path),
                "hole": list(bounds),
                "hole_pixels": width * height,
                "known_pixels": size * size - width * height,
                "elapsed_ms": elapsed,
                "max_float_error_vs_torch": float(error.max()),
                "mean_float_error_vs_torch": float(error.mean()),
                "max_u8_error_vs_torch": integer_error,
                "outside_mask_max_error": int(
                    np.abs(result.astype(int) - image.astype(int))[
                        mask[0, 0] == 0
                    ].max()
                ),
            }
        )
    report = {
        "artifact_sha256": manifest["artifact_sha256"],
        "onnxruntime": ort.__version__,
        "cases": cases,
        "release_qualified": False,
        "qualification": "SDR execution probe; fixed scene anchor, HDR inverse, browser and device gates remain",
        "memory_scope": "This process loads the PyTorch reference and ONNX runtime together; measure runtime-only memory separately before device admission.",
    }
    (output / "report.json").write_text(json.dumps(report, indent=2) + "\n")
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("checkpoint", type=Path)
    parser.add_argument("config", type=Path)
    parser.add_argument("artifact", type=Path)
    parser.add_argument("output_directory", type=Path)
    parser.add_argument("images", type=Path, nargs="+")
    parser.add_argument(
        "--hole", type=int, nargs=4, metavar=("X", "Y", "WIDTH", "HEIGHT")
    )
    args = parser.parse_args()
    print(
        json.dumps(
            probe(
                args.source,
                args.checkpoint,
                args.config,
                args.artifact,
                args.images,
                args.output_directory,
                args.hole,
            ),
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
