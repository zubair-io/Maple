"""#3941: pinned upstream AOT-GAN on shared native RAW float contexts.

Research only. No resizing, clipping, model admission, XMP or image upload.
The upstream generator and Places2 weights are unchanged; its documented
white masked input and -1..1 normalization are applied to shared f32 input.
"""

import argparse
import importlib
import json
import resource
import subprocess
import sys
import time
from pathlib import Path
from types import SimpleNamespace

import blake3
import numpy as np
import torch
from native_orientation import exact_roundtrip, orient
from native_probe_pixels import digest
from PIL import Image

REVISION = "2cd1afd8fdfabb101c678f6062d14bc7d302509e"
WEIGHTS_SHA256 = "9c30e3b979b69e46ca80482f8a75f37fa2d62e97c678e7c7b0f12775e75d9e8e"
SOURCE_PINS = {
    "src/model/aotgan.py": "3b956093c04f3ffcf4ae5c2eef18445f2a251ff8bf7365954612e91e19f0025c",
    "src/model/common.py": "a6a870f2e66acdde3785047a061229e81f0e0383922feacf999bb4ad8aa27d1d",
    "src/test.py": "56efd179953ebc2d9e1e011db08a43882242dd3d943e37d21e780e5f861f7e33",
    "LICENSE": "3a08baf12a7cda0724fbcc8747b3bf428581a0644fb70f08378ffc86ec1d9129",
}


def content(path):
    return "blake3:" + blake3.blake3(path.read_bytes()).hexdigest()


def inputs(context):
    recipe = json.loads((context / "context.json").read_text())
    masks = json.loads((context / "masks.json").read_text())
    window = recipe["window"]
    if (
        recipe["plate"] != "LinearCalibrationV1"
        or recipe["release_qualified"]
        or (window["width"], window["height"]) != (1024, 1024)
        or masks["request"]["window"] != window
    ):
        raise ValueError("Require an unqualified native1024 calibration context")
    for name, pin in (
        ("input.f32", recipe["model_input"]),
        ("scene.f32", recipe["scene"]),
        ("intent.mimf", masks["intent"]),
        ("protected.mimf", masks["protected"]),
        ("masks.f32", masks["planes"]),
    ):
        if content(context / name) != pin:
            raise ValueError(f"Shared context identity changed: {name}")
    rgb = np.fromfile(context / "input.f32", dtype="<f4")
    planes = np.fromfile(context / "masks.f32", dtype="<f4")
    if rgb.size != 3 * 1024**2 or planes.size != 2 * 1024**2:
        raise ValueError("Input native tensor geometry differs")
    rgb, planes = rgb.reshape(1, 3, 1024, 1024), planes.reshape(2, 1024, 1024)
    if (
        not np.isfinite(rgb).all()
        or rgb.min() < 0
        or rgb.max() > 1
        or not np.isfinite(planes).all()
        or not np.isin(planes[0], [0, 1]).all()
        or not 0 < planes[0].sum() < 1024**2
        or planes[1].min() < 0
        or planes[1].max() > 1
        or np.any(planes[1][planes[0] == 0] != 0)
    ):
        raise ValueError("Invalid native model RGB or shared mask planes")
    return rgb, planes[0][None, None], recipe


def run(source, checkpoint, context, output, orientation_probe=None, native_512=False):
    if output.exists():
        raise ValueError("Choose a fresh research output directory")
    revision = subprocess.check_output(
        ["git", "-C", str(source), "rev-parse", "HEAD"], text=True
    ).strip()
    if (
        revision != REVISION
        or any(digest(source / path) != pin for path, pin in SOURCE_PINS.items())
        or subprocess.check_output(
            ["git", "-C", str(source), "status", "--porcelain", "--untracked-files=no"],
            text=True,
        ).strip()
    ):
        raise ValueError("Upstream source differs from the recorded revision")
    if checkpoint.stat().st_size != 60829150 or digest(checkpoint) != WEIGHTS_SHA256:
        raise ValueError("Places2 generator checkpoint identity changed")
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
    sys.path.insert(0, str(source / "src"))
    model = importlib.import_module("model.aotgan").InpaintGenerator(
        SimpleNamespace(rates=[1, 2, 4, 8], block_num=8)
    )
    # Published 2021 checkpoint predates zip serialization; weights_only
    # restricted loading still applies, and byte identity was checked first.
    state = torch.load(checkpoint, map_location="cpu", weights_only=True)
    model.load_state_dict(state, strict=True)
    model.eval().requires_grad_(False)
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
    crop = [0, 0, 1024, 1024]
    if native_512:
        ys, xs = np.nonzero(upright_hole[0, 0])
        if np.ptp(xs) >= 512 or np.ptp(ys) >= 512:
            raise ValueError("Complete reconstruction hole exceeds native512")
        x = int(np.clip((int(xs.min()) + int(xs.max()) + 1) // 2 - 256, 0, 512))
        y = int(np.clip((int(ys.min()) + int(ys.max()) + 1) // 2 - 256, 0, 512))
        crop = [x, y, 512, 512]
    x, y, width, height = crop
    model_rgb = upright[:, :, y : y + height, x : x + width].copy()
    model_hole = upright_hole[:, :, y : y + height, x : x + width].copy()
    if model_hole.sum() != hole.sum():
        raise ValueError("Native model crop truncates selected pixels")
    normalized = torch.from_numpy(model_rgb * np.float32(2) - np.float32(1))
    mask = torch.from_numpy(model_hole)
    masked = normalized * (1 - mask) + mask
    started = time.perf_counter()
    with torch.inference_mode():
        actual = model(masked, mask)
    elapsed = time.perf_counter() - started
    if actual.shape != normalized.shape or not torch.isfinite(actual).all():
        raise ValueError("Native generator returned invalid shape or samples")
    # Strict loaded tensor equality verifies that evaluation did not update
    # any learned parameters or persistent buffers.
    if any(
        not torch.equal(value, state[name])
        for name, value in model.state_dict().items()
    ):
        raise ValueError("Generator weights changed during inference")
    prediction = upright.copy()
    prediction[:, :, y : y + height, x : x + width] = actual.numpy() * np.float32(
        0.5
    ) + np.float32(0.5)
    if orientation != 1:
        pixels, inverse_row = orient(
            orientation_probe,
            prediction[0].transpose(1, 2, 0).copy(),
            orientation,
            output,
            "prediction",
            inverse=True,
        )
        prediction = pixels.transpose(2, 0, 1)[None].copy()
        orientation_rows["prediction_inverse"] = inverse_row
    if prediction.min() < 0 or prediction.max() > 1:
        raise ValueError("Tanh generator output exceeds its documented domain")
    candidate = np.where(hole == 1, prediction, rgb)
    outside = np.broadcast_to(hole == 0, rgb.shape)
    if not np.array_equal(
        candidate[outside].view(np.uint32), rgb[outside].view(np.uint32)
    ):
        raise ValueError("Candidate changed known native float samples")
    prediction.astype("<f4").tofile(output / "prediction.f32")
    candidate.astype("<f4").tofile(output / "result.f32")
    masked.numpy().astype("<f4").tofile(output / "model-input-normalized.f32")
    for name, values in (("source", rgb), ("candidate", candidate)):
        pixels = np.floor(values[0].transpose(1, 2, 0) * 255 + 0.5).astype(np.uint8)
        Image.fromarray(pixels).save(output / f"{name}.png")
    report = {
        "source_revision": revision,
        "source_files_sha256": SOURCE_PINS,
        "checkpoint_sha256": WEIGHTS_SHA256,
        "checkpoint_bytes": checkpoint.stat().st_size,
        "learned_tensors": len(state),
        "learned_parameters": sum(value.numel() for value in state.values()),
        "weights_unchanged": True,
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
        "model_extent_hw": [height, width],
        "native_model_crop_xywh_upright": crop,
        "selected_pixels": int(hole.sum()),
        "input_normalization": "f32 RGB * 2 - 1; selected RGB = +1; separate binary f32 mask",
        "input_sha256": digest(context / "input.f32"),
        "result_sha256": digest(output / "result.f32"),
        "prediction_sha256": digest(output / "prediction.f32"),
        "outside_float_bits_changed": 0,
        "inference_seconds": elapsed,
        "process_peak_rss_bytes_macos": resource.getrusage(
            resource.RUSAGE_SELF
        ).ru_maxrss,
        "torch": torch.__version__,
        "device": "cpu",
        "releaseQualified": False,
        "scope": "Actual unchanged upstream Places2 generator on canonical native RAW f32. No resizing or clipping. One uncontrolled CPU point; RAW inverse, photographic quality, ONNX/native app and supported-device admission remain separate gates.",
    }
    (output / "report.json").write_text(json.dumps(report, indent=2) + "\n")
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("source", "checkpoint", "context", "output"):
        parser.add_argument(f"--{name}", type=Path, required=True)
    parser.add_argument("--orientation-probe", type=Path)
    parser.add_argument("--native-512", action="store_true")
    print(json.dumps(run(**vars(parser.parse_args())), indent=2))
