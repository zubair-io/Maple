"""#3941: shared-latent low-strength tiled refinement of frozen coarse fills.

Local research only. Same pinned SD1.5-family refiner for both coarse models.
All tile predictions are fused before one global scheduler step. No independent
per-tile generation, no training, and no change to original photos or live UI.
"""

import json
import resource
import time

import numpy as np
import torch
import torch.nn.functional as F
from common import CACHE, CASES, MODELS, REPO, ROOT, digest, load, save, write_json
from diffusers import AutoencoderKL, DDIMScheduler, UNet2DConditionModel
from transformers import CLIPTextModel, CLIPTokenizer

MODEL = CACHE / "powerpaint-model/realisticVisionV60B1_v51VAE"
STEPS = 40
STRENGTH = 0.25
CFG = 4.0
SEED = 3941
TILE = 64
STRIDE = 48
PROMPTS = {
    4: "Photograph of a continuous wooden tabletop, fine natural wood grain, same lighting and perspective, realistic surface texture.",
    2: "Photograph of an empty polished stone floor and stone wall, continuous architectural lines, subtle fine stone texture, same lighting and perspective.",
    1: "Photograph of metal railings and stone pavement, straight aligned railing bars, continuous architecture, same lighting and perspective.",
}
NEGATIVE = "person, people, human, face, body, silhouette, object, text, drawing, painting, warped lines, oversharpened"


def positions(n):
    return sorted(set(list(range(0, n - TILE + 1, STRIDE)) + [n - TILE]))


def verify():
    pins = json.loads(
        (REPO / "tools/removal/powerpaint-research-models.json").read_text()
    )
    files = [
        p for p in pins["files"] if p["path"].startswith("realisticVisionV60B1_v51VAE/")
    ]
    for item in files:
        p = CACHE / "powerpaint-model" / item["path"]
        assert p.stat().st_size == item["bytes"] and digest(p) == item["sha256"], p
    write_json(
        ROOT / "refiner-provenance.json",
        {
            "repository": pins["repository"],
            "revision": pins["revision"],
            "files": files,
            "component": "RealisticVision V6 B1 v5.1 VAE base, without PowerPaint BrushNet",
            "torch": torch.__version__,
            "steps": STEPS,
            "strength": STRENGTH,
            "guidance": CFG,
            "seed": SEED,
            "tileSourcePixels": 512,
            "minimumOverlapPixels": 128,
            "algorithm": "Shared noisy latent canvas; weighted noise fusion at every step, then one DDIM update; known latents reanchored to encoded guide.",
            "precision": "UNet/text fp16, VAE fp32; deterministic VAE mode",
            "scope": "Experimental common detail refiner, not a third removal candidate or a shipping dependency",
        },
    )


def embeddings(case, tokenizer, encoder):
    toks = tokenizer(
        [NEGATIVE, PROMPTS[case]],
        padding="max_length",
        max_length=tokenizer.model_max_length,
        truncation=True,
        return_tensors="pt",
    )
    return encoder(toks.input_ids.to("mps"))[0]


@torch.inference_mode()
def run():
    torch.set_num_threads(4)
    verify()
    start = time.perf_counter()
    unet = (
        UNet2DConditionModel.from_pretrained(
            str(MODEL),
            subfolder="unet",
            local_files_only=True,
            torch_dtype=torch.float16,
        )
        .eval()
        .to("mps")
    )
    vae = (
        AutoencoderKL.from_pretrained(
            str(MODEL),
            subfolder="vae",
            local_files_only=True,
            torch_dtype=torch.float32,
        )
        .eval()
        .to("mps")
    )
    vae.enable_tiling()
    encoder = (
        CLIPTextModel.from_pretrained(
            str(MODEL),
            subfolder="text_encoder",
            local_files_only=True,
            torch_dtype=torch.float16,
        )
        .eval()
        .to("mps")
    )
    tokenizer = CLIPTokenizer.from_pretrained(
        str(MODEL), subfolder="tokenizer", local_files_only=True
    )
    print(json.dumps({"loadedSeconds": time.perf_counter() - start}), flush=True)
    w = torch.sin(torch.linspace(0.02, np.pi - 0.02, TILE, device="mps")).square()
    weight = (w[:, None] * w[None, :])[None, None]
    for case in CASES:
        embed = embeddings(case, tokenizer, encoder)
        for model in MODELS:
            parent, _meta, source, cov, _protect, native, guide = load(case, model)
            if (parent / model / "diffusion.json").exists():
                continue
            begin = time.perf_counter()
            tensor = (
                torch.from_numpy(np.ascontiguousarray(guide.transpose(2, 0, 1)))[
                    None
                ].to("mps")
                * 2
                - 1
            )
            clean = vae.encode(tensor).latent_dist.mode() * vae.config.scaling_factor
            assert torch.isfinite(clean).all()
            control = (
                vae.decode(clean / vae.config.scaling_factor).sample[0].float() / 2
                + 0.5
            ).clamp(0, 1)
            save(
                case,
                model,
                "vae-control",
                control.cpu().numpy().transpose(1, 2, 0),
                {
                    "description": "VAE encode/decode only, no diffusion. Separates codec change from denoising."
                },
            )
            del control, tensor
            clean = clean.half()
            height, width = clean.shape[-2:]
            mask = F.max_pool2d(
                torch.from_numpy((cov > 0).astype("float32"))[None, None].to("mps"),
                8,
                8,
            ).half()
            tiles = [
                (y, x)
                for y in positions(height)
                for x in positions(width)
                if bool(mask[:, :, y : y + TILE, x : x + TILE].any())
            ]
            denom = torch.zeros(
                (1, 1, height, width), device="mps", dtype=torch.float32
            )
            for y, x in tiles:
                denom[:, :, y : y + TILE, x : x + TILE] += weight
            assert bool((denom[mask.bool()] > 0).all())
            scheduler = DDIMScheduler.from_pretrained(
                str(MODEL), subfolder="scheduler", local_files_only=True
            )
            scheduler.set_timesteps(STEPS, device="mps")
            timesteps = scheduler.timesteps[STEPS - int(STEPS * STRENGTH) :]
            noise = (
                torch.randn(
                    clean.shape,
                    generator=torch.Generator(device="cpu").manual_seed(SEED),
                    dtype=torch.float32,
                )
                .to("mps")
                .half()
            )
            latent = scheduler.add_noise(clean, noise, timesteps[:1])
            logs = []
            for step, t in enumerate(timesteps):
                sums = torch.zeros_like(latent, dtype=torch.float32)
                for y, x in tiles:
                    crop = latent[:, :, y : y + TILE, x : x + TILE]
                    inp = scheduler.scale_model_input(torch.cat([crop, crop]), t)
                    pred = unet(inp, t, encoder_hidden_states=embed).sample
                    unconditional, conditional = pred.chunk(2)
                    predicted = unconditional + CFG * (conditional - unconditional)
                    assert torch.isfinite(predicted).all()
                    sums[:, :, y : y + TILE, x : x + TILE] += predicted.float() * weight
                fused = (sums / denom.clamp_min(1e-12)).half()
                latent = scheduler.step(fused, t, latent, eta=0).prev_sample
                anchor = (
                    scheduler.add_noise(clean, noise, timesteps[step + 1 : step + 2])
                    if step + 1 < len(timesteps)
                    else clean
                )
                latent = latent * mask + anchor * (1 - mask)
                assert torch.isfinite(latent).all()
                torch.mps.synchronize()
                row = {
                    "case": case,
                    "coarse": model,
                    "step": step + 1,
                    "steps": len(timesteps),
                    "tiles": len(tiles),
                    "seconds": time.perf_counter() - begin,
                    "mpsBytes": torch.mps.driver_allocated_memory(),
                }
                logs.append(row)
                print(json.dumps(row), flush=True)
                write_json(ROOT / "diffusion-progress.json", row)
            decoded = (
                vae.decode(latent.float() / vae.config.scaling_factor).sample[0] / 2
                + 0.5
            ).clamp(0, 1)
            assert torch.isfinite(decoded).all()
            output = decoded.cpu().numpy().transpose(1, 2, 0).astype("float32")
            save(
                case,
                model,
                "diffusion",
                output,
                {
                    "seconds": time.perf_counter() - begin,
                    "steps": logs,
                    "prompt": PROMPTS[case],
                    "negativePrompt": NEGATIVE,
                    "strength": STRENGTH,
                    "seed": SEED,
                    "tileCoordinatesLatentYX": tiles,
                    "knownLatentsAnchoredEveryStep": True,
                    "sharedNoiseCanvas": True,
                    "peakProcessRSSBytes": resource.getrusage(
                        resource.RUSAGE_SELF
                    ).ru_maxrss,
                },
            )
            del (
                decoded,
                clean,
                latent,
                output,
                guide,
                native,
                source,
                noise,
                sums,
                fused,
            )
            torch.mps.empty_cache()
    print("DIFFUSION COMPLETE", flush=True)


if __name__ == "__main__":
    run()
