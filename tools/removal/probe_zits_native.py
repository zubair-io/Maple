"""#3941: structure-conditioned ZITS research on shared native RAW f32.

No app model admission, image upload, RAW mutation or output RGB resizing.
The entire selected hole is reconstructed at native1024, with exact shared
upright/inverse permutations and bit-preserved source outside the hole.
"""

import argparse
import json
import random
import resource
import time
from pathlib import Path

import numpy as np
import torch
from native_orientation import exact_roundtrip, orient
from native_probe_pixels import digest
from PIL import Image
from probe_aot_native import inputs
from zits_native_upstream import PINS_PATH, load, predict, unchanged, verify


def run(source, checkpoints, context, output, orientation_probe=None):
    if output.exists():
        raise ValueError("Choose a fresh ZITS research output directory")
    pins = verify(source, checkpoints)
    rgb, hole, recipe = inputs(context)
    preparation = json.loads((context / "preparation.json").read_text())
    metadata = preparation["orientation"]
    orientation = metadata["orientation"]
    if (
        preparation["context"] != recipe
        or not metadata["raw_identity"]["decoder_verified"]
        or "blake3:" + metadata["raw_identity"]["original_blake3"] != recipe["original"]
        or orientation not in range(1, 9)
        or (orientation != 1 and orientation_probe is None)
    ):
        raise ValueError("Missing source-bound shared RAW orientation evidence")
    torch.set_num_threads(4)
    torch.manual_seed(3407)
    np.random.seed(3407)
    random.seed(3407)
    models, states, helpers = load(source, checkpoints)
    output.mkdir(parents=True)
    upright, upright_hole = rgb, hole
    orientation_rows = None
    if orientation != 1:
        pixels, source_rows = exact_roundtrip(
            orientation_probe,
            rgb[0].transpose(1, 2, 0).copy(),
            orientation,
            output,
            "source",
        )
        mask_pixels, mask_rows = exact_roundtrip(
            orientation_probe,
            np.repeat(hole[0, 0, :, :, None], 3, axis=2),
            orientation,
            output,
            "hole",
        )
        upright = pixels.transpose(2, 0, 1)[None].copy()
        upright_hole = mask_pixels[:, :, 0][None, None].copy()
        orientation_rows = {"source": source_rows, "hole": mask_rows}
    started = time.perf_counter()
    with torch.inference_mode():
        predicted, phases = predict(models, helpers, upright, upright_hole, output)
    elapsed = time.perf_counter() - started
    if (
        predicted.shape != rgb.shape
        or not np.isfinite(predicted).all()
        or predicted.min() < 0
        or predicted.max() > 1
    ):
        raise ValueError("ZITS returned invalid native shape or samples")
    unchanged(models, states)
    prediction = predicted
    if orientation != 1:
        pixels, inverse_row = orient(
            orientation_probe,
            predicted[0].transpose(1, 2, 0).copy(),
            orientation,
            output,
            "prediction",
            inverse=True,
        )
        prediction = pixels.transpose(2, 0, 1)[None].copy()
        orientation_rows["prediction_inverse"] = inverse_row
    candidate = np.where(hole == 1, prediction, rgb)
    outside = np.broadcast_to(hole == 0, rgb.shape)
    if not np.array_equal(
        candidate[outside].view(np.uint32), rgb[outside].view(np.uint32)
    ):
        raise ValueError("ZITS candidate changed known native float samples")
    prediction.astype("<f4").tofile(output / "prediction.f32")
    candidate.astype("<f4").tofile(output / "result.f32")
    for name, values in (("source", rgb), ("candidate", candidate)):
        pixels = np.floor(values[0].transpose(1, 2, 0) * 255 + 0.5).astype(np.uint8)
        Image.fromarray(pixels).save(output / f"{name}.png")
    report = {
        "source_revision": pins["revision"],
        "pins_sha256": digest(PINS_PATH),
        "model_tensors": {name: len(state) for name, state in states.items()},
        "model_parameters": {
            name: sum(v.numel() for v in state.values())
            for name, state in states.items()
        },
        "weights_unchanged_after_documented_half_cast": True,
        "context_sha256": digest(context / "context.json"),
        "masks_sha256": digest(context / "masks.json"),
        "source_anchor": recipe["source_anchor"],
        "orientation": orientation,
        "orientation_metadata": metadata,
        "orientation_rows": orientation_rows,
        "orientation_probe_sha256": digest(orientation_probe)
        if orientation != 1
        else None,
        "native_extent_hw": [1024, 1024],
        "selected_pixels": int(hole.sum()),
        "input_sha256": digest(context / "input.f32"),
        "result_sha256": digest(output / "result.f32"),
        "prediction_sha256": digest(output / "prediction.f32"),
        "outside_float_bits_changed": 0,
        "inference_seconds": elapsed,
        "phases": phases,
        "process_peak_rss_bytes_macos": resource.getrusage(
            resource.RUSAGE_SELF
        ).ru_maxrss,
        "torch": torch.__version__,
        "device": "cpu",
        "seed": 3407,
        "upstream_adapter": "Only three wireframe .to(0) calls select CPU; training wrapper replaced by direct exact learned modules and published forward equations. TSR explicitly half, all other modules f32.",
        "guidance": "Published uint8 proxies at256/512; Canny sigma3, wireframe .85, TSR five iterations add.05/mul4, learned edge/line upsampling sigmoid((x+2)*2). Native FTR input remains shared f32; this differs from upstream file input quantization and is recorded, not a numerical parity claim.",
        "releaseQualified": False,
        "scope": "Actual full ZITS structure-conditioned native1024 reconstruction. One uncontrolled CPU point; RAW inverse, photographic quality, native app/export, supported-device and distribution admission remain separate gates.",
    }
    (output / "report.json").write_text(json.dumps(report, indent=2) + "\n")
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("source", "checkpoints", "context", "output"):
        parser.add_argument(f"--{name}", type=Path, required=True)
    parser.add_argument("--orientation-probe", type=Path)
    print(json.dumps(run(**vars(parser.parse_args())), indent=2))
