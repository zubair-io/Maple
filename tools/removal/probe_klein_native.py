"""#3941: pinned MLX Klein masked editing with native model-RGB evidence.

Research only: no model catalog, RAW patch, XMP or admission-cap changes.
Upstream code and every model payload are verified before imports/loading.
"""

import argparse
import hashlib
import importlib.metadata
import json
import resource
import subprocess
import sys
import time
from pathlib import Path

import mlx.core as mx
import numpy as np
from native_probe_pixels import digest, native_context, save_result
from PIL import Image

SEED = 3941
STEPS = 4
PROMPT = (
    "Remove the people inside the selected region and their carried objects. "
    "Reconstruct the existing background naturally, preserving the scene's "
    "perspective, lighting, materials and photographic detail."
)


def source_tree_digest(root):
    files = sorted((root / "src").rglob("*.py"))
    rows = [f"{p.relative_to(root)}\0{digest(p)}\n" for p in files]
    return hashlib.sha256("".join(rows).encode()).hexdigest()


def verify_source(root, pin):
    revision = subprocess.check_output(
        ["git", "-C", str(root), "rev-parse", "HEAD"], text=True
    ).strip()
    status = subprocess.check_output(
        ["git", "-C", str(root), "status", "--porcelain"], text=True
    )
    if (
        revision != pin["revision"]
        or status
        or source_tree_digest(root) != pin["python_tree_sha256"]
    ):
        raise ValueError("Unverified or changed upstream source tree")
    for item in pin["records"]:
        if digest(root / item["path"]) != item["sha256"]:
            raise ValueError("Upstream source/license identity mismatch")


def verify_model(root, pins):
    if pins["releaseQualified"]:
        raise ValueError("This probe requires unqualified research records")
    for item in [*pins["files"], *pins["baseModel"]["records"]]:
        path = root / item["path"]
        if path.stat().st_size != item["bytes"] or digest(path) != item["sha256"]:
            raise ValueError(f"Research artifact identity mismatch: {item['path']}")


def native_dimensions(crop):
    if crop[2] % 16 or crop[3] % 16:
        raise ValueError("Klein requires native dimensions divisible by 16")


def float_source(path, source_u8):
    if path is None:
        return source_u8.astype(np.float32) / np.float32(255)
    # The existing Rust scene probe emits channel-first f32, never a display JPEG.
    height, width = source_u8.shape[:2]
    values = np.fromfile(path, dtype="<f4")
    if values.size != height * width * 3:
        raise ValueError("Float model input differs from native context geometry")
    source = values.reshape(3, height, width).transpose(1, 2, 0).copy()
    if (
        not np.isfinite(source).all()
        or source.min() < 0
        or source.max() > 1
        # Match Rust f32::round for the diagnostic PNG, including positive ties.
        or not np.array_equal(np.floor(source * 255 + 0.5).astype(np.uint8), source_u8)
    ):
        raise ValueError("Float input is invalid or differs from its native proxy")
    return source


class NativeSteps:
    def __init__(self, height, width, started):
        self.height, self.width, self.started = height, width, started
        self.rows = []

    def call_in_loop(self, *, t, latents, config, **_):
        expected = (1, self.height // 16 * (self.width // 16), 128)
        mx.eval(latents)
        if (
            tuple(latents.shape) != expected
            or (config.height, config.width) != (self.height, self.width)
            or not bool(mx.all(mx.isfinite(latents)).item())
        ):
            raise ValueError("Invalid native packed latent geometry or samples")
        row = {
            "step": len(self.rows) + 1,
            "scheduler_index": int(t),
            "latent_shape": list(latents.shape),
            "elapsed_ms": (time.perf_counter() - self.started) * 1000,
            "mlx_allocated_bytes": mx.get_active_memory(),
            "mlx_cache_bytes": mx.get_cache_memory(),
        }
        self.rows.append(row)
        print(json.dumps(row), flush=True)


def run(upstream, model_path, image_path, mask_path, crop, output, float_input=None):
    source_u8, hole = native_context(image_path, mask_path, crop)
    native_dimensions(crop)
    source = float_source(float_input, source_u8)
    if output.exists():
        raise ValueError("Choose a fresh diagnostic output directory")
    if not mx.metal.is_available() or mx.default_device() != mx.gpu:
        raise ValueError("This experiment requires the actual local MLX GPU")
    manifest = Path(__file__).with_name("klein-research-models.json")
    pins = json.loads(manifest.read_text())
    verify_started = time.perf_counter()
    verify_source(upstream, pins["runtimeSource"])
    verify_model(model_path, pins)
    if importlib.metadata.version("mlx-gen") != pins["runtimeSource"]["version"]:
        raise ValueError("Unexpected runtime package version")
    verification_ms = (time.perf_counter() - verify_started) * 1000
    sys.path.insert(0, str(upstream / "src"))
    from mlx.utils import tree_flatten
    from mflux.models.common.weights.loading.weight_applier import WeightApplier
    from mflux.models.flux2.variants.edit.flux2_klein_inpaint import Flux2KleinInpaint
    from mflux.utils.image_util import ImageUtil
    from mflux.utils.mask_util import MaskUtil

    loaded = []

    def strict_weights(weights, models, components=None):
        # Strengthen the upstream strict=False loader; no learned defaults may survive.
        for name, model in models.items():
            values = tree_flatten(weights.components[name])
            model.load_weights(values, strict=True)
            loaded.append({"component": name, "tensors": len(values)})

    original_set = WeightApplier._set_weights
    started = time.perf_counter()
    try:
        WeightApplier._set_weights = staticmethod(strict_weights)
        pipe = Flux2KleinInpaint(model_path=str(model_path))
    finally:
        WeightApplier._set_weights = original_set
    mx.eval(pipe.parameters())
    mx.synchronize()
    model_open_ms = (time.perf_counter() - started) * 1000
    height, width = hole.shape
    output.mkdir(parents=True, exist_ok=False)
    Image.fromarray(source_u8).save(output / "source.png")
    Image.fromarray(hole.astype(np.uint8) * 255).save(output / "hole.png")
    seen = []
    tensor_seen = []
    original_scale = ImageUtil.scale_to_dimensions
    original_array = ImageUtil.to_array

    def checked_scale(image, target_width, target_height, **kwargs):
        result = original_scale(image, target_width, target_height, **kwargs)
        if result.size != (width, height) or not np.array_equal(
            np.asarray(result.convert("RGB")), source_u8
        ):
            raise ValueError("Upstream source preprocessing resampled native pixels")
        seen.append(True)
        return result

    def checked_array(image, is_mask=False):
        if is_mask or not np.array_equal(np.asarray(image), source_u8):
            raise ValueError("Unexpected image submitted to the native VAE encoder")
        # For the Rust float context, the PNG is a locator/proxy only. Actual
        # model input preserves its native f32 samples before the VAE's bf16 math.
        expected = (source * np.float32(2) - np.float32(1)).transpose(2, 0, 1)[None]
        values = mx.array(expected) if float_input else original_array(image)
        if not np.array_equal(np.asarray(values), expected):
            raise ValueError("Native model input tensor samples changed")
        tensor_seen.append(True)
        return values

    binary = MaskUtil.load_binary_mask(
        output / "hole.png",
        target_width=width,
        target_height=height,
        resampling=Image.Resampling.LANCZOS,
    )
    if not np.array_equal(binary, hole.astype(np.float32)):
        raise ValueError("Upstream mask preprocessing changed source geometry")
    decoded_arrays = []
    original_decode = pipe.vae.decode_packed_latents

    def checked_decode(latents):
        raw = original_decode(latents)
        mx.eval(raw)
        array = np.asarray(raw.astype(mx.float32))
        if array.shape != (1, 3, height, width) or not np.isfinite(array).all():
            raise ValueError("Invalid native decoder output before clipping")
        decoded_arrays.append(array[0].transpose(1, 2, 0).copy())
        return raw

    infer_started = time.perf_counter()
    steps = NativeSteps(height, width, infer_started)
    pipe.callbacks.register(steps)
    try:
        ImageUtil.scale_to_dimensions = staticmethod(checked_scale)
        ImageUtil.to_array = staticmethod(checked_array)
        pipe.vae.decode_packed_latents = checked_decode
        generated = pipe.generate_image(
            seed=SEED,
            prompt=PROMPT,
            image_path=output / "source.png",
            mask_path=output / "hole.png",
            num_inference_steps=STEPS,
            height=height,
            width=width,
            guidance=1.0,
            canvas_policy="exact-resize",
        )
        mx.synchronize()
    finally:
        ImageUtil.scale_to_dimensions = original_scale
        ImageUtil.to_array = original_array
        pipe.vae.decode_packed_latents = original_decode
    inference_ms = (time.perf_counter() - infer_started) * 1000
    if (
        len(steps.rows) != STEPS
        or len(decoded_arrays) != 1
        or not seen
        or not tensor_seen
    ):
        raise ValueError("Missing native generation/preprocessing evidence")
    raw = decoded_arrays[0]
    prediction = np.clip(raw / np.float32(2) + np.float32(0.5), 0, 1)
    raw.astype("<f4").tofile(output / "decoder-unclipped.f32")
    prediction.astype("<f4").tofile(output / "prediction.f32")
    generated.save(output / "upstream.png", export_json_metadata=True)
    result = save_result(output, "result", prediction, source, hole)
    report = {
        "repo": pins["repo"],
        "revision": pins["revision"],
        "model_manifest_sha256": digest(manifest),
        "runtime_source_revision": pins["runtimeSource"]["revision"],
        "strict_loaded_tensors": loaded,
        "quantization": pipe.bits,
        "source_sha256": digest(image_path),
        "float_input_sha256": digest(float_input) if float_input else None,
        "model_input_quantized_to_u8": float_input is None,
        "model_input_tensor_samples_exact": bool(tensor_seen),
        "mask_sha256": digest(mask_path),
        "crop_xywh": list(crop),
        "native_extent_hw": [height, width],
        "source_preprocessor_samples_exact": bool(seen),
        "pixel_mask_preprocessor_exact": True,
        "source_resampled": False,
        "selected_pixels": int(hole.sum()),
        "prompt": PROMPT,
        "negative_prompt": "",
        "seed": SEED,
        "requested_steps": STEPS,
        "actual_steps": len(steps.rows),
        "guidance": 1.0,
        "verification_ms": verification_ms,
        "model_open_ms": model_open_ms,
        "inference_ms": inference_ms,
        "steps": steps.rows,
        "decoder_unclipped_range": [float(raw.min()), float(raw.max())],
        "decoder_unclipped_sha256": digest(output / "decoder-unclipped.f32"),
        "prediction_sha256": digest(output / "prediction.f32"),
        "result": result,
        "mlx_peak_allocated_bytes": mx.get_peak_memory(),
        "process_peak_resident_bytes": resource.getrusage(
            resource.RUSAGE_SELF
        ).ru_maxrss
        * (1 if sys.platform == "darwin" else 1024),
        "memory_scope": "MLX allocations/cache and process RSS are distinct. Do not sum or claim a total device peak.",
        "toolchain": {
            name: importlib.metadata.version(name)
            for name in ["mlx", "mlx-gen", "numpy", "pillow", "transformers"]
        },
        "releaseQualified": False,
        "input_scope": (
            "Supplied Rust encoded f32 context; native samples reach VAE normalization without a PNG round trip. Context provenance and inverse require separate verification."
            if float_input
            else "Public-RAW Auto SDR PNG; native geometry but source values quantized to u8."
        ),
        "qualification": "Research model inference only. No accepted RAW edit, broad HDR/corpus, supported Mac tier or production distribution qualification.",
    }
    (output / "report.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2), flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ["upstream", "model", "image", "mask", "output"]:
        parser.add_argument(f"--{name}", type=Path, required=True)
    parser.add_argument("--crop", type=int, nargs=4, required=True)
    parser.add_argument("--float-input", type=Path)
    args = parser.parse_args()
    run(
        args.upstream,
        args.model,
        args.image,
        args.mask,
        tuple(args.crop),
        args.output,
        args.float_input,
    )
