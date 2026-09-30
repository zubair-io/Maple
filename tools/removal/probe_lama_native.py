"""Compare pinned portable LaMa inference with its PyTorch reference (#3941)."""

import argparse
import json
import time
from pathlib import Path

import numpy as np
import onnxruntime as ort
import torch
from PIL import Image

from export_lama_native import load_generator, sha256


def probe(source, checkpoint, config, artifact, images, output):
    manifest = json.loads(artifact.with_suffix(".json").read_text())
    if manifest["artifact_sha256"] != sha256(artifact):
        raise ValueError("Portable model checksum mismatch")
    model = load_generator(source, checkpoint, config)
    torch.set_num_threads(4)
    options = ort.SessionOptions()
    options.intra_op_num_threads = 4
    options.inter_op_num_threads = 1
    runtime = ort.InferenceSession(
        str(artifact), sess_options=options, providers=["CPUExecutionProvider"]
    )
    output.mkdir(parents=True, exist_ok=True)
    cases = []
    for path in images:
        with Image.open(path) as opened:
            if opened.size != (1024, 1024):
                raise ValueError(
                    "Probe requires a native 1024px context, without resampling"
                )
            image = np.asarray(opened.convert("RGB")).copy()
        rgb = image.transpose(2, 0, 1)[None].astype(np.float32) / 255
        mask = np.zeros((1, 1, 1024, 1024), dtype=np.float32)
        mask[:, :, 412:612, 412:612] = 1
        inputs = np.concatenate([rgb * (1 - mask), mask], axis=1)
        with torch.inference_mode():
            expected = model(torch.from_numpy(inputs)).numpy()
        started = time.perf_counter()
        actual = runtime.run(None, {"masked_image_and_mask": inputs})[0]
        elapsed = (time.perf_counter() - started) * 1000
        if actual.shape != rgb.shape or not np.isfinite(actual).all():
            raise ValueError("Portable model output shape or finiteness check failed")
        error = np.abs(actual - expected)
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
        result[412:612, 412:612] = integer[412:612, 412:612]
        Image.fromarray(result).save(output / f"{path.stem}-lama-onnx.png")
        cases.append(
            {
                "image": path.name,
                "image_sha256": sha256(path),
                "native_size": 1024,
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
            ),
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
