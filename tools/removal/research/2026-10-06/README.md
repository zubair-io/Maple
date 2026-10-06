# Native-detail experiment — October 6, 2026

Completed standalone research for [#3941](https://github.com/zubair-io/Maple/issues/3941), following the [October 5 checkpoint](../2026-10-05/README.md). No app integration or release qualification.

## Comparison

Three RAW scenes (wood, indoor floor, outdoor railing) × two frozen 512 coarse predictions (LaMa and Qwen seed 0) × three methods = **18 outputs**. Six additional VAE encode/decode controls isolate image-codec changes. Every method uses the same +16 expanded native coverage and protection from the previous experiment. The indoor floor already has a flawed coarse tonal/structural fill and is explicitly a stress case.

1. Bilinear enlargement, reproducing the previous experiment.
2. Existing RGB-guided PatchMatch prototype: translation-only native donor patch voting. Protected regions are excluded as donors; final protected pixels are restored by the unchanged mask. This does not implement semantic/depth guidance or published auto-curation.
3. One common generative refiner applied to both coarse models: pinned RealisticVision V6 B1 v5.1 VAE base from the existing PowerPaint research bundle, without BrushNet. DDIM uses 10 steps from a 40-step schedule at strength 0.25, CFG 4, seed 3941. A shared noisy latent canvas supplies 512-pixel windows with at least 128-pixel overlap. Tile noise predictions are fused before each global scheduler update, and known latents are reanchored each step. UNet/text use fp16; VAE uses fp32. This is not an independent inpaint for each tile or a direct high-resolution Qwen run.

Reference mechanisms: [Guided PatchMatch](https://arxiv.org/abs/2208.03552) and [MultiDiffusion](https://multidiffusion.github.io/). These are limited independently authored research variants, not full reproductions of either paper.

## Findings

User review (October 6, including the outdoor-railing correction): **method 2, guided texture transfer, wins this round with both LaMa and Qwen. There is no overall coarse-model winner.** The initial preference was LaMa; after reviewing the outdoor railing, the user preferred Qwen with the same transfer method for that scene. Retain both candidates for scene-dependent selection. The tested method 3, shared-latent diffusion, was rejected across the reviewed outputs. See `evidence/user-review.json` for the attributed decision; the original technical observations below and frozen run evidence are preserved.

Texture transfer is the more promising of these two tested refiners, but neither qualifies native removal. It adds local texture on wood and stone while leaving softness, tonal remnants and changed/repeated architecture. The tested diffusion setup creates conspicuous smooth, mask-shaped regions and damages railing structure with both starting models. Its failure does not rule out a dedicated refinement/super-resolution model or other settings.

All **432 RAW outside-coverage/protection checks passed** across 24 outputs/controls × 18 Auto/Neutral, exposure and WB grades. Frozen inputs and all five original RAW hashes are unchanged. All six bilinear plate outputs and their 108 RAW grade renders match the previous baseline pixel-for-pixel. These preservation checks do not establish quality inside the fill. No hidden-background ground truth exists.

See `evidence/findings.json` and `evidence/summary.json` for the record. Timings are observational on the current Mac, not controlled deployment benchmarks. Neither coarse model is discarded by this experiment.

## Review and recovery

Live local gallery: <http://127.0.0.1:8771/native-detail-20261006/>. It provides LaMa/Qwen selection, three methods side by side, original comparison, fit/100% views with synchronized scrolling and centering, RAW Auto/Neutral exposure/WB controls, and the VAE-only control.

Working output root:
`/Users/riabuz/.cache/maple-removal-research/three-model-quality-20261005/native-detail-20261006/`

Preserved local copy:
`/Users/riabuz/Documents/Maple Research/native-detail-2026-10-06/`

These are same-disk results, not off-device backups. Photos, predictions, generated images, model weights and binary executables are not uploaded to GitHub. Source, pins, findings and validation receipts are committed. The artifact backup has `executed-harness/` for exact runner bytes; committed copies receive formatting/lint cleanup afterward.

To review the saved copy without inference:

```bash
python3 -m http.server 8772 --bind 127.0.0.1 \
  --directory '/Users/riabuz/Documents/Maple Research/native-detail-2026-10-06'
```

Open `http://127.0.0.1:8772/`. The previous-experiment navigation link is relative to the working gallery tree; use its separate preserved gallery when serving this standalone backup.

## Harness entry points

- `prepare.py`: freeze inputs into a fresh directory; refuses an existing output root.
- `run_patchmatch.py`: bilinear and native-donor comparisons.
- `run_diffusion.py`: verify pinned local refiner files, generate codec controls and shared-latent refinement. Requires the existing `powerpaint-env` with PyTorch/MPS and local model files.
- `bake.py`: run the research Rust binary and validate all RAW grades. Bilinear grades must exactly match the older saved outputs.
- `summarize.py`: independently verify outputs, frozen inputs and original hashes; produce review sheets and summary.
- `gallery.py` / `report.py`: render local review pages.

Paths are explicit local research paths in `common.py`, not production settings. Do not rerun preparation over saved evidence. Use a new directory and record any changed settings for a new experiment.

The shared cache's Rust executable had changed since the older run. This experiment rebuilt it from the isolated checkpoint source and copied the executable into its output root. `evidence/probe-build.json` records that identity. Pixel-identical reproduction of all baseline grades confirms the rebuild did not change this comparison's baseline. No unrelated camera-mapping edit was included.

The production slider path, XMP contract and Mac UI were not changed. Follow-up decisions remain in #3941; do not promote this research branch as a completed feature.
