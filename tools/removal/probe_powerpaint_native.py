"""#3941: pinned PowerPaint v2-1 removal conditioning on native SDR pixels.

Local MPS research only. Uses verified upstream models, task-token wrapper and
pipeline without importing its Gradio controller or resizing to its demo size.
No shipping adapter, canonical RAW plate, Keep or model admission changes.
"""

import argparse
import copy
import json
import random
import resource
import subprocess
import sys
import time
from pathlib import Path

import accelerate
import diffusers
import numpy as np
import torch
import transformers
from accelerate import init_empty_weights
from diffusers import AutoencoderKL, UniPCMultistepScheduler
from PIL import Image
from native_probe_pixels import digest, native_context, save_result
from safetensors.torch import load_file
from transformers import CLIPTextConfig, CLIPTextModel

SEED = 3941
STEPS = 30
GUIDANCE = 12.0
POSITIVE = " P_ctxt"
NEGATIVE = " P_obj"


def verify_artifacts(model_path, source_path):
    pins = json.loads(
        Path(__file__).with_name("powerpaint-research-models.json").read_text()
    )
    if pins["releaseQualified"]:
        raise ValueError("This diagnostic cannot load release-qualified records")
    for root, records in (
        (source_path, pins["sourceFiles"]),
        (model_path, pins["licenseRecords"] + pins["files"]),
    ):
        for item in records:
            path = root / item["path"]
            if path.stat().st_size != item["bytes"] or digest(path) != item["sha256"]:
                raise ValueError(f"Research artifact identity mismatch: {item['path']}")
    revision = subprocess.check_output(
        ["git", "-C", str(source_path), "rev-parse", "HEAD"], text=True
    ).strip()
    dirty = subprocess.check_output(
        ["git", "-C", str(source_path), "status", "--porcelain"], text=True
    ).strip()
    if revision != pins["sourceRevision"] or dirty:
        raise ValueError("Unexpected or modified upstream source checkout")
    return pins


def load_bin(model, path):
    # Every byte is checked before this restricted state-dictionary reader.
    state = torch.load(path, map_location="cpu", weights_only=True, mmap=True)
    if isinstance(model, CLIPTextModel):
        # The 4.37 base omits this fixed buffer; the 4.28 task checkpoint includes it.
        key = "text_model.embeddings.position_ids"
        positions = torch.arange(model.config.max_position_embeddings)[None]
        if key in state and not torch.equal(state[key], positions):
            raise ValueError("Unexpected fixed CLIP position buffer")
        state[key] = positions
    # Preserve the task wrapper's live Parameter references on concrete models.
    model.load_state_dict(
        state,
        strict=True,
        assign=any(parameter.is_meta for parameter in model.parameters()),
    )
    return model.to(dtype=torch.float32).eval().requires_grad_(False)


def open_pipeline(model_path, source_path):
    sys.path.insert(0, str(source_path))
    from powerpaint.models import BrushNetModel, UNet2DConditionModel
    from powerpaint.pipelines.pipeline_PowerPaint_Brushnet_CA import (
        StableDiffusionPowerPaintBrushNetPipeline,
    )
    from powerpaint.utils.utils import TokenizerWrapper, add_tokens

    base = model_path / "realisticVisionV60B1_v51VAE"
    with init_empty_weights():
        unet = UNet2DConditionModel.from_config(str(base / "unet"))
        vae = AutoencoderKL.from_config(str(base / "vae"))
        text = CLIPTextModel(
            CLIPTextConfig.from_pretrained(base / "text_encoder", local_files_only=True)
        )
    unet = load_bin(unet, base / "unet/diffusion_pytorch_model.bin")
    vae = load_bin(vae, base / "vae/diffusion_pytorch_model.bin")
    text = load_bin(text, base / "text_encoder/pytorch_model.bin")
    text_brush = copy.deepcopy(text)
    tokenizer = TokenizerWrapper(
        from_pretrained=str(base), subfolder="tokenizer", local_files_only=True
    )
    add_tokens(
        tokenizer, text_brush, ["P_ctxt", "P_shape", "P_obj"], ["a", "a", "a"], 10
    )
    text_brush = load_bin(
        text_brush, model_path / "PowerPaint_Brushnet/pytorch_model.bin"
    )
    # Only architecture is copied; the complete trained BrushNet replaces it.
    with init_empty_weights():
        brush = BrushNetModel.from_unet(unet, load_weights_from_unet=False)
    brush.load_state_dict(
        load_file(
            str(model_path / "PowerPaint_Brushnet/diffusion_pytorch_model.safetensors"),
            device="cpu",
        ),
        strict=True,
        assign=True,
    )
    brush = brush.to(dtype=torch.float32).eval().requires_grad_(False)
    scheduler = UniPCMultistepScheduler.from_config(
        str(base / "scheduler/scheduler_config.json")
    )
    pipe = StableDiffusionPowerPaintBrushNetPipeline(
        vae,
        text,
        text_brush,
        tokenizer,
        unet,
        brush,
        scheduler,
        safety_checker=None,
        feature_extractor=None,
        requires_safety_checker=False,
    ).to("mps")
    pipe.enable_attention_slicing("auto")
    return pipe


def run(model_path, source_path, image_path, mask_path, crop, output):
    source_u8, hole = native_context(image_path, mask_path, crop)
    if output.exists():
        raise ValueError("Choose a fresh diagnostic output directory")
    if not torch.backends.mps.is_available():
        raise ValueError("This experiment requires an actual local MPS device")
    torch.set_num_threads(4)
    verify_started = time.perf_counter()
    pins = verify_artifacts(model_path, source_path)
    verification_ms = (time.perf_counter() - verify_started) * 1000
    started = time.perf_counter()
    pipe = open_pipeline(model_path, source_path)
    torch.mps.synchronize()
    model_open_ms = (time.perf_counter() - started) * 1000
    height, width = hole.shape
    masked = source_u8.copy()
    masked[hole] = 0
    image = Image.fromarray(masked)
    mask = Image.fromarray(hole.astype(np.uint8) * 255).convert("RGB")
    preprocessed = pipe.image_processor.preprocess(image, height=height, width=width)
    expected = torch.from_numpy(
        (masked.astype(np.float32) / 255 * 2 - 1).transpose(2, 0, 1)[None].copy()
    )
    preprocessed_mask = pipe.image_processor.preprocess(
        mask, height=height, width=width
    )
    if not torch.equal(preprocessed, expected) or not torch.equal(
        preprocessed_mask,
        torch.from_numpy(
            np.repeat((hole.astype(np.float32) * 2 - 1)[None, None], 3, axis=1)
        ),
    ):
        raise ValueError(
            "Pipeline preprocessing changed native source or mask geometry"
        )
    output.mkdir(parents=True, exist_ok=False)
    Image.fromarray(source_u8).save(output / "source.png")
    image.save(output / "conditioning.png")
    mask.convert("L").save(output / "hole.png")
    steps, decoded = [], []
    infer_started = time.perf_counter()

    def step_finished(pipeline, index, timestep, tensors):
        latents = tensors["latents"]
        if (
            tuple(latents.shape) != (1, 4, height // 8, width // 8)
            or not torch.isfinite(latents).all()
        ):
            raise ValueError(
                "Invalid native latent extent or non-finite diffusion output"
            )
        torch.mps.synchronize()
        steps.append(
            {
                "index": index,
                "timestep": float(timestep),
                "shape": list(latents.shape),
                "elapsed_ms": (time.perf_counter() - infer_started) * 1000,
                "mps_allocated_bytes": torch.mps.current_allocated_memory(),
                "mps_driver_bytes": torch.mps.driver_allocated_memory(),
            }
        )
        return tensors

    def decoded_finished(module, arguments, result):
        if (
            tuple(result.shape) != (1, 3, height, width)
            or not torch.isfinite(result).all()
        ):
            raise ValueError("Invalid native pre-clamp decoder output")
        decoded.append(
            {
                "shape": list(result.shape),
                "finite": True,
                "minimum": float(result.min()),
                "maximum": float(result.max()),
            }
        )

    hook = pipe.vae.decoder.register_forward_hook(decoded_finished)
    random.seed(SEED)
    np.random.seed(SEED)
    torch.manual_seed(SEED)
    with torch.inference_mode():
        generated = pipe(
            promptA=POSITIVE,
            promptB=POSITIVE,
            promptU=" empty scene blur",
            negative_promptA=NEGATIVE,
            negative_promptB=NEGATIVE,
            negative_promptU="",
            tradoff=1.0,
            tradoff_nag=1.0,
            image=image,
            mask=mask,
            width=width,
            height=height,
            guidance_scale=GUIDANCE,
            brushnet_conditioning_scale=1.0,
            num_inference_steps=STEPS,
            generator=torch.Generator(device="cpu").manual_seed(SEED),
            output_type="np",
            callback_on_step_end=step_finished,
            callback_on_step_end_tensor_inputs=["latents"],
        ).images[0]
    hook.remove()
    torch.mps.synchronize()
    inference_ms = (time.perf_counter() - infer_started) * 1000
    source = source_u8.astype(np.float32) / np.float32(255)
    if (
        generated.shape != source.shape
        or generated.dtype != np.float32
        or not np.isfinite(generated).all()
    ):
        raise ValueError("Invalid native decoded RGB prediction")
    result = save_result(output, "result", generated, source, hole)
    np.ascontiguousarray(generated, dtype="<f4").tofile(output / "prediction.f32")
    Image.fromarray(np.rint(generated * 255).astype(np.uint8)).save(
        output / "prediction.png"
    )
    report = {
        "model_repo": pins["repository"],
        "model_revision": pins["revision"],
        "source_revision": pins["sourceRevision"],
        "model_manifest_sha256": digest(
            Path(__file__).with_name("powerpaint-research-models.json")
        ),
        "model_files_bytes": sum(item["bytes"] for item in pins["files"]),
        "source_sha256": digest(image_path),
        "mask_sha256": digest(mask_path),
        "crop_xywh": list(crop),
        "native_extent_hw": [height, width],
        "source_resampled": False,
        "preprocessor_samples_equal": True,
        "selected_pixels": int(hole.sum()),
        "task_positive": POSITIVE,
        "task_negative": NEGATIVE,
        "user_prompt": "",
        "seed": SEED,
        "requested_steps": STEPS,
        "actual_steps": len(steps),
        "guidance": GUIDANCE,
        "attention_slicing": "auto",
        "numeric_dtype": "float32",
        "verification_ms": verification_ms,
        "model_open_ms": model_open_ms,
        "inference_ms": inference_ms,
        "steps": steps,
        "decoded": decoded,
        "process_peak_resident_bytes": resource.getrusage(
            resource.RUSAGE_SELF
        ).ru_maxrss
        * (1 if sys.platform == "darwin" else 1024),
        "max_observed_step_boundary_mps_allocated_bytes": max(
            row["mps_allocated_bytes"] for row in steps
        ),
        "max_observed_step_boundary_mps_driver_bytes": max(
            row["mps_driver_bytes"] for row in steps
        ),
        "memory_scope": "Process RSS and sampled step-boundary MPS values are distinct, incomplete measures; do not sum or treat as total/peak GPU budget.",
        "toolchain": {
            "torch": torch.__version__,
            "diffusers": diffusers.__version__,
            "transformers": transformers.__version__,
            "accelerate": accelerate.__version__,
        },
        "result": result,
        "prediction_sha256": digest(output / "prediction.f32"),
        "releaseQualified": False,
        "qualification": "Single seed, native local MPS SDR diagnostic. No canonical RAW/HDR, corpus, deployed adapter, lower-memory device or distribution qualification.",
    }
    (output / "report.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2), flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("model", "upstream", "image", "mask", "output"):
        parser.add_argument(f"--{name}", type=Path, required=True)
    parser.add_argument(
        "--crop",
        type=int,
        nargs=4,
        required=True,
        metavar=("X", "Y", "WIDTH", "HEIGHT"),
    )
    args = parser.parse_args()
    run(args.model, args.upstream, args.image, args.mask, tuple(args.crop), args.output)
