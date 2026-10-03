"""#3941: source-bound upright PowerPaint floats, back to canonical RAW pixels.

Research only. Shared Rust permutes every source/mask/decoder sample. The RAW
baker must independently reject invalid decoder ranges; no clipping or resize.
"""

import argparse
import json
from pathlib import Path

import numpy as np
from native_orientation import exact_roundtrip, orient
from native_probe_pixels import digest, float_source, native_context
from PIL import Image


def prepare(context_path, orientation, orientation_probe, output):
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
        or context["plate"] != "LinearCalibrationV1"
        or context["release_qualified"]
    ):
        raise ValueError("Missing source-bound shared RAW orientation evidence")
    height, width = context["window"]["height"], context["window"]["width"]
    proxy, hole = native_context(
        context_path / "input.png", context_path / "hole.png", (0, 0, width, height)
    )
    source = float_source(context_path / "input.f32", proxy)
    planes_path = context_path / "masks.f32"
    if planes_path.stat().st_size != 2 * height * width * 4:
        raise ValueError("Shared generation plane geometry differs")
    planes = np.fromfile(planes_path, dtype="<f4").reshape(2, height, width)
    if (
        not np.isfinite(planes).all()
        or not np.array_equal(planes[0], hole.astype(np.float32))
        or not np.isin(planes[0], [0, 1]).all()
        or planes[1].min() < 0
        or planes[1].max() > 1
        or int(hole.sum()) != prepared["hole_pixels"]
        or int((planes[1] > 0).sum()) != prepared["coverage_pixels"]
    ):
        raise ValueError("Canonical hole differs from shared generation evidence")
    output.mkdir(parents=True, exist_ok=False)
    # Identity permutation supplies Rust's input digest of the original NCHW
    # bytes. Never use the tag1 output's fictitious channel layout as pixels.
    nchw = np.fromfile(context_path / "input.f32", dtype="<f4")
    _, pin = orient(
        orientation_probe, nchw.reshape(height, width, 3), 1, output, "input-pin"
    )
    if "blake3:" + pin["input_blake3"] != context["model_input"]:
        raise ValueError("Canonical model input differs from its Rust context pin")
    upright, source_rows = exact_roundtrip(
        orientation_probe, source, orientation, output, "source"
    )
    mask_rgb = hole.astype(np.float32)[:, :, None].repeat(3, axis=2)
    upright_mask, mask_rows = exact_roundtrip(
        orientation_probe, mask_rgb, orientation, output, "mask"
    )
    if upright.shape != upright_mask.shape or not np.isin(upright_mask, [0, 1]).all():
        raise ValueError("Upright source and selection geometry differ")
    Image.fromarray(np.floor(upright * 255 + 0.5).astype(np.uint8)).save(
        output / "upright.png"
    )
    Image.fromarray((upright_mask[:, :, 0] * 255).astype(np.uint8)).save(
        output / "upright-hole.png"
    )
    upright.transpose(2, 0, 1).copy().astype("<f4").tofile(output / "upright-nchw.f32")
    report = {
        "orientation": orientation,
        "orientation_metadata": metadata,
        "preparation_sha256": digest(context_path / "preparation.json"),
        "context": context,
        "context_sha256": digest(context_path / "context.json"),
        "canonical_input_sha256": digest(context_path / "input.f32"),
        "canonical_mask_sha256": digest(context_path / "hole.png"),
        "canonical_generation_planes_sha256": digest(planes_path),
        "shared_orientation_probe_sha256": digest(orientation_probe),
        "canonical_extent_hw": [height, width],
        "upright_extent_hw": list(upright.shape[:2]),
        "source": source_rows,
        "mask": mask_rows,
        "source_resampled": False,
        "model_input_quantized_to_u8": False,
        "releaseQualified": False,
    }
    return source, hole, report


def restore(generated, source, hole, orientation, orientation_probe, output):
    height, width = source.shape[:2]
    upright_height, upright_width = (
        (width, height) if orientation >= 5 else (height, width)
    )
    results = {}
    for name in ("decoder-model", "raw-candidate"):
        path = generated / f"{name}-nchw.f32"
        if path.stat().st_size != 3 * height * width * 4:
            raise ValueError("Model output differs from native context geometry")
        values = np.fromfile(path, dtype="<f4").reshape(
            3, upright_height, upright_width
        )
        values = values.transpose(1, 2, 0).copy()
        if not np.isfinite(values).all():
            raise ValueError("Nonfinite actual model decoder or candidate")
        canonical, row = orient(
            orientation_probe, values, orientation, output, name, inverse=True
        )
        replay, _ = orient(
            orientation_probe, canonical, orientation, output, name + "-replay"
        )
        if canonical.shape != source.shape or not np.array_equal(
            replay.view(np.uint32), values.view(np.uint32)
        ):
            raise ValueError("Canonical decoder replay changed actual model bits")
        if name == "raw-candidate" and not np.array_equal(
            canonical[~hole].view(np.uint32), source[~hole].view(np.uint32)
        ):
            raise ValueError("Canonical candidate changed known source samples")
        target = output / f"{name}-nchw.f32"
        canonical.transpose(2, 0, 1).copy().astype("<f4").tofile(target)
        results[name] = {
            "inverse": row,
            "replay_bits_exact": True,
            "canonical_sha256": digest(target),
            "clamped": False,
            "out_of_model_range_samples": int(
                np.count_nonzero((canonical < 0) | (canonical > 1))
            ),
        }
    return results


def probe(model, upstream, context, orientation, orientation_probe, output):
    # Loading the actual runtime is deferred so source/provenance guards can be
    # tested without loading several GB of model weights or allocating a GPU.
    from probe_powerpaint_native import run

    source, hole, report = prepare(context, orientation, orientation_probe, output)
    upright_height, upright_width = report["upright_extent_hw"]
    generated = output / "generated"
    run(
        model,
        upstream,
        output / "upright.png",
        output / "upright-hole.png",
        (0, 0, upright_width, upright_height),
        generated,
        output / "upright-nchw.f32",
    )
    report["outputs"] = restore(
        generated, source, hole, orientation, orientation_probe, output
    )
    report["model_report_sha256"] = digest(generated / "report.json")
    report["outside_float_bits_changed"] = 0
    report["scope"] = (
        "Actual native upright PowerPaint float inference and exact canonical "
        "inverse. Independent RAW range validation, grading, photographic "
        "quality and deployed Mac adapter qualification remain required."
    )
    (output / "report.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report), flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("model", "upstream", "context", "orientation-probe", "output"):
        parser.add_argument(f"--{name}", type=Path, required=True)
    parser.add_argument("--orientation", type=int, choices=range(1, 9), required=True)
    args = parser.parse_args()
    probe(
        args.model,
        args.upstream,
        args.context,
        args.orientation,
        args.orientation_probe,
        args.output,
    )
