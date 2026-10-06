import argparse
import hashlib
import json
import resource
import time
from pathlib import Path

import numpy as np
import removal.v1_2.pipeline as upstream_pipeline
import torch
from diffusers import AutoencoderKL, DDIMScheduler
from PIL import Image
from removal.v1_2.pipeline import RemovalSDXLPipeline_BatchMode
from removal.v1_2.removal_model import build_removal_model

r = Path(__file__).parent
cache = r.parent
parser = argparse.ArgumentParser()
parser.add_argument("--cases", nargs="+", type=int, default=[4, 1, 2, 3])
parser.add_argument("--seeds", nargs="+", type=int, default=[0, 1])
args = parser.parse_args()
torch.set_num_threads(4)
device = "mps"
dtype = torch.float32
weights = cache / "moebius-weights"
checkpoint = weights / "Moebius/ft_places2/diffusion_pytorch_model.bin"
vae_weights = weights / "PixelHacker/vae/diffusion_pytorch_model.bin"
assert (
    hashlib.sha256(checkpoint.read_bytes()).hexdigest()
    == "6525afb888e55f9b5c74fa0a5d19ca0762d720d6c716fb0f8422fbeb6868a09a"
)
assert (
    hashlib.sha256(vae_weights.read_bytes()).hexdigest()
    == "a59d7ea697f2942d22002dc3469e8c53db807a6b78f7f5ec03bd4c1f70f98efe"
)
t = time.perf_counter()
model = build_removal_model(
    str(cache / "moebius-runtime/config/model_cfg/moebius.yaml"), 20
)
model.load_state_dict(
    torch.load(checkpoint, map_location="cpu", weights_only=True), strict=True
)
model.requires_grad_(False).eval()
vae = AutoencoderKL.from_config(
    json.loads((vae_weights.parent / "config.json").read_text())
)
vae.load_state_dict(
    torch.load(vae_weights, map_location="cpu", weights_only=True), strict=True
)
vae.requires_grad_(False).eval()
reference_encode = vae.encode


def checked_encode(*a, **kw):
    encoded = reference_encode(*a, **kw)
    if (
        not torch.isfinite(encoded.latent_dist.mean).all()
        or not torch.isfinite(encoded.latent_dist.logvar).all()
    ):
        raise ValueError("nonfinite VAE posterior")
    return encoded


vae.encode = checked_encode
scheduler = DDIMScheduler(
    beta_start=0.00085,
    beta_end=0.012,
    beta_schedule="scaled_linear",
    num_train_timesteps=1000,
    clip_sample=False,
)
# At strength=1 upstream skips add_noise(), which normally moves scheduler tensors.
scheduler.alphas_cumprod = scheduler.alphas_cumprod.to(device)
pipe = RemovalSDXLPipeline_BatchMode(model, vae, scheduler, device=device, dtype=dtype)
# Only diagnostics wrap the actual upstream denoising call, no math change.
reference_predict = upstream_pipeline.predict_noise
step_index = 0


def predict(*a, **kw):
    global step_index
    result = reference_predict(*a, **kw)
    if not torch.isfinite(result).all():
        raise ValueError("nonfinite noise prediction")
    step_index += 1
    if step_index % 5 == 0:
        print(
            json.dumps({"step": step_index, "elapsed": time.perf_counter() - t}),
            flush=True,
        )
    return result


upstream_pipeline.predict_noise = predict
print(
    json.dumps(
        {
            "status": "loaded",
            "device": device,
            "dtype": str(dtype),
            "modelParameters": sum(p.numel() for p in model.parameters()),
            "vaeParameters": sum(p.numel() for p in vae.parameters()),
            "loadSeconds": time.perf_counter() - t,
        }
    ),
    flush=True,
)
for i in args.cases:
    p = r / f"case-{i}"
    source = np.array(Image.open(p / "source.png").convert("RGB"))
    rgb = source.astype("float32") / 255
    if (p / "input.f32").exists():
        rgb = (
            np.fromfile(p / "input.f32", dtype="<f4")
            .reshape(3, 512, 512)
            .transpose(1, 2, 0)
        )
        assert np.isfinite(rgb).all() and rgb.min() >= 0 and rgb.max() <= 1
    hole = np.array(Image.open(p / "hole.png")) > 0
    coverage = np.fromfile(p / "coverage.f32", dtype="<f4").reshape(512, 512)
    for seed in args.seeds:
        target = p / f"moebius-fullnoise-seed{seed}.png"
        if target.exists():
            raise FileExistsError(target)
        torch.manual_seed(seed)
        np.random.seed(seed)
        step_index = 0
        image = (
            torch.from_numpy(rgb.transpose(2, 0, 1).copy()).unsqueeze(0).to(device) * 2
            - 1
        )
        mask = (
            torch.from_numpy(hole.astype("float32"))
            .unsqueeze(0)
            .unsqueeze(0)
            .to(device)
        )
        masked = image * (1 - mask)
        print(json.dumps({"case": i, "seed": seed, "status": "inference"}), flush=True)
        t = time.perf_counter()
        with torch.inference_mode():
            output = pipe._denoise_steps(
                image,
                mask,
                masked,
                num_steps=20,
                strength=1.0,
                noise_offset=0.0357,
                guidance_scale=2.5,
                mute=True,
            )
        torch.mps.synchronize()
        duration = time.perf_counter() - t
        pred = output[0].permute(1, 2, 0).cpu().numpy()
        assert pred.shape == (512, 512, 3) and np.isfinite(pred).all()
        clipped = np.clip(pred, 0, 1)
        out = rgb * (1 - coverage[:, :, None]) + clipped * coverage[:, :, None]
        assert np.array_equal(
            out[coverage == 0].view("uint32"), rgb[coverage == 0].view("uint32")
        )
        out = np.floor(out * 255 + 0.5).clip(0, 255).astype("uint8")
        assert np.array_equal(out[coverage == 0], source[coverage == 0])
        Image.fromarray(out).save(target)
        Image.fromarray(np.round(clipped * 255).astype("uint8")).save(
            p / f"moebius-fullnoise-seed{seed}-uncomposited.png"
        )
        clipped.transpose(2, 0, 1).astype("<f4").tofile(
            p / f"moebius-fullnoise-seed{seed}.f32"
        )
        report = {
            "case": i,
            "seed": seed,
            "device": device,
            "stepsRequested": 20,
            "actualDenoiseSteps": step_index,
            "strength": 1.0,
            "guidance": 2.5,
            "noiseOffset": 0.0357,
            "inferenceSeconds": duration,
            "processPeakRSSBytes": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss,
            "mpsDriverBytes": torch.mps.driver_allocated_memory(),
            "outsideCoverageChangedPixels": 0,
            "resolution": 512,
            "nativeDetailQualified": False,
            "rawQualified": False,
            "floatInput": (p / "input.f32").exists(),
        }
        (p / f"moebius-fullnoise-seed{seed}.json").write_text(
            json.dumps(report, indent=2) + "\n"
        )
        print(json.dumps(report), flush=True)
