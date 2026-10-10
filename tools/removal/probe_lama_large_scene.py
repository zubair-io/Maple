"""#3941 research: actual native RAW 2048 mask, separate CPU model owners.

Requires the Rust large-encode context and its exact source-bound MIMF masks.
Each engine runs in a separate invocation; timings/RSS describe this Python
research process, not the Mac app or supported low-memory devices.
"""

import argparse
import hashlib
import json
import resource
import struct
import sys
import time
from pathlib import Path

import blake3
import numpy as np

SIDE = 2048
ARTIFACT_SHA256 = "06c3a4fefd33e371c696ef00b0004bb8a16515d6d540f5bc2be50c219ca1c97b"


def sha256(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def checked_bytes(path, digest):
    data = path.read_bytes()
    if "blake3:" + blake3.blake3(data).hexdigest() != digest:
        raise ValueError(f"Changed source-bound bytes: {path.name}")
    return data


def mask_values(data, source):
    if len(data) < 32 or data[:8] != b"MIMF\x01\x00\x00\x00":
        raise ValueError("Invalid source-bound MIMF header")
    sw, sh, x, y, w, h = struct.unpack_from("<6I", data, 8)
    count = w * h
    if (
        [sw, sh] != [source["width"], source["height"]]
        or min(w, h) == 0
        or x + w > sw
        or y + h > sh
        or len(data) != 32 + (count + 7) // 8
        or (count % 8 and data[-1] >> (count % 8))
    ):
        raise ValueError("Invalid source-bound MIMF geometry or padding")
    values = np.unpackbits(np.frombuffer(data[32:], np.uint8), bitorder="little")
    return (x, y, w, h), values[:count].reshape(h, w).astype(bool)


def load_inputs(context):
    recipe = json.loads((context / "context.json").read_text())
    pins = json.loads((context / "inputs.json").read_text())
    preparation = json.loads((context / "preparation.json").read_text())
    window = recipe["window"]
    source = pins["source"]
    if (
        recipe["plate"] != "LinearCalibrationV1"
        or recipe["release_qualified"]
        or recipe["source_anchor"] != source
        or recipe["original"] != source["original"]
        or [recipe["source_width"], recipe["source_height"]]
        != [source["width"], source["height"]]
        or [window["width"], window["height"]] != [SIDE, SIDE]
        or min(window["x"], window["y"]) < 0
        or window["x"] + SIDE > source["width"]
        or window["y"] + SIDE > source["height"]
        or preparation["window"] != window
        or preparation["resampled"]
        or preparation["joined_tile_mismatch_channels"] != 0
        or not preparation["whole_frame_oracle"]
    ):
        raise ValueError("Expected one exact native RAW 2048 context")
    scene = checked_bytes(context / "scene.f32", recipe["scene"])
    if (
        len(scene) != SIDE * SIDE * 12
        or not np.isfinite(np.frombuffer(scene, "<f4")).all()
    ):
        raise ValueError("Invalid canonical native float scene")
    rgb = np.frombuffer(
        checked_bytes(context / "input.f32", recipe["model_input"]), "<f4"
    ).reshape(1, 3, SIDE, SIDE)
    if not np.isfinite(rgb).all() or rgb.min() < 0 or rgb.max() > 1:
        raise ValueError("Model input exceeds reversible float recipe domain")
    planes = np.fromfile(context / "masks.f32", dtype="<f4").reshape(2, SIDE, SIDE)
    hole, coverage = planes
    if (
        not np.isfinite(planes).all()
        or not np.isin(hole, [0, 1]).all()
        or not 0 < hole.sum() < SIDE * SIDE
        or int(hole.sum()) != preparation["hole_pixels"]
        or coverage.min() < 0
        or coverage.max() > 1
        or np.any(coverage[hole == 0] != 0)
    ):
        raise ValueError("Invalid shared whole-object generation masks")
    for name in ["intent", "protected"]:
        (x, y, _w, _h), values = mask_values(
            checked_bytes(context / f"{name}.mimf", pins[name]), source
        )
        ys, xs = np.nonzero(values)
        tx, ty = xs + x - window["x"], ys + y - window["y"]
        inside = (tx >= 0) & (ty >= 0) & (tx < SIDE) & (ty < SIDE)
        if name == "intent" and (
            not len(xs) or not inside.all() or np.any(hole[ty, tx] != 1)
        ):
            raise ValueError("Generation hole does not contain the entire intent")
        if name == "protected" and np.any(hole[ty[inside], tx[inside]] != 0):
            raise ValueError("Generation hole crosses explicitly kept pixels")
    mask = hole[None, None]
    return np.concatenate([rgb * (1 - mask), mask], axis=1)


def run(args):
    if args.output.exists():
        raise ValueError("Choose a fresh engine output directory")
    manifest = json.loads(args.artifact.with_suffix(".json").read_text())
    if (
        sha256(args.artifact) != ARTIFACT_SHA256
        or manifest["artifact_sha256"] != ARTIFACT_SHA256
        or manifest["native_size"] != SIDE
        or manifest["release_qualified"]
    ):
        raise ValueError("Unpinned native 2048 research artifact")
    inputs = load_inputs(args.context)
    if args.engine == "runtime":
        import onnxruntime as ort

        if ort.__version__ != "1.23.2":
            raise ValueError("Use the pinned Mac deployment runtime version")
        options = ort.SessionOptions()
        options.intra_op_num_threads = 4
        options.inter_op_num_threads = 1
        model = ort.InferenceSession(
            str(args.artifact), sess_options=options, providers=["CPUExecutionProvider"]
        )
        if model.get_inputs()[0].shape != [1, 4, SIDE, SIDE]:
            raise ValueError("Research model native extent differs")
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
    if (
        result.shape != (1, 3, SIDE, SIDE)
        or result.dtype != np.float32
        or not np.isfinite(result).all()
        or result.min() < 0
        or result.max() > 1
    ):
        raise ValueError("Invalid native float model output")
    args.output.mkdir()
    result.astype("<f4").tofile(args.output / "result.f32")
    report = {
        "engine": args.engine,
        "version": version,
        "artifactSHA256": ARTIFACT_SHA256,
        "contextFilesSHA256": {
            path.name: sha256(path) for path in sorted(args.context.iterdir())
        },
        "modelInputSHA256": hashlib.sha256(inputs.tobytes()).hexdigest(),
        "resultSHA256": sha256(args.output / "result.f32"),
        "nativeSize": SIDE,
        "seconds": elapsed,
        "processPeakRSSBytes": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
        * (1 if sys.platform == "darwin" else 1024),
        "memoryScope": "Separate Python research process with one model owner; not native app/device qualification",
        "releaseQualified": False,
    }
    (args.output / "report.json").write_text(json.dumps(report, indent=2) + "\n")
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("engine", choices=["runtime", "reference"])
    for name in ["source", "checkpoint", "config", "artifact", "context", "output"]:
        parser.add_argument(name, type=Path)
    print(json.dumps(run(parser.parse_args()), indent=2))


if __name__ == "__main__":
    main()
