"""#3941: measured 2048 native texture votes guided by the pinned 1024 LaMa.

SDR public-RAW diagnostic only. No app model/limit or accepted edit is changed.
"""

import argparse
import hashlib
import json
import resource
import sys
import time
from pathlib import Path

import numpy as np
import onnxruntime as ort
from guided_native_patches import refine
from PIL import Image


def digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def source_hole(rectangle, mask_path):
    if (rectangle is None) == (mask_path is None):
        raise ValueError("Choose one native rectangle or binary mask")
    if mask_path is not None:
        with Image.open(mask_path) as image:
            values = np.asarray(image)
        if values.shape != (2048, 2048) or not np.isin(values, [0, 255]).all():
            raise ValueError("Expected a native 2048-square single-channel 0/255 mask")
        hole = values == 255
    else:
        x, y, width, height = rectangle
        if (
            min(x, y) < 0
            or min(width, height) < 1
            or x + width > 2048
            or y + height > 2048
        ):
            raise ValueError("Hole must fit inside the native context")
        hole = np.zeros((2048, 2048), dtype=np.bool_)
        hole[y : y + height, x : x + width] = True
    if not hole.any() or hole.all():
        raise ValueError(
            "Reconstruction needs selected pixels and known source context"
        )
    return hole


def run(artifact, image_path, rectangle, output, mask_path=None):
    hole = source_hole(rectangle, mask_path)
    pins = json.loads(
        Path(__file__).with_name("removal-models.generated.json").read_text()
    )
    pin = next(model for model in pins if model["id"] == "lama")
    if artifact.stat().st_size != pin["size"] or digest(artifact) != pin["sha256"]:
        raise ValueError("Model differs from the generated reconstruction pin")
    with Image.open(image_path) as image:
        source_u8 = np.asarray(image.convert("RGB"))
    if source_u8.shape != (2048, 2048, 3):
        raise ValueError("This experiment requires a native 2048-square SDR context")
    source = source_u8.astype(np.float32) / np.float32(255)
    coarse_rgb = source.reshape(1024, 2, 1024, 2, 3).mean(axis=(1, 3))
    coarse_hole = hole.reshape(1024, 2, 1024, 2).any(axis=(1, 3))
    inputs = np.concatenate(
        [
            coarse_rgb.transpose(2, 0, 1) * (~coarse_hole)[None],
            coarse_hole[None].astype(np.float32),
        ],
        axis=0,
    )[None]
    options = ort.SessionOptions()
    options.intra_op_num_threads = 4
    options.inter_op_num_threads = 1
    started = time.perf_counter()
    runtime = ort.InferenceSession(
        str(artifact), sess_options=options, providers=["CPUExecutionProvider"]
    )
    infer_started = time.perf_counter()
    generated = runtime.run(None, {"masked_image_and_mask": inputs})[0]
    inference_ms = (time.perf_counter() - infer_started) * 1000
    if (
        generated.shape != (1, 3, 1024, 1024)
        or not np.isfinite(generated).all()
        or generated.min() < 0
        or generated.max() > 1
    ):
        raise ValueError("Invalid coarse model result")
    coarse = coarse_rgb.copy()
    coarse[coarse_hole] = generated[0].transpose(1, 2, 0)[coarse_hole]
    guide = np.stack(
        [
            np.asarray(
                Image.fromarray(coarse[:, :, c]).resize(
                    (2048, 2048), Image.Resampling.BILINEAR
                )
            )
            for c in range(3)
        ],
        axis=2,
    ).astype(np.float32)
    guide[~hole] = source[~hole]
    refinement_started = time.perf_counter()
    result, report = refine(source, hole, guide)
    refinement_ms = (time.perf_counter() - refinement_started) * 1000
    generation_ms = (time.perf_counter() - started) * 1000
    output.mkdir(parents=True, exist_ok=False)
    np.ascontiguousarray(result, dtype="<f4").tofile(output / "result.f32")
    np.ascontiguousarray(guide, dtype="<f4").tofile(output / "guide.f32")
    result_u8 = np.rint(result * 255).astype(np.uint8)
    Image.fromarray(result_u8).save(output / "native-votes.png")
    Image.fromarray(np.rint(guide * 255).astype(np.uint8)).save(
        output / "coarse-guide.png"
    )
    Image.fromarray(hole.astype(np.uint8) * 255).save(output / "hole.png")
    inside = (
        hole[1:-1, 1:-1]
        & hole[1:-1, :-2]
        & hole[1:-1, 2:]
        & hole[:-2, 1:-1]
        & hole[2:, 1:-1]
    )

    def detail(image):
        laplace = (
            4 * image[1:-1, 1:-1]
            - image[1:-1, :-2]
            - image[1:-1, 2:]
            - image[:-2, 1:-1]
            - image[2:, 1:-1]
        )
        return float(np.abs(laplace[inside]).mean()) if inside.any() else None

    ys, xs = np.nonzero(hole)
    report.update(
        {
            "source_path": str(image_path),
            "source_sha256": digest(image_path),
            "model_sha256": pin["sha256"],
            "checkpoint_sha256": pin["checkpoint_sha256"],
            "model_source_revision": pin["source_revision"],
            "rectangle": list(rectangle) if rectangle is not None else None,
            "mask_path": str(mask_path) if mask_path is not None else None,
            "mask_sha256": digest(mask_path) if mask_path is not None else None,
            "hole_bounds_xywh": [
                int(xs.min()),
                int(ys.min()),
                int(xs.max() - xs.min() + 1),
                int(ys.max() - ys.min() + 1),
            ],
            "native_extent": [2048, 2048],
            "guide_extent": [1024, 1024],
            "coarse_inference_ms": inference_ms,
            "native_refinement_ms": refinement_ms,
            "model_open_through_refinement_ms": generation_ms,
            "peak_rss_bytes": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
            * (1 if sys.platform == "darwin" else 1024),
            "memory_scope": "Python ORT wheel, model open, coarse tensors and native patch voting in one process",
            "onnxruntime": ort.__version__,
            "providers": runtime.get_providers(),
            "native_hole_mean_absolute_laplacian": detail(result),
            "guide_hole_mean_absolute_laplacian": detail(guide),
            "outside_changed_u8_samples": int(
                np.count_nonzero(result_u8[~hole] != source_u8[~hole])
            ),
            "result_sha256": digest(output / "result.f32"),
            "guide_sha256": digest(output / "guide.f32"),
            "qualification": "Single RGB-guide/native-vote diagnostic; no semantic/depth guides, auto-curation, canonical RAW conversion or release quality claim",
        }
    )
    if (
        report["outside_changed_samples"]
        or report["outside_changed_u8_samples"]
        or report["invalid_donors"]
    ):
        raise ValueError("Native source/donor invariant failed")
    (output / "report.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--artifact", type=Path, required=True)
    parser.add_argument("--image", type=Path, required=True)
    selection = parser.add_mutually_exclusive_group(required=True)
    selection.add_argument("--hole", type=int, nargs=4, metavar=("X", "Y", "W", "H"))
    selection.add_argument("--mask", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    run(
        args.artifact,
        args.image,
        tuple(args.hole) if args.hole else None,
        args.output,
        args.mask,
    )
