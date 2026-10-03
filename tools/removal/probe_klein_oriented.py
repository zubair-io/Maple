"""#3941: upright native Paint inference, inverse-permuted into RAW coordinates.

Shared Rust supplies every orientation operation. No source/sample rescaling,
accepted edit, sidecar write, or production model admission occurs here.
"""

import argparse
import json
from pathlib import Path

import numpy as np
from native_orientation import exact_roundtrip, orient
from native_probe_pixels import digest, save_result
from PIL import Image
from probe_klein_memory import PhaseMemory
from probe_klein_native import run

PAINT_PROMPT = (
    "Remove the object inside the selected region. "
    "Reconstruct the existing background naturally, preserving the scene's "
    "perspective, lighting, materials and photographic detail."
)


def probe(upstream, model, context_path, orientation, orientation_probe, output):
    if output.exists():
        raise ValueError("Choose a fresh diagnostic output directory")
    context = json.loads((context_path / "context.json").read_text())
    prepared = json.loads((context_path / "preparation.json").read_text())
    metadata = prepared.get("orientation")
    if (
        prepared["context"] != context
        or metadata is None
        or metadata["orientation"] != orientation
        or not metadata["raw_identity"]["decoder_verified"]
        or "blake3:" + metadata["raw_identity"]["original_blake3"]
        != context["original"]
    ):
        raise ValueError("Missing source-bound shared RAW orientation evidence")
    window = context["window"]
    height, width = window["height"], window["width"]
    if context["plate"] != "LinearCalibrationV1" or context["release_qualified"]:
        raise ValueError("Require an unqualified canonical RAW calibration context")
    nchw = np.fromfile(context_path / "input.f32", dtype="<f4")
    if nchw.size != 3 * height * width:
        raise ValueError("Canonical native input geometry differs")
    source = nchw.reshape(3, height, width).transpose(1, 2, 0).copy()
    with Image.open(context_path / "hole.png") as image:
        mask = np.asarray(image)
    with Image.open(context_path / "input.png") as image:
        proxy = np.asarray(image)
    if (
        mask.shape != (height, width)
        or not np.isin(mask, [0, 255]).all()
        or not np.isfinite(source).all()
        or source.min() < 0
        or source.max() > 1
        or not np.array_equal(np.floor(source * 255 + 0.5).astype(np.uint8), proxy)
    ):
        raise ValueError("Canonical source/proxy or binary mask differs")
    output.mkdir(parents=True, exist_ok=False)
    # Tag 1 is an identity even for channel-first bytes. Use only its input
    # digest to verify the canonical NCHW payload, never interpret it as RGB.
    _, pin = orient(
        orientation_probe, nchw.reshape(height, width, 3), 1, output, "input-pin"
    )
    if "blake3:" + pin["input_blake3"] != context["model_input"]:
        raise ValueError("Canonical model input differs from its Rust context pin")
    upright, source_rows = exact_roundtrip(
        orientation_probe, source, orientation, output, "source"
    )
    mask_rgb = (mask == 255).astype(np.float32)[:, :, None].repeat(3, axis=2)
    upright_mask, mask_rows = exact_roundtrip(
        orientation_probe, mask_rgb, orientation, output, "mask"
    )
    if upright.shape != upright_mask.shape or not np.isin(upright_mask, [0, 1]).all():
        raise ValueError("Upright source and selection geometry differ")
    upright_height, upright_width = upright.shape[:2]
    Image.fromarray(np.floor(upright * 255 + 0.5).astype(np.uint8)).save(
        output / "upright.png"
    )
    Image.fromarray((upright_mask[:, :, 0] * 255).astype(np.uint8)).save(
        output / "upright-hole.png"
    )
    upright.transpose(2, 0, 1).copy().astype("<f4").tofile(output / "upright-nchw.f32")
    generated = output / "generated"
    run(
        upstream,
        model,
        output / "upright.png",
        output / "upright-hole.png",
        (0, 0, upright_width, upright_height),
        generated,
        output / "upright-nchw.f32",
        PhaseMemory(True, True, True),
        prompt=PAINT_PROMPT,
    )
    results = {}
    for name in ["prediction", "decoder-unclipped"]:
        values = np.fromfile(generated / f"{name}.f32", dtype="<f4").reshape(
            upright_height, upright_width, 3
        )
        canonical, row = orient(
            orientation_probe, values, orientation, output, name, inverse=True
        )
        if canonical.shape != source.shape or not np.isfinite(canonical).all():
            raise ValueError("Model inverse returned invalid canonical samples")
        canonical.astype("<f4").tofile(output / f"{name}.f32")
        canonical.transpose(2, 0, 1).copy().astype("<f4").tofile(
            output / f"{name}-nchw.f32"
        )
        # The inverse must recover the complete decoder, including pre-clip bits.
        replay, _ = orient(
            orientation_probe, canonical, orientation, output, name + "-replay"
        )
        if not np.array_equal(replay.view(np.uint32), values.view(np.uint32)):
            raise ValueError("Canonical prediction replay differs from model output")
        results[name] = {"inverse": row, "replay_bits_exact": True}
    prediction = np.fromfile(output / "prediction.f32", dtype="<f4").reshape(
        source.shape
    )
    result = save_result(output, "result", prediction, source, mask == 255)
    if result["outside_float_bits_changed"]:
        raise ValueError("Canonical composite changed known source samples")
    report = {
        "orientation": orientation,
        "orientation_metadata": metadata,
        "preparation_sha256": digest(context_path / "preparation.json"),
        "context": context,
        "context_sha256": digest(context_path / "context.json"),
        "canonical_input_sha256": digest(context_path / "input.f32"),
        "canonical_mask_sha256": digest(context_path / "hole.png"),
        "shared_orientation_probe_sha256": digest(orientation_probe),
        "canonical_extent_hw": [height, width],
        "upright_extent_hw": [upright_height, upright_width],
        "source": source_rows,
        "mask": mask_rows,
        "outputs": results,
        "model_report_sha256": digest(generated / "report.json"),
        "result": result,
        "prediction_sha256": digest(output / "prediction.f32"),
        "decoder_unclipped_sha256": digest(output / "decoder-unclipped.f32"),
        "source_resampled": False,
        "model_input_quantized_to_u8": False,
        "releaseQualified": False,
        "scope": "Native Paint research; selection/EXIF provenance, RAW inverse, grades, subject protection and photographic acceptance require separate evidence.",
    }
    (output / "report.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report), flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ["upstream", "model", "context", "orientation-probe", "output"]:
        parser.add_argument(f"--{name}", type=Path, required=True)
    parser.add_argument("--orientation", type=int, choices=range(1, 9), required=True)
    args = parser.parse_args()
    probe(
        args.upstream,
        args.model,
        args.context,
        args.orientation,
        args.orientation_probe,
        args.output,
    )
