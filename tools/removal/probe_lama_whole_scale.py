"""#3941 research: whole-object model-scale diagnostic, never app admission.

The source is the existing canonical 2048 RAW context. Model RGB is explicitly
2x box-resampled, the hole is conservatively pooled, and generated output is
bilinearly interpolated. This is not native-detail inference or independent
tile reconstruction. Shared Rust baking still restores native known/protected
pixels and revalidates source/masks. No XMP or shipping model policy changes.
"""

import argparse
import hashlib
import json
import resource
import sys
import time
from pathlib import Path

import blake3
import numpy as np
from PIL import Image
from probe_lama_large_scene import SIDE, load_inputs, sha256

MODEL_SIDE = 1024
ARTIFACT_SHA256 = "339d078d9d1376d76a49efd4fa42f328c3f276af775505ae8b57c84db187c4f6"


def prepare(raw, context):
    pins = json.loads((context / "inputs.json").read_text())
    original = "blake3:" + blake3.blake3(raw.read_bytes()).hexdigest()
    if original != pins["source"]["original"]:
        raise ValueError("Original differs from source-bound RAW context")
    native = load_inputs(context)
    rgb = np.fromfile(context / "input.f32", dtype="<f4").reshape(1, 3, SIDE, SIDE)
    hole = native[:, 3:4]
    pooled_rgb = rgb.reshape(1, 3, MODEL_SIDE, 2, MODEL_SIDE, 2).mean(axis=(3, 5))
    pooled_hole = hole.reshape(1, 1, MODEL_SIDE, 2, MODEL_SIDE, 2).max(axis=(3, 5))
    covered = np.repeat(np.repeat(pooled_hole, 2, axis=2), 2, axis=3)
    if np.any(covered < hole):
        raise ValueError("Model-scale hole dropped native selected pixels")
    inputs = np.concatenate([pooled_rgb * (1 - pooled_hole), pooled_hole], axis=1)
    return (
        inputs,
        rgb,
        hole,
        {
            "rawSHA256": sha256(raw),
            "sourceAnchor": pins["source"],
            "intent": pins["intent"],
            "protected": pins["protected"],
            "contextFilesSHA256": {
                p.name: sha256(p) for p in sorted(context.iterdir()) if p.is_file()
            },
            "nativeHolePixels": int(hole.sum()),
            "modelHolePixels": int(pooled_hole.sum()),
            "nativeHolePixelsLost": int(np.count_nonzero((hole == 1) & (covered == 0))),
            "extraNativePixelsInPooledCells": int(np.count_nonzero(covered > hole)),
            "modelInputSHA256": hashlib.sha256(inputs.tobytes()).hexdigest(),
        },
    )


def interpolate(result, rgb, hole):
    if (
        result.shape != (1, 3, MODEL_SIDE, MODEL_SIDE)
        or result.dtype != np.float32
        or not np.isfinite(result).all()
        or result.min() < 0
        or result.max() > 1
    ):
        raise ValueError("Invalid model-scale float output")
    expanded = np.stack(
        [
            np.asarray(
                Image.fromarray(channel).resize(
                    (SIDE, SIDE), resample=Image.Resampling.BILINEAR
                )
            )
            for channel in result[0]
        ]
    )[None]
    return np.where(hole == 1, expanded, rgb).astype("<f4")


def run(args):
    if args.output.exists():
        raise ValueError("Choose a fresh model-scale research output")
    if sha256(args.artifact) != ARTIFACT_SHA256:
        raise ValueError("Unpinned LaMa 1024 artifact")
    inputs, rgb, hole, evidence = prepare(args.raw, args.context)
    if args.engine == "runtime":
        import onnxruntime as ort

        if ort.__version__ != "1.23.2":
            raise ValueError("Use pinned deployment ORT 1.23.2")
        options = ort.SessionOptions()
        options.intra_op_num_threads = 4
        options.inter_op_num_threads = 1
        model = ort.InferenceSession(
            str(args.artifact), sess_options=options, providers=["CPUExecutionProvider"]
        )
        if model.get_inputs()[0].shape != [1, 4, MODEL_SIDE, MODEL_SIDE]:
            raise ValueError("Model tensor geometry differs")
        started = time.perf_counter()
        result = model.run(None, {"masked_image_and_mask": inputs})[0]
        version = ort.__version__
    else:
        import torch
        from export_lama_native import load_generator

        torch.set_num_threads(4)
        model = load_generator(args.source, args.checkpoint, args.config)
        started = time.perf_counter()
        with torch.inference_mode():
            result = model(torch.from_numpy(inputs)).numpy()
        version = torch.__version__
    elapsed = time.perf_counter() - started
    replacement = interpolate(result, rgb, hole)
    args.output.mkdir()
    result.astype("<f4").tofile(args.output / "model-result.f32")
    replacement.tofile(args.output / "result.f32")
    report = {
        **evidence,
        "engine": args.engine,
        "version": version,
        "artifactSHA256": ARTIFACT_SHA256,
        "sourceSHA256": sha256(Path(__file__)),
        "modelResultSHA256": sha256(args.output / "model-result.f32"),
        "resultSHA256": sha256(args.output / "result.f32"),
        "canonicalSourceExtent": [SIDE, SIDE],
        "modelInputExtent": [MODEL_SIDE, MODEL_SIDE],
        "modelInputResampled": True,
        "rgbReduction": "Float32 mean of each 2x2 block before masking",
        "holeReduction": "2x2 maximum: all native intent remains represented",
        "outputInterpolation": "Pillow F-mode bilinear 1024 to 2048, native known RGB restored exactly",
        "knownModelRGBSamplesChanged": int(
            np.count_nonzero(
                replacement[hole.repeat(3, axis=1) == 0]
                != rgb[hole.repeat(3, axis=1) == 0]
            )
        ),
        "seconds": elapsed,
        "processPeakRSSBytes": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
        * (1 if sys.platform == "darwin" else 1024),
        "measurementScope": "Separate CPU Python owner on shared host; not app or supported-device performance",
        "releaseQualified": False,
        "nativeDetailQualified": False,
    }
    (args.output / "report.json").write_text(json.dumps(report, indent=2) + "\n")
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("engine", choices=["runtime", "reference"])
    for name in [
        "source",
        "checkpoint",
        "config",
        "artifact",
        "raw",
        "context",
        "output",
    ]:
        parser.add_argument(name, type=Path)
    print(json.dumps(run(parser.parse_args()), indent=2))
