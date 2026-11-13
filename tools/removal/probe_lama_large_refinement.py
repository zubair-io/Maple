"""#3941: pinned feature refinement on the exact native2048 RAW model plate.

Research only. Reuses the unchanged upstream pyramid/loss/optimizer functions;
one CPU replaces CUDA dispatch and the research pixel budget admits all2048
pixels. This is not app admission, deployed ORT or supported-device evidence.
"""

import argparse
import json
import resource
import subprocess
import sys
import time
from pathlib import Path

import numpy as np
import torch
from export_lama_native import load_generator
from probe_lama_large_scene import SIDE, load_inputs, sha256
from probe_lama_refinement import (
    DEFAULTS_SHA256,
    ITERATIONS,
    LEARNING_RATE,
    upstream_helpers,
    weight_digest,
)
from torch.utils.checkpoint import checkpoint


def preflight(context, source, output):
    if output.exists():
        raise ValueError("Choose a fresh native RAW refinement output")
    recipe = json.loads((context / "context.json").read_text())
    if recipe["encoding"].get("method") != "signed-log-photographic-contrast-v1":
        raise ValueError("Expected the bound reversible photographic input comparison")
    prepared = load_inputs(context)
    original = np.fromfile(context / "input.f32", "<f4").reshape(1, 3, SIDE, SIDE)
    mask = prepared[:, 3:4].copy()
    if not np.array_equal(original * (1 - mask), prepared[:, :3]):
        raise ValueError("Native masked input differs from the bound RAW model plate")
    if (
        sha256(source / "configs/prediction/default.yaml") != DEFAULTS_SHA256
        or subprocess.check_output(
            ["git", "-C", str(source), "status", "--porcelain", "--untracked-files=no"],
            text=True,
        ).strip()
    ):
        raise ValueError("Pinned upstream defaults or tracked source changed")
    helpers = upstream_helpers(source / "saicinpainting/evaluation/refinement.py")
    return original.copy(), mask, helpers


def checked_result(values, output, name):
    if (
        values.shape != (1, 3, SIDE, SIDE)
        or values.dtype != np.float32
        or not np.isfinite(values).all()
        or values.min() < 0
        or values.max() > 1
    ):
        raise ValueError("Invalid native2048 refinement model output")
    path = output / name
    values.astype("<f4").tofile(path)
    return sha256(path)


class CheckpointedRear(torch.nn.Module):
    """Recompute frozen rear activations instead of retaining the full pyramid graph."""

    def __init__(self, rear):
        super().__init__()
        self.rear = rear

    def forward(self, features):
        return checkpoint(self.rear, features, use_reentrant=False)


def qualify_checkpointing(front, rear, image, mask):
    # Actual source-bound coarse pixels, not fabricated latent tensors. Check
    # both prediction and the gradients Adam will consume before the large run.
    with torch.no_grad():
        features = front(torch.cat([image * (1 - mask), mask], dim=1))
    outputs = []
    for owner in [rear, CheckpointedRear(rear)]:
        inputs = tuple(v.detach().clone().requires_grad_(True) for v in features)
        prediction = owner(inputs)
        gradients = torch.autograd.grad(prediction.square().mean(), inputs)
        outputs.append([v.detach().numpy().copy() for v in [prediction, *gradients]])
        del inputs, prediction, gradients
    mismatches = [
        int(np.count_nonzero(a.view(np.uint32) != b.view(np.uint32)))
        for a, b in zip(*outputs, strict=True)
    ]
    if any(mismatches):
        raise ValueError(
            f"Checkpointed prediction or latent gradients differ: {mismatches}"
        )
    return {"actualCoarsePredictionAndBothGradientsBitsChanged": mismatches}


def run(args):
    original, hole, upstream = preflight(args.context, args.source, args.output)
    torch.set_num_threads(4)
    model = load_generator(args.source, args.checkpoint, args.config).requires_grad_(
        False
    )
    learned_before = weight_digest(model)
    from saicinpainting.training.modules.ffc import FFCResnetBlock

    split = next(
        i for i, module in enumerate(model.model) if isinstance(module, FFCResnetBlock)
    )
    front, rear = model.model[:split], model.model[split:]
    image, mask = torch.from_numpy(original), torch.from_numpy(hole)
    images, masks = upstream["_get_image_mask_pyramid"](
        {
            "image": image,
            "mask": mask,
            "unpad_to_size": [torch.tensor([SIDE]), torch.tensor([SIDE])],
        },
        min_side=512,
        max_scales=3,
        px_budget=SIDE * SIDE,
    )
    if (
        [list(v.shape[2:]) for v in images] != [[512, 512], [1024, 1024], [SIDE, SIDE]]
        or not torch.equal(images[-1], image)
        or not torch.equal(masks[-1], mask)
    ):
        raise ValueError("Upstream pyramid changed the native RAW model plate or hole")
    args.output.mkdir()
    started = time.perf_counter()
    checkpoint_control = qualify_checkpointing(front, rear, images[0], masks[0])
    print(json.dumps({"checkpointControl": checkpoint_control}), flush=True)
    steps, scales = [], []
    native_baseline = None
    original_loss = upstream["_l1_loss"]
    scale_index = 0

    def measured_loss(*values, **keywords):
        nonlocal native_baseline
        loss = original_loss(*values, **keywords)
        if not torch.isfinite(loss):
            raise ValueError("Nonfinite upstream consistency loss")
        if scale_index == 2 and native_baseline is None:
            baseline = values[0].detach().cpu().numpy().copy()
            native_baseline = checked_result(baseline, args.output, "baseline.f32")
        row = {
            "scale": scale_index,
            "iteration": sum(s["scale"] == scale_index for s in steps) + 1,
            "loss": float(loss.detach()),
            "elapsedSeconds": time.perf_counter() - started,
        }
        steps.append(row)
        print(json.dumps(row), flush=True)
        return loss

    upstream["_l1_loss"] = measured_loss
    result = None
    try:
        for scale_index, (current_image, current_mask) in enumerate(
            zip(images, masks, strict=True)
        ):
            print(
                json.dumps(
                    {"startingScale": scale_index, "shape": list(current_image.shape)}
                ),
                flush=True,
            )
            scale_started = time.perf_counter()
            result = upstream["_infer"](
                current_image,
                current_mask,
                front,
                [CheckpointedRear(rear)],
                result,
                current_image.shape[2:],
                [torch.device("cpu")],
                scale_index,
                n_iters=ITERATIONS,
                lr=LEARNING_RATE,
            )
            if not torch.isfinite(result).all():
                raise ValueError("Nonfinite upstream prediction")
            scales.append(
                {
                    "extentHW": list(current_image.shape[2:]),
                    "seconds": time.perf_counter() - scale_started,
                }
            )
            result.numpy().astype("<f4").tofile(
                args.output / f"scale-{scale_index}.f32"
            )
    finally:
        upstream["_l1_loss"] = original_loss
    elapsed = time.perf_counter() - started
    if native_baseline is None or weight_digest(model) != learned_before:
        raise ValueError("Missing native baseline or changed learned model state")
    final = result.numpy()
    known = np.broadcast_to(hole == 0, original.shape)
    if not np.array_equal(
        final.view(np.uint32)[known], original.view(np.uint32)[known]
    ):
        raise ValueError("Refinement changed a known native model input sample")
    result_digest = checked_result(final, args.output, "result.f32")
    report = {
        "releaseQualified": False,
        "contextFilesSHA256": {
            p.name: sha256(p) for p in sorted(args.context.iterdir())
        },
        "checkpointSHA256": sha256(args.checkpoint),
        "configSHA256": sha256(args.config),
        "refinementSHA256": sha256(
            args.source / "saicinpainting/evaluation/refinement.py"
        ),
        "learnedStateSHA256BeforeAndAfter": learned_before,
        "weightsChanged": False,
        "activationCheckpointing": checkpoint_control,
        "nativeSourceAndMaskResampled": False,
        "nativeSize": SIDE,
        "researchPixelBudget": SIDE * SIDE,
        "iterationsPerRefinedScale": ITERATIONS,
        "learningRate": LEARNING_RATE,
        "scales": scales,
        "optimizationSteps": steps,
        "baselineSHA256": native_baseline,
        "resultSHA256": result_digest,
        "knownModelInputBitsChanged": 0,
        "seconds": elapsed,
        "processPeakRSSBytes": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
        * (1 if sys.platform == "darwin" else 1024),
        "torch": torch.__version__,
        "device": "cpu",
        "scope": "Actual pinned upstream latent refinement on float native RAW model input. Research budget increased to admit the complete context; one CPU owner, frozen learned weights. Rear activations use non-reentrant checkpointing after actual prediction/gradient bit equality controls. Not app/ORT, physical-device performance, hidden-background quality or accepted XMP qualification.",
    }
    (args.output / "report.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report), flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ["context", "source", "checkpoint", "config", "output"]:
        parser.add_argument(name, type=Path)
    run(parser.parse_args())
