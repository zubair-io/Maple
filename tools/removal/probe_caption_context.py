"""#3941: automatic background conditioning from masked context on local MLX.

The resized image is only a semantic observation, never replacement pixels.
Research SDR input and generated text remain unqualified for a shipping RAW
adapter. Selected source pixels are withheld from the caption model.
"""

import argparse
import importlib.metadata
import json
import re
import resource
import sys
import time
from pathlib import Path

import mlx.core as mx
import numpy as np
from mlx_vlm import generate, load
from mlx_vlm.prompt_utils import apply_chat_template
from native_probe_pixels import digest, native_context
from PIL import Image

SEED = 3941
MAX_TOKENS = 96
INSTRUCTION = (
    "The black region is missing image content. Describe only the visible "
    "background surfaces that should continue through it. Ignore people and "
    "objects carried by people. Do not describe the black region or readable "
    "signs, and do not invent new furnishings. Return only a concise noun phrase "
    "of at most 40 words describing the background setting, materials, and "
    "existing surfaces. Do not mention people, removal, masking, or instructions."
)


def verify_model(model_path):
    pins = json.loads(
        Path(__file__).with_name("caption-research-models.json").read_text()
    )
    if (
        pins["releaseQualified"]
        or importlib.metadata.version("mlx-vlm") != pins["runtimePackage"]["version"]
    ):
        raise ValueError("Unexpected research model admission or runtime version")
    for item in [pins["baseModel"]["modelCard"], *pins["files"]]:
        path = model_path / item["path"]
        if path.stat().st_size != item["bytes"] or digest(path) != item["sha256"]:
            raise ValueError(f"Caption artifact identity mismatch: {item['path']}")
    return pins


def masked_context(source, hole):
    masked = source.copy()
    masked[hole] = 0
    if np.count_nonzero(masked[hole]) or not np.array_equal(
        masked[~hole], source[~hole]
    ):
        raise ValueError(
            "Caption context leaked selected samples or changed known context"
        )
    return masked


def background_prompt(text):
    caption = " ".join(text.split())
    if (
        not 4 <= len(caption.split()) <= 50
        or len(caption.encode("utf-8")) > 768
        or re.search(
            r"\b(people|person|human|man|woman|men|women|boy|girl|mask|masked|removal|black region)\b",
            caption,
            re.IGNORECASE,
        )
        or "<|" in caption
    ):
        raise ValueError("Caption is not a bounded background description")
    return f"documentary photograph of {caption}, continuation of the existing surfaces"


def run(model_path, image_path, mask_path, crop, output):
    source, hole = native_context(image_path, mask_path, crop)
    if output.exists():
        raise ValueError("Choose a fresh diagnostic output directory")
    if not mx.metal.is_available() or mx.default_device() != mx.gpu:
        raise ValueError("This experiment requires an actual local MLX GPU device")
    masked = masked_context(source, hole)
    verify_started = time.perf_counter()
    pins = verify_model(model_path)
    verification_ms = (time.perf_counter() - verify_started) * 1000
    started = time.perf_counter()
    model, processor = load(
        str(model_path),
        strict=True,
        lazy=False,
        trust_remote_code=False,
        local_files_only=True,
    )
    mx.synchronize()
    model_open_ms = (time.perf_counter() - started) * 1000
    # Observational proxy only; source coordinates and final model pixels stay native.
    height, width = hole.shape
    proxy = Image.fromarray(masked).resize(
        (512, round(height * 512 / width)), Image.Resampling.LANCZOS
    )
    output.mkdir(parents=True, exist_ok=False)
    Image.fromarray(masked).save(output / "masked-native-context.png")
    proxy.save(output / "caption-proxy.png")
    prompt = apply_chat_template(processor, model.config, INSTRUCTION, num_images=1)
    mx.random.seed(SEED)
    inference_started = time.perf_counter()
    response = generate(
        model,
        processor,
        prompt,
        image=[str(output / "caption-proxy.png")],
        max_tokens=MAX_TOKENS,
        temperature=0.0,
        verbose=False,
    )
    mx.synchronize()
    inference_ms = (time.perf_counter() - inference_started) * 1000
    if response.generation_tokens >= MAX_TOKENS:
        raise ValueError("Caption reached the token limit without a complete response")
    positive = background_prompt(response.text)
    (output / "caption.txt").write_text(response.text + "\n")
    (output / "positive-prompt.txt").write_text(positive + "\n")
    report = {
        "model_repo": pins["repo"],
        "model_revision": pins["revision"],
        "model_manifest_sha256": digest(
            Path(__file__).with_name("caption-research-models.json")
        ),
        "model_files_bytes": sum(item["bytes"] for item in pins["files"]),
        "source_sha256": digest(image_path),
        "mask_sha256": digest(mask_path),
        "crop_xywh": list(crop),
        "native_extent_hw": [height, width],
        "selected_pixels": int(hole.sum()),
        "selected_context_samples_withheld": True,
        "masked_native_context_sha256": digest(output / "masked-native-context.png"),
        "caption_proxy_extent_wh": list(proxy.size),
        "caption_proxy_sha256": digest(output / "caption-proxy.png"),
        "proxy_scope": "Reduced semantic observation only; never used as generated replacement pixels.",
        "instruction": INSTRUCTION,
        "rendered_prompt": prompt,
        "raw_caption": response.text,
        "positive_prompt": positive,
        "seed": SEED,
        "temperature": 0.0,
        "max_tokens": MAX_TOKENS,
        "actual_prompt_tokens": response.prompt_tokens,
        "actual_generation_tokens": response.generation_tokens,
        "finish_reason": response.finish_reason,
        "verification_ms": verification_ms,
        "model_open_ms": model_open_ms,
        "inference_ms": inference_ms,
        "mlx_peak_allocated_bytes": mx.get_peak_memory(),
        "mlx_active_allocated_bytes": mx.get_active_memory(),
        "mlx_cache_allocated_bytes": mx.get_cache_memory(),
        "process_peak_resident_bytes": resource.getrusage(
            resource.RUSAGE_SELF
        ).ru_maxrss
        * (1 if sys.platform == "darwin" else 1024),
        "memory_scope": "MLX allocations, cache and process RSS are distinct measures. Do not sum or claim a total device memory peak.",
        "toolchain": {
            name: importlib.metadata.version(name)
            for name in ["mlx", "mlx-vlm", "transformers", "numpy", "pillow"]
        },
        "releaseQualified": False,
        "qualification": "Local public-RAW SDR context-caption diagnostic. No proof of scene correctness, canonical RAW/HDR, native texture, deployed adapter, supported Mac tier or production distribution.",
    }
    (output / "report.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2), flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("model", "image", "mask", "output"):
        parser.add_argument(f"--{name}", type=Path, required=True)
    parser.add_argument(
        "--crop",
        type=int,
        nargs=4,
        required=True,
        metavar=("X", "Y", "WIDTH", "HEIGHT"),
    )
    args = parser.parse_args()
    run(args.model, args.image, args.mask, tuple(args.crop), args.output)
