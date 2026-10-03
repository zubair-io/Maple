"""#3941: native high-resolution LaMa feature-refinement diagnostic on CPU.

Calls the pinned upstream pyramid and optimization helpers unchanged. The CUDA
device dispatcher is replaced with one CPU; learned weights are frozen and
verified unchanged. SDR only, no app admission, model pin or Keep changes.
"""

import argparse
import ast
import hashlib
import json
import resource
import subprocess
import sys
import time
from pathlib import Path

import cv2
import numpy as np
import torch
from export_lama_native import SOURCE_REVISION, load_generator
from kornia.filters import gaussian_blur2d
from kornia.geometry.transform import resize
from kornia.morphology import erosion
from PIL import Image
from tqdm import tqdm

REFINEMENT_SHA256 = "f0ba8121690c3d664fdf8478c3867a304bb1f0e2581e268fcd2cc3b1216f6baa"
DEFAULTS_SHA256 = "e7733ceadd0be2210008f97b786772d10e866a6b5f7cd272d3ec5a2160e01e2c"
PIXEL_BUDGET = 1800000
ITERATIONS = 15
LEARNING_RATE = 0.002


def upstream_helpers(path):
    """Load exact verified helpers without importing unused FID/segmentation scorers."""
    if digest(path) != REFINEMENT_SHA256:
        raise ValueError("Unexpected upstream refinement helper source")
    names = {
        "_pyrdown",
        "_pyrdown_mask",
        "_erode_mask",
        "_l1_loss",
        "_infer",
        "_get_image_mask_pyramid",
    }
    functions = [
        node
        for node in ast.parse(path.read_text()).body
        if isinstance(node, ast.FunctionDef) and node.name in names
    ]
    if {node.name for node in functions} != names:
        raise ValueError("Incomplete upstream refinement helpers")
    namespace = {
        "torch": torch,
        "nn": torch.nn,
        "Adam": torch.optim.Adam,
        "gaussian_blur2d": gaussian_blur2d,
        "resize": resize,
        "erosion": erosion,
        "F": torch.nn.functional,
        "np": np,
        "cv2": cv2,
        "tqdm": tqdm,
    }
    # Only six unchanged function definitions from the SHA256-verified source.
    exec(  # noqa: S102
        compile(ast.Module(body=functions, type_ignores=[]), str(path), "exec"),
        namespace,
    )
    return namespace


def digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def weight_digest(model):
    checksum = hashlib.sha256()
    for name, tensor in sorted(model.state_dict().items()):
        checksum.update(name.encode())
        checksum.update(str((tensor.dtype, tuple(tensor.shape))).encode())
        checksum.update(tensor.detach().cpu().contiguous().numpy().tobytes())
    return checksum.hexdigest()


def native_context(image_path, mask_path, crop):
    with Image.open(image_path) as image, Image.open(mask_path) as mask:
        source = np.asarray(image.convert("RGB"))
        values = np.asarray(mask)
    if values.shape != source.shape[:2] or not np.isin(values, [0, 255]).all():
        raise ValueError("Expected a matching single-channel binary native mask")
    x, y, width, height = crop
    if (
        min(x, y) < 0
        or min(width, height) < 1024
        or max(width, height) > 2048
        or width * height > PIXEL_BUDGET
        or width % 8
        or height % 8
        or x + width > source.shape[1]
        or y + height > source.shape[0]
    ):
        raise ValueError("Native context must fit the upstream budget without resizing")
    hole = values[y : y + height, x : x + width] == 255
    if not hole.any() or hole.all():
        raise ValueError("Need selected pixels and known native context")
    if np.count_nonzero(values) != np.count_nonzero(hole):
        raise ValueError("The crop must contain the entire selection")
    native = source[y : y + height, x : x + width].copy()
    return native, hole


def save_result(output, name, result, source, hole):
    composite = source.copy()
    composite[hole] = result[hole]
    if not np.isfinite(composite).all() or composite.min() < 0 or composite.max() > 1:
        raise ValueError("Invalid SDR refinement output")
    np.ascontiguousarray(composite, dtype="<f4").tofile(output / f"{name}.f32")
    image_u8 = np.rint(composite * 255).astype(np.uint8)
    Image.fromarray(image_u8).save(output / f"{name}.png")
    return {
        "sha256": digest(output / f"{name}.f32"),
        "outside_float_bits_changed": int(
            np.count_nonzero(
                composite[~hole].view(np.uint32) != source[~hole].view(np.uint32)
            )
        ),
        "outside_u8_samples_changed": int(
            np.count_nonzero(
                image_u8[~hole] != np.rint(source[~hole] * 255).astype(np.uint8)
            )
        ),
    }


def run(source_path, checkpoint, config, image_path, mask_path, crop, output):
    native_u8, hole = native_context(image_path, mask_path, crop)
    if output.exists():
        raise ValueError("Choose a fresh diagnostic output directory")
    if (
        digest(source_path / "saicinpainting/evaluation/refinement.py")
        != REFINEMENT_SHA256
        or digest(source_path / "configs/prediction/default.yaml") != DEFAULTS_SHA256
        or subprocess.check_output(
            [
                "git",
                "-C",
                str(source_path),
                "status",
                "--porcelain",
                "--untracked-files=no",
            ],
            text=True,
        ).strip()
    ):
        raise ValueError(
            "Upstream refinement source differs from the pinned clean tree"
        )
    torch.set_num_threads(4)
    started = time.perf_counter()
    model = load_generator(source_path, checkpoint, config).requires_grad_(False)
    before = weight_digest(model)
    upstream = upstream_helpers(source_path / "saicinpainting/evaluation/refinement.py")
    from saicinpainting.training.modules.ffc import FFCResnetBlock

    split = next(
        i for i, module in enumerate(model.model) if isinstance(module, FFCResnetBlock)
    )
    front, rear = model.model[:split], model.model[split:]
    native = native_u8.astype(np.float32) / np.float32(255)
    image = torch.from_numpy(native.transpose(2, 0, 1)[None].copy())
    mask = torch.from_numpy(hole[None, None].astype(np.float32))
    height, width = hole.shape
    images, masks = upstream["_get_image_mask_pyramid"](
        {
            "image": image,
            "mask": mask,
            "unpad_to_size": [torch.tensor([height]), torch.tensor([width])],
        },
        min_side=512,
        max_scales=3,
        px_budget=PIXEL_BUDGET,
    )
    if images[-1].shape != image.shape or not torch.equal(images[-1], image):
        raise ValueError("Upstream pyramid resized the native input")
    output.mkdir(parents=True, exist_ok=False)
    Image.fromarray(native_u8).save(output / "source.png")
    Image.fromarray(hole.astype(np.uint8) * 255).save(output / "hole.png")
    steps = []
    original_loss = upstream["_l1_loss"]
    scale_index = 0
    baseline = None

    def measured_loss(
        pred,
        downscaled,
        reference,
        current_mask,
        lower_mask,
        current_image,
        on_pred=True,
    ):
        nonlocal baseline
        loss = original_loss(
            pred,
            downscaled,
            reference,
            current_mask,
            lower_mask,
            current_image,
            on_pred,
        )
        if not torch.isfinite(loss):
            raise ValueError("Non-finite upstream consistency loss")
        if scale_index == len(images) - 1 and baseline is None:
            baseline = pred.detach().cpu().numpy()[0].transpose(1, 2, 0).copy()
        step = {
            "scale": scale_index,
            "iteration": sum(s["scale"] == scale_index for s in steps) + 1,
            "loss": float(loss.detach()),
            "elapsed_ms": (time.perf_counter() - started) * 1000,
        }
        steps.append(step)
        print(json.dumps(step), flush=True)
        return loss

    upstream["_l1_loss"] = measured_loss
    result = None
    scales = []
    try:
        for scale_index, (current_image, current_mask) in enumerate(
            zip(images, masks, strict=True)
        ):
            print(
                f"Starting native scale {scale_index}: {list(current_image.shape)}",
                flush=True,
            )
            scale_started = time.perf_counter()
            result = upstream["_infer"](
                current_image,
                current_mask,
                front,
                [rear],
                result,
                current_image.shape[2:],
                [torch.device("cpu")],
                scale_index,
                n_iters=ITERATIONS,
                lr=LEARNING_RATE,
            )
            if not torch.isfinite(result).all():
                raise ValueError("Non-finite upstream prediction")
            scales.append(
                {
                    "extent_hw": list(current_image.shape[2:]),
                    "elapsed_ms": (time.perf_counter() - scale_started) * 1000,
                }
            )
            if scale_index == 0:
                Image.fromarray(
                    np.rint(result.numpy()[0].transpose(1, 2, 0) * 255).astype(np.uint8)
                ).save(output / "coarse.png")
    finally:
        upstream["_l1_loss"] = original_loss
    generation_ms = (time.perf_counter() - started) * 1000
    if baseline is None or weight_digest(model) != before:
        raise ValueError("Missing native comparison or changed trained weights")
    final = result.numpy()[0].transpose(1, 2, 0)
    outputs = {
        name: save_result(output, name, values, native, hole)
        for name, values in [("baseline", baseline), ("refined", final)]
    }
    report = {
        "source_revision": SOURCE_REVISION,
        "checkpoint_sha256": digest(checkpoint),
        "refinement_source_sha256": REFINEMENT_SHA256,
        "defaults_sha256": DEFAULTS_SHA256,
        "learned_state_sha256_before_and_after": before,
        "weights_changed": False,
        "image_sha256": digest(image_path),
        "mask_sha256": digest(mask_path),
        "crop_xywh": list(crop),
        "native_extent_hw": [height, width],
        "source_resampled": False,
        "selected_pixels": int(hole.sum()),
        "iterations": ITERATIONS,
        "learning_rate": LEARNING_RATE,
        "scales": scales,
        "optimization_steps": steps,
        "generation_ms": generation_ms,
        "process_peak_resident_bytes": resource.getrusage(
            resource.RUSAGE_SELF
        ).ru_maxrss
        * (1 if sys.platform == "darwin" else 1024),
        "torch": torch.__version__,
        "device": "cpu",
        "outputs": outputs,
        "releaseQualified": False,
        "qualification": "Upstream optimization diagnostic on SDR native crop. No canonical RAW/HDR, exact app/browser runtime, device budget or photographic quality qualification.",
    }
    (output / "report.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2), flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ["source", "checkpoint", "config", "image", "mask", "output"]:
        parser.add_argument(f"--{name}", type=Path, required=True)
    parser.add_argument(
        "--crop", type=int, nargs=4, required=True, metavar=("X", "Y", "W", "H")
    )
    args = parser.parse_args()
    run(
        args.source,
        args.checkpoint,
        args.config,
        args.image,
        args.mask,
        tuple(args.crop),
        args.output,
    )
