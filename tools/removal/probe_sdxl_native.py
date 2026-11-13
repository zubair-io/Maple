"""#3941: pinned SDXL inpainting at native crop dimensions, local MPS only.

Public-RAW SDR challenge, not a shipping adapter or accepted RAW edit. The
automatic people-removal case uses an empty positive prompt and a fixed
negative people prompt. All samples outside the selected mask are copied.
"""

import argparse
import json
import resource
import sys
import time
from pathlib import Path

import accelerate
import diffusers
import numpy as np
import torch
import transformers
from diffusers import StableDiffusionXLInpaintPipeline
from PIL import Image
from native_probe_pixels import digest, native_context, save_result

SEED = 3941
STEPS = 20
STRENGTH = 0.99
GUIDANCE = 8.0
NEGATIVE_PROMPT = "person, people, human figure, silhouette"


def verify_models(model_path):
    pins = json.loads(Path(__file__).with_name("sdxl-research-models.json").read_text())
    if pins["releaseQualified"]:
        raise ValueError("This diagnostic cannot load release-qualified records")
    for item in pins["files"]:
        path = model_path / item["path"]
        if path.stat().st_size != item["bytes"] or digest(path) != item["sha256"]:
            raise ValueError(f"Research model identity mismatch: {item['path']}")
    license_pin = pins["license"]
    if digest(model_path / license_pin["file"]) != license_pin["sha256"]:
        raise ValueError("Missing or mismatched model license")
    return pins


def run(model_path, image_path, mask_path, crop, output, prompt=""):
    source_u8, hole = native_context(image_path, mask_path, crop)
    if output.exists():
        raise ValueError("Choose a fresh diagnostic output directory")
    if not torch.backends.mps.is_available():
        raise ValueError("This experiment requires an actual local MPS device")
    torch.set_num_threads(4)
    verify_started = time.perf_counter()
    pins = verify_models(model_path)
    verification_ms = (time.perf_counter() - verify_started) * 1000
    started = time.perf_counter()
    pipe = StableDiffusionXLInpaintPipeline.from_pretrained(
        str(model_path),
        local_files_only=True,
        use_safetensors=True,
        torch_dtype=torch.float16,
        variant="fp16",
        add_watermarker=False,
    ).to("mps")
    pipe.enable_attention_slicing("auto")
    torch.mps.synchronize()
    model_open_ms = (time.perf_counter() - started) * 1000
    source = source_u8.astype(np.float32) / np.float32(255)
    height, width = hole.shape
    image = Image.fromarray(source_u8)
    mask = Image.fromarray(hole.astype(np.uint8) * 255)
    preprocessed = pipe.image_processor.preprocess(image, height=height, width=width)
    preprocessed_mask = pipe.mask_processor.preprocess(mask, height=height, width=width)
    expected = torch.from_numpy((source * 2 - 1).transpose(2, 0, 1)[None].copy())
    if not torch.equal(preprocessed, expected) or not torch.equal(
        preprocessed_mask, torch.from_numpy(hole[None, None].astype(np.float32))
    ):
        raise ValueError(
            "Pipeline preprocessing changed native source or mask geometry"
        )
    output.mkdir(parents=True, exist_ok=False)
    image.save(output / "source.png")
    mask.save(output / "hole.png")
    steps = []
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
        row = {
            "step": index + 1,
            "timestep": float(timestep),
            "elapsed_ms": (time.perf_counter() - infer_started) * 1000,
            "latent_shape": list(latents.shape),
            "mps_allocated_bytes": torch.mps.current_allocated_memory(),
            "mps_driver_bytes": torch.mps.driver_allocated_memory(),
        }
        steps.append(row)
        print(json.dumps(row), flush=True)
        return tensors

    with torch.inference_mode():
        generated = pipe(
            prompt=prompt,
            negative_prompt=NEGATIVE_PROMPT,
            image=image,
            mask_image=mask,
            height=height,
            width=width,
            original_size=(height, width),
            target_size=(height, width),
            num_inference_steps=STEPS,
            strength=STRENGTH,
            guidance_scale=GUIDANCE,
            generator=torch.Generator(device="cpu").manual_seed(SEED),
            output_type="np",
            callback_on_step_end=step_finished,
            callback_on_step_end_tensor_inputs=["latents"],
        ).images[0]
    torch.mps.synchronize()
    inference_ms = (time.perf_counter() - infer_started) * 1000
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
        "model_repo": pins["repo"],
        "model_revision": pins["revision"],
        "model_manifest_sha256": digest(
            Path(__file__).with_name("sdxl-research-models.json")
        ),
        "model_files_bytes": sum(item["bytes"] for item in pins["files"]),
        "source_sha256": digest(image_path),
        "mask_sha256": digest(mask_path),
        "crop_xywh": list(crop),
        "native_extent_hw": [height, width],
        "source_resampled": False,
        "preprocessor_samples_equal": True,
        "selected_pixels": int(hole.sum()),
        "positive_prompt": prompt,
        "negative_prompt": NEGATIVE_PROMPT,
        "seed": SEED,
        "requested_steps": STEPS,
        "actual_steps": len(steps),
        "strength": STRENGTH,
        "guidance": GUIDANCE,
        "attention_slicing": "auto",
        "verification_ms": verification_ms,
        "model_open_ms": model_open_ms,
        "inference_ms": inference_ms,
        "steps": steps,
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
        "qualification": "Single seed, local MPS SDR diagnostic with the recorded prompt. No canonical RAW/HDR, photographic corpus, deployed native/browser adapter, lower-memory device or production distribution qualification.",
    }
    (output / "report.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2), flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ["model", "image", "mask", "output"]:
        parser.add_argument(f"--{name}", type=Path, required=True)
    parser.add_argument(
        "--crop", type=int, nargs=4, required=True, metavar=("X", "Y", "W", "H")
    )
    parser.add_argument(
        "--prompt",
        default="",
        help="Research condition; absent means an empty positive prompt",
    )
    args = parser.parse_args()
    run(args.model, args.image, args.mask, tuple(args.crop), args.output, args.prompt)
