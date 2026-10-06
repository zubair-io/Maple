"""#4323: pinned 512 inference only, subprocess-owned for cancellation/memory."""

import hashlib
import json
import sys
import time
from pathlib import Path

import numpy as np
from PIL import Image

KIND, JOB, CONFIG = (
    sys.argv[1],
    Path(sys.argv[2]),
    json.loads(Path(sys.argv[3]).read_text()),
)
sys.path.insert(0, CONFIG["removalTools"])
CACHE = Path(CONFIG["cache"])


def progress(message):
    path = JOB / "model-progress.json"
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps({"message": message}))
    tmp.replace(path)


def lama():
    sys.path.insert(0, str(CACHE / "lama-runtime-20261004"))
    import torch
    from export_lama_native import CHECKPOINT_SHA256, load_generator

    torch.set_num_threads(4)
    progress("Loading LaMa…")
    model = load_generator(
        CACHE / "lama-source-20261004",
        CACHE / "lama-weights-20261004/big-lama/models/best.ckpt",
        CACHE / "lama-weights-20261004/big-lama/config.yaml",
    ).requires_grad_(False)
    rgb = (
        np.asarray(Image.open(JOB / "source.png").convert("RGB"), dtype="float32") / 255
    )
    hole = np.asarray(Image.open(JOB / "hole.png")) > 0
    inputs = np.concatenate(
        [rgb.transpose(2, 0, 1) * (1 - hole)[None], hole[None]], axis=0
    ).astype("float32")[None]
    progress("LaMa: removing the selection…")
    with torch.inference_mode():
        result = model(torch.from_numpy(inputs)).numpy()[0].transpose(1, 2, 0)
    return result, {
        "checkpoint": CHECKPOINT_SHA256,
        "steps": 1,
        "device": "CPU",
        "precision": "float32",
    }


def qwen():
    import mlx.core as mx
    from mflux.models.common.config.model_config import AVAILABLE_MODELS
    from mflux.models.common.weights.loading.weight_applier import WeightApplier
    from mflux.models.qwen.variants.edit.qwen_image_edit import QwenImageEdit
    from mflux.utils.image_util import ImageUtil
    from mlx.utils import tree_flatten

    manifest = json.loads(Path(CONFIG["qwenManifest"]).read_text())
    model_path = CACHE / "comparison-qwen-weights"
    progress("Verifying Qwen model files…")
    for entry in manifest["files"]:
        with (model_path / entry["path"]).open("rb") as stream:
            if hashlib.file_digest(stream, "sha256").hexdigest() != entry["sha256"]:
                raise ValueError("Qwen model checksum mismatch: " + entry["path"])

    def strict_weights(weights, models, components=None):
        for name, model in models.items():
            expected = dict(tree_flatten(model.parameters()))
            normalized = []
            for key, value in tree_flatten(weights.components[name]):
                target = expected.get(key)
                if target is not None and value.shape != target.shape:
                    if not (
                        name == "vae"
                        and "norm" in key
                        and key.endswith(".weight")
                        and value.ndim == 1
                        and target.shape[0] == value.shape[0]
                        and all(v == 1 for v in target.shape[1:])
                    ):
                        raise ValueError(
                            "Unexpected Qwen weight shape: " + name + "." + key
                        )
                    value = value.reshape(target.shape)
                normalized.append((key, value))
            model.load_weights(normalized, strict=True)

    progress("Loading Qwen…")
    original_weights = WeightApplier._set_weights
    WeightApplier._set_weights = staticmethod(strict_weights)
    try:
        pipe = QwenImageEdit(
            model_path=str(model_path),
            model_config=AVAILABLE_MODELS["qwen-image-edit-2511"],
        )
    finally:
        WeightApplier._set_weights = original_weights
    mx.eval(pipe.parameters())

    class Progress:
        count = 0

        def call_in_loop(self, *, t, latents, config, **_):
            mx.eval(latents)
            if not bool(mx.all(mx.isfinite(latents)).item()):
                raise ValueError("Nonfinite Qwen latent")
            self.count += 1
            progress(f"Qwen: step {self.count} of 40…")

    callback = Progress()
    pipe.callbacks.register(callback)
    captured = []
    original_image = ImageUtil.to_image

    def capture_image(*args, **kwargs):
        raw = kwargs.get("decoded_latents", args[0] if args else None)
        mx.eval(raw)
        a = np.asarray(raw.astype(mx.float32))
        if a.ndim == 5:
            a = a[:, :, 0]
        if a.shape != (1, 3, 512, 512) or not np.isfinite(a).all():
            raise ValueError("Invalid Qwen decoded output")
        captured.append(np.clip(a[0].transpose(1, 2, 0) / 2 + 0.5, 0, 1))
        return original_image(*args, **kwargs)

    request = json.loads((JOB / "request.json").read_text())
    ImageUtil.to_image = staticmethod(capture_image)
    try:
        pipe.generate_image(
            seed=0,
            prompt=request["prompt"],
            mask_path=JOB / "hole.png",
            image_paths=[str(JOB / "source.png")],
            num_inference_steps=40,
            height=512,
            width=512,
            guidance=4.0,
            negative_prompt=" ",
            canvas_policy="exact-resize",
        )
        mx.synchronize()
    finally:
        ImageUtil.to_image = original_image
    if len(captured) != 1 or callback.count != 40:
        raise ValueError("Incomplete Qwen generation")
    return captured[0], {
        "model": manifest["repo"],
        "revision": manifest["revision"],
        "seed": 0,
        "steps": 40,
        "guidance": 4.0,
        "prompt": request["prompt"],
        "quantization": pipe.bits,
    }


started = time.perf_counter()
result, report = lama() if KIND == "lama" else qwen()
if result.shape != (512, 512, 3) or not np.isfinite(result).all():
    raise ValueError("Invalid model prediction")
np.clip(result, 0, 1).astype("<f4").tofile(JOB / f"{KIND}-coarse.f32")
report.update(seconds=time.perf_counter() - started, modelSide=512)
(JOB / f"{KIND}-model.json").write_text(json.dumps(report, indent=2))
