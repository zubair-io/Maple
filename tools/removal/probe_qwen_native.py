"""#3941: pinned Qwen edit native-float reconstruction research on local MLX.

Consumes exact upright conditioning exported by the source-bound native probe.
No accepted edit, shipping runtime, quality pass or model admission is implied.
"""

import argparse
import importlib.metadata
import json
import sys
import time
from pathlib import Path

import mlx.core as mx
import numpy as np
from native_probe_pixels import digest, native_context, save_result
from probe_klein_native import float_source, verify_source
from probe_klein_oriented import BACKGROUND_PROMPT

SEED = 3941
STEPS = 20
GUIDANCE = 4.0


def run(upstream, model, prepared, output):
    pins_path = Path(__file__).with_name("qwen-edit-research-models.json")
    pins = json.loads(pins_path.read_text())
    if output.exists() or pins["releaseQualified"]:
        raise ValueError("Require a fresh unqualified research output")
    if not mx.metal.is_available() or mx.default_device() != mx.gpu:
        raise ValueError("Require actual local MLX GPU execution")
    verify_source(upstream, pins["runtimeSource"])
    if importlib.metadata.version("mlx-gen") != pins["runtimeSource"]["version"]:
        raise ValueError("Runtime package version mismatch")
    for row in pins["files"]:
        path = model / row["path"]
        if path.stat().st_size != row["bytes"] or digest(path) != row["sha256"]:
            raise ValueError("Qwen model artifact identity mismatch: " + row["path"])
    parent = json.loads((prepared / "report.json").read_text())
    previous_model = json.loads((prepared / "generated/report.json").read_text())
    float_input = prepared / "upright-nchw.f32"
    image_path = prepared / "upright.png"
    mask_path = prepared / "upright-hole.png"
    if (
        parent["source_resampled"]
        or parent["model_input_quantized_to_u8"]
        or digest(float_input) != parent["conditioned_input_sha256"]
        or digest(mask_path) != previous_model["mask_sha256"]
        or not parent["source"]["roundtrip_bits_exact"]
        or not parent["mask"]["roundtrip_bits_exact"]
    ):
        raise ValueError("Source-bound upright conditioning evidence differs")
    height, width = parent["upright_extent_hw"]
    source_u8, hole = native_context(image_path, mask_path, (0, 0, width, height))
    source = float_source(float_input, source_u8)
    sys.path.insert(0, str(upstream / "src"))
    from mlx.utils import tree_flatten
    from mflux.models.common.config.model_config import ModelConfig
    from mflux.models.common.weights.loading.weight_applier import WeightApplier
    from mflux.models.qwen.model.qwen_vae.qwen_image_rms_norm import QwenImageRMSNorm
    from mflux.models.qwen.variants.edit.qwen_image_edit import QwenImageEdit
    from mflux.utils.image_util import ImageUtil

    mx.set_cache_limit(1024**3)
    loaded = []

    def strict_weights(weights, models, components=None):
        for name, component in models.items():
            component_weights = weights.components[name]
            definition = components.get(name) if components else None
            if definition and definition.weight_subkey:
                component_weights = component_weights.get(
                    definition.weight_subkey, component_weights
                )
            norms = {
                path + ".weight": module.weight.shape
                for path, module in component.named_modules()
                if isinstance(module, QwenImageRMSNorm)
            }
            adaptations = []
            values = []
            for path, value in tree_flatten(component_weights):
                shape = norms.get(path)
                if shape and value.shape != shape:
                    # The pinned upstream mapper flattens RMS gamma. Its forward
                    # pass reshapes these same channel values for broadcasting.
                    if value.shape != (shape[0],) or any(n != 1 for n in shape[1:]):
                        raise ValueError("Unexpected Qwen RMS channel weight shape")
                    adaptations.append(
                        {"tensor": path, "from": list(value.shape), "to": list(shape)}
                    )
                    value = value.reshape(shape)
                values.append((path, value))
            component.load_weights(values, strict=True)
            loaded.append(
                {
                    "component": name,
                    "tensors": len(values),
                    "broadcast_views": adaptations,
                }
            )

    original_set = WeightApplier._set_weights
    opened = time.perf_counter()
    try:
        WeightApplier._set_weights = staticmethod(strict_weights)
        pipe = QwenImageEdit(
            model_path=str(model),
            model_config=ModelConfig.from_name("Qwen/Qwen-Image-Edit-2511"),
        )
    finally:
        WeightApplier._set_weights = original_set
    mx.eval(pipe.parameters())
    mx.synchronize()
    open_ms = (time.perf_counter() - opened) * 1000
    output.mkdir(exist_ok=False, parents=True)
    seen = []
    decoded = []
    steps = []
    original_scale = ImageUtil.scale_to_dimensions
    original_array = ImageUtil.to_array
    original_decode = pipe.vae.decode

    def checked_scale(image, target_width, target_height, **kwargs):
        result = original_scale(image, target_width, target_height, **kwargs)
        if result.size != (width, height) or not np.array_equal(
            np.asarray(result.convert("RGB")), source_u8
        ):
            raise ValueError("Native VAE source resampled or changed")
        return result

    def checked_array(image, is_mask=False):
        if is_mask or not np.array_equal(np.asarray(image), source_u8):
            raise ValueError("Unexpected native VAE input")
        expected = (source * np.float32(2) - np.float32(1)).transpose(2, 0, 1)[None]
        values = mx.array(expected)
        if not np.array_equal(np.asarray(values), expected):
            raise ValueError("Native float VAE input changed")
        seen.append(True)
        return values

    def checked_decode(latents):
        values = original_decode(latents)
        mx.eval(values)
        array = np.asarray(values.astype(mx.float32))
        if array.shape != (1, 3, 1, height, width) or not np.isfinite(array).all():
            raise ValueError("Native Qwen decoder geometry or values differ")
        decoded.append(array[0, :, 0].transpose(1, 2, 0).copy())
        return values

    started = time.perf_counter()

    class Steps:
        def call_in_loop(self, *, t, latents, config, **_):
            mx.eval(latents)
            if tuple(latents.shape) != (
                1,
                height // 16 * (width // 16),
                64,
            ) or not bool(mx.all(mx.isfinite(latents)).item()):
                raise ValueError("Invalid native Qwen packed latents")
            row = {
                "step": len(steps) + 1,
                "scheduler_index": int(t),
                "latent_shape": list(latents.shape),
                "elapsed_ms": (time.perf_counter() - started) * 1000,
                "mlx_active_bytes": mx.get_active_memory(),
                "mlx_cache_bytes": mx.get_cache_memory(),
            }
            steps.append(row)
            print(json.dumps(row), flush=True)

    pipe.callbacks.register(Steps())
    try:
        ImageUtil.scale_to_dimensions = staticmethod(checked_scale)
        ImageUtil.to_array = staticmethod(checked_array)
        pipe.vae.decode = checked_decode
        generated = pipe.generate_image(
            seed=SEED,
            prompt=BACKGROUND_PROMPT,
            image_paths=[str(image_path)],
            mask_path=str(mask_path),
            num_inference_steps=STEPS,
            height=height,
            width=width,
            guidance=GUIDANCE,
            negative_prompt="person, people, human figure, silhouette",
            canvas_policy="exact-resize",
        )
        mx.synchronize()
    finally:
        ImageUtil.scale_to_dimensions = original_scale
        ImageUtil.to_array = original_array
        pipe.vae.decode = original_decode
    if len(steps) != STEPS or len(decoded) != 1 or not seen:
        raise ValueError("Missing exact native inference evidence")
    raw = decoded[0]
    prediction = np.clip(raw / np.float32(2) + np.float32(0.5), 0, 1)
    raw.astype("<f4").tofile(output / "decoder-unclipped.f32")
    prediction.astype("<f4").tofile(output / "prediction.f32")
    prediction.transpose(2, 0, 1).copy().astype("<f4").tofile(
        output / "prediction-nchw.f32"
    )
    generated.save(output / "upstream.png", export_json_metadata=True)
    result = save_result(output, "result", prediction, source, hole)
    report = {
        "repo": pins["repo"],
        "revision": pins["revision"],
        "model_manifest_sha256": digest(pins_path),
        "runtime_source_revision": pins["runtimeSource"]["revision"],
        "prepared_source_report": str(prepared / "report.json"),
        "prepared_source_report_sha256": digest(prepared / "report.json"),
        "float_input_sha256": digest(float_input),
        "mask_sha256": digest(mask_path),
        "native_extent_hw": [height, width],
        "source_resampled": False,
        "model_input_quantized_to_u8": False,
        "source_samples_exact_before_VAE": True,
        "semantic_proxy_scope": "Qwen VL image observation uses upstream semantic resize; replacement VAE pixels and decoder remain native.",
        "strict_loaded_tensors": loaded,
        "quantization": pipe.bits,
        "seed": SEED,
        "requested_steps": STEPS,
        "actual_steps": len(steps),
        "guidance": GUIDANCE,
        "prompt": BACKGROUND_PROMPT,
        "negative_prompt": "person, people, human figure, silhouette",
        "model_open_ms": open_ms,
        "inference_ms": (time.perf_counter() - started) * 1000,
        "steps": steps,
        "mlx_peak_memory_bytes": mx.get_peak_memory(),
        "memory_scope": "Logical MLX peak only, not system/device footprint or a supported-memory-tier claim.",
        "decoder_unclipped_sha256": digest(output / "decoder-unclipped.f32"),
        "prediction_sha256": digest(output / "prediction.f32"),
        "result": result,
        "releaseQualified": False,
        "scope": "Native candidate reconstruction research. Canonical inverse, grades, object/subject/detail/noise quality, licenses/distribution and runtime/device gates remain.",
    }
    (output / "report.json").write_text(json.dumps(report, indent=2) + "\n")
    print("Qwen native reconstruction completed.", flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ["upstream", "model", "prepared", "output"]:
        parser.add_argument("--" + name, type=Path, required=True)
    run(**vars(parser.parse_args()))
