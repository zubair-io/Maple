import json
import resource
import sys
import time
from pathlib import Path

import mlx.core as mx
import numpy as np
from common import ROOT, save_result
from mflux.models.common.config.model_config import AVAILABLE_MODELS
from mflux.models.common.weights.loading.weight_applier import WeightApplier
from mflux.utils.image_util import ImageUtil
from mlx.utils import tree_flatten

kind = sys.argv[1]
side = int(sys.argv[2]) if len(sys.argv) > 2 else 1024
manifest = json.loads((ROOT / f"{kind}-manifest.json").read_text())
model_path = manifest["path"]
if len(sys.argv) > 3:
    ROOT = Path(sys.argv[3])
loaded = []


def strict_weights(weights, models, components=None):
    for name, model in models.items():
        values = tree_flatten(weights.components[name])
        expected = dict(tree_flatten(model.parameters()))
        reshaped = []
        normalized = []
        for key, value in values:
            target = expected.get(key)
            if target is not None and value.shape != target.shape:
                # QwenImageRMSNorm explicitly reshapes these channel weights during forward.
                # Checkpoint stores C while constructor initializes Cx1x1(/x1): same samples.
                if not (
                    kind == "qwen"
                    and name == "vae"
                    and "norm" in key
                    and key.endswith(".weight")
                    and value.ndim == 1
                    and target.shape[0] == value.shape[0]
                    and all(x == 1 for x in target.shape[1:])
                ):
                    raise ValueError(
                        f"Unexplained shape mismatch {name}.{key}: {value.shape} vs {target.shape}"
                    )
                reshaped.append(
                    {
                        "key": key,
                        "stored": list(value.shape),
                        "loaded": list(target.shape),
                    }
                )
                value = value.reshape(target.shape)
            normalized.append((key, value))
        model.load_weights(normalized, strict=True)
        loaded.append(
            {
                "component": name,
                "tensors": len(values),
                "losslessNormReshapes": reshaped,
            }
        )


original = WeightApplier._set_weights
WeightApplier._set_weights = staticmethod(strict_weights)
started = time.perf_counter()
if kind == "klein":
    from mflux.models.flux2.variants.edit.flux2_klein_inpaint import Flux2KleinInpaint

    pipe = Flux2KleinInpaint(model_path=model_path)
    steps = 4
    guidance = 1.0
else:
    from mflux.models.qwen.variants.edit.qwen_image_edit import QwenImageEdit

    pipe = QwenImageEdit(
        model_path=model_path, model_config=AVAILABLE_MODELS["qwen-image-edit-2511"]
    )
    steps = 40
    guidance = 4.0
WeightApplier._set_weights = original
mx.eval(pipe.parameters())
mx.synchronize()
load = time.perf_counter() - started
print(json.dumps({"loaded": kind, "seconds": load, "components": loaded}), flush=True)


class Progress:
    def call_in_loop(self, *, t, latents, config, **_):
        mx.eval(latents)
        if not bool(mx.all(mx.isfinite(latents)).item()):
            raise ValueError("Nonfinite latent")
        self.count += 1
        if self.count == 1 or self.count % 5 == 0:
            print(
                json.dumps(
                    {
                        "case": self.case,
                        "seed": self.seed,
                        "step": self.count,
                        "steps": steps,
                        "seconds": time.perf_counter() - self.start,
                        "activeBytes": mx.get_active_memory(),
                    }
                ),
                flush=True,
            )


progress = Progress()
pipe.callbacks.register(progress)
prompts = {
    1: "Remove the selected blue-vest bystander and their shadow. Continue the metal railing and stone pavement naturally through the removed area. Preserve the other people and the architecture.",
    2: "Remove the selected child, including clothing, shoes and their floor shadow. Reconstruct the uninterrupted stone wall and polished stone floor with the same perspective, texture and lighting. Leave the scene empty in the removed area.",
    3: "Remove the selected rear woman wearing a dark coat, including her legs and shadow. Continue the existing stone wall and floor behind her. Preserve the foreground people exactly. Leave the removed area empty.",
    4: "Remove the selected small pink tetrahedral die and its cast shadow. Fill its former area with continuous warm wooden tabletop, matching the surrounding wood grain, color, lighting and perspective. Preserve the red die at the bottom.",
    5: "Remove the selected background pedestrian wearing green, including their limbs. Continue the grass, path, trees and distant background naturally. Preserve the foreground graduation gown and diagonal pink ribbon.",
}
for i in range(1, 6):
    folder = ROOT / f"case-{i}" / str(side)
    for seed in [0, 1]:
        label = f"{kind}-seed{seed}"
        if (folder / f"{label}.json").exists():
            continue
        progress.case = i
        progress.seed = seed
        progress.count = 0
        progress.start = time.perf_counter()
        captured = []
        orig_image = ImageUtil.to_image

        def capture_image(*args, captured=captured, orig_image=orig_image, **kwargs):
            raw = kwargs.get("decoded_latents", args[0] if args else None)
            mx.eval(raw)
            a = np.asarray(raw.astype(mx.float32))
            if a.ndim == 5:
                a = a[:, :, 0]
            assert a.shape == (1, 3, side, side) and np.isfinite(a).all(), a.shape
            captured.append(np.clip(a[0].transpose(1, 2, 0) / 2 + 0.5, 0, 1))
            return orig_image(*args, **kwargs)

        ImageUtil.to_image = staticmethod(capture_image)
        try:
            args = {
                "seed": seed,
                "prompt": prompts[i],
                "mask_path": folder / "hole.png",
                "num_inference_steps": steps,
                "height": side,
                "width": side,
                "guidance": guidance,
                "canvas_policy": "exact-resize",
            }
            if kind == "klein":
                args["image_path"] = folder / "source.png"
            else:
                args.update(
                    image_paths=[str(folder / "source.png")], negative_prompt=" "
                )
            generated = pipe.generate_image(**args)
            mx.synchronize()
        finally:
            ImageUtil.to_image = orig_image
        assert len(captured) == 1 and progress.count == steps
        elapsed = time.perf_counter() - progress.start
        generated.save(folder / f"{label}-upstream.png", export_json_metadata=True)
        report = {
            "model": manifest["repo"],
            "revision": manifest["revision"],
            "case": i,
            "seed": seed,
            "steps": steps,
            "executedSteps": progress.count,
            "guidance": guidance,
            "prompt": prompts[i],
            "inferenceSeconds": elapsed,
            "loadSeconds": load,
            "peakRSSBytes": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss,
            "mlxPeakBytes": mx.get_peak_memory(),
            "quantization": pipe.bits,
            "strictLoaded": loaded,
            "input": "Maple fixed AgX/sRGB research plate, u8 quantization and Lanczos resize"
            if ROOT.name == "raw"
            else "camera JPEG fixed native FOV; Lanczos resize",
            "runtime": "mlx-gen 0.38.0, 99fb94dd3eaa9dd1931cd3cd8eae1ae3e20f2ef3",
        }
        save_result(folder, label, captured[0], report)
        print(
            json.dumps({"completed": label, "case": i, "seconds": elapsed}), flush=True
        )
        mx.clear_cache()
print("DONE", flush=True)
