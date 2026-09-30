"""Run pinned LaMa against Rust's native float photographic context (#3941)."""

import argparse
import json
import time
from pathlib import Path

import numpy as np
import onnxruntime as ort
import torch

from export_lama_native import load_generator, sha256


def probe(source, checkpoint, config, artifact, context, output):
    manifest = json.loads(artifact.with_suffix(".json").read_text())
    if manifest["artifact_sha256"] != sha256(artifact):
        raise ValueError("Portable model checksum mismatch")
    recipe = json.loads((context / "context.json").read_text())
    if recipe["window"]["width"] != 1024 or recipe["window"]["height"] != 1024:
        raise ValueError("Expected native 1024 context")
    path = context / "input.f32"
    rgb = np.fromfile(path, dtype="<f4").reshape(1, 3, 1024, 1024)
    if not np.isfinite(rgb).all() or rgb.min() < 0 or rgb.max() > 1:
        raise ValueError("Input lies outside the model's float domain")
    mask = np.zeros((1, 1, 1024, 1024), dtype=np.float32)
    mask[:, :, 412:612, 412:612] = 1
    inputs = np.concatenate([rgb * (1 - mask), mask], axis=1)
    model = load_generator(source, checkpoint, config)
    torch.set_num_threads(4)
    with torch.inference_mode():
        expected = model(torch.from_numpy(inputs)).numpy()
    options = ort.SessionOptions()
    options.intra_op_num_threads = 4
    options.inter_op_num_threads = 1
    runtime = ort.InferenceSession(
        str(artifact), sess_options=options, providers=["CPUExecutionProvider"]
    )
    started = time.perf_counter()
    actual = runtime.run(None, {"masked_image_and_mask": inputs})[0]
    elapsed = (time.perf_counter() - started) * 1000
    if actual.shape != rgb.shape or not np.isfinite(actual).all():
        raise ValueError("Model output shape or finiteness check failed")
    if actual.min() < 0 or actual.max() > 1:
        raise ValueError("Model output exceeds the reversible recipe domain")
    error = np.abs(actual - expected)
    # Execution diagnostic established on the SDR probes. Scene-space
    # error after the shared Rust inverse is separately reported, not
    # inferred from this photographic-domain bound.
    if error.max() > 1 / 255:
        raise ValueError("Portable execution differs by more than one SDR code")
    output.mkdir(parents=True, exist_ok=True)
    result = output / "result.f32"
    actual.astype("<f4").tofile(result)
    expected.astype("<f4").tofile(output / "reference.f32")
    report = {
        "artifact_sha256": manifest["artifact_sha256"],
        "input_sha256": sha256(path),
        "result_sha256": sha256(result),
        "onnxruntime": ort.__version__,
        "elapsed_ms": elapsed,
        "input_min": float(rgb.min()),
        "input_max": float(rgb.max()),
        "max_float_error_vs_torch": float(error.max()),
        "mean_float_error_vs_torch": float(error.mean()),
        "release_qualified": False,
        "qualification": "Float model execution diagnostic; use Rust scene bake and photographic/device gates",
    }
    (output / "report.json").write_text(json.dumps(report, indent=2) + "\n")
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("checkpoint", type=Path)
    parser.add_argument("config", type=Path)
    parser.add_argument("artifact", type=Path)
    parser.add_argument("context", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    print(json.dumps(probe(**vars(args)), indent=2))


if __name__ == "__main__":
    main()
