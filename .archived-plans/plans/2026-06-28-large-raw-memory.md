# Large-RAW memory architecture — bounded interactive rendering for 60–150 MP sensors

Status: proposal · Owner: TBD · Supersedes the stopgap in #1637/PR #1641 and the follow-up #1647
Date: 2026-06-28

## 1. Problem & current state

Opening a 100 MP RAW (12288×8192, the DJI Mavic 3 Pro / Hasselblad reference `test_0000.DNG`) on iPhone **jetsam-kills the app** at the ~6 GB iOS per-process limit. It is an OOM, not a code crash (`JetsamEvent`, `largestProcess = Maple Exposure`). The real-world trigger is opening a large library photo and adjusting sliders.

What we already established (measured / device A/B):

- **The CPU develop path is already bounded.** #1637 made the sized develop demosaic at half-sensor and **downsample immediately after demosaic** (before the long filter chain), and made the Auto-Profile fit develop at preview resolution. With GPU-live disabled (`MAPLE_GPU_LIVE=0`), the 100 MP opens and **survives**.
- **The remaining OOM is the GPU-live path.** With GPU-live on, the same open OOMs. The GPU path holds wgpu textures + per-stage storage buffers at the **retina display resolution** (an iPhone 17 Pro Max canvas is ~6000 px in device pixels), which — stacked on the CPU develop transient — crosses 6 GB.
- **Current stopgap (PR #1641):** gate GPU-live off for sensors > ~60 MP and fall back to the CPU two-phase path. This resolves the crash but disables the 16 ms GPU slider on exactly the large RAWs where it matters. That is the cost we want to remove.

## 2. Why sensor size matters even though the render is small

A Bayer RAW **cannot be reduced before the pipeline** — only after its two unavoidably sensor-sized steps:

1. **Decode** — the RAW file *is* the full sensor. `rawler` returns a full-res mosaic (~300 MB u16 at 100 MP; ~0.66 GB peak including its decompress scratch). `RawDecodeParams` exposes **no scale/shrink knob** (unlike LibRaw's `half_size`), so there is no "decode smaller".
2. **Demosaic** — each photosite is only R, *or* G, *or* B; you can only reduce *while* demosaicing (average each 2×2 RGGB quad → `half_res`, sensor/2 = 6144 px / 25 MP). We have **only** full (1:1) and `half_res` (2:1) — no quarter/eighth.

The downsample to display size is the **last** step (`downsample_image_area`, area-average, never upscales). So peak memory lives in decode + demosaic (sensor-dependent), and the small display buffer only exists afterward. This is why a 100 MP costs ~1.4 GB even for a tiny target, and why the GPU — which works *after* this, at display res — is what tips a 100 MP over while a 45 MP fits.

## 3. The established architecture (how this is "solved")

From primary sources (dcraw/LibRaw, darktable pixelpipe + tiling + mipmap_cache, RawTherapee, Adobe, WebGPU limits). One unifying principle:

> **Never compute more pixels than the consumer can use; let the requested output drive what gets decoded/demosaiced; tile when even that exceeds budget.**

- **Fit-to-window preview = display resolution.** A 4K screen shows ~8 MP; rendering 100 MP for a fit view wastes ~12×. darktable/RawTherapee/Capture One all bound the interactive preview to display res.
- **Backward ROI (darktable pixelpipe).** The requested output ROI (`{x,y,w,h,scale}`) propagates *backward* through the pipe (`modify_roi_in`), so decode/demosaic only touch the minimal input crop + scale. Neighborhood stages enlarge the ROI by their support radius (halo).
- **Auto-tone / profile fit on a small proxy.** darktable computes histograms/scopes and the exposure percentile from the *reduced-resolution preview pipe*, then applies the global parameter in the full pipe. A global tone curve has no spatial frequency content — a 1–4 MP proxy gives sub-0.1 % quantile error. **Caveat:** highlight-clip/white-point detection must be max-aware (average-pooling hides blown pixels), via a max-downsample or a cheap full-res threshold scan.
- **Tiled full-res export with halos.** The only full-res path is export; it tiles with per-stage overlap (PPG 8, AMaZE 6, RCD 10, X-Trans Markesteijn 12–18 px) for bit-identical recombination. On GPU this also satisfies the hard `maxTextureDimension2D = 8192` cap — a 12288 px image **cannot** be one wgpu texture regardless of RAM.
- **Preview pipe ≠ export pipe.** Every reduced-res/proxy path diverges from full-res export on neighborhood stages. The ACR pixel-parity gate must stay on the **full-res export pipe** (`maple-cli`); the preview/proxy paths sit *above* the parity contract.

## 4. Maple's current architecture (codebase map)

| Stage | Where | Bound today? |
|---|---|---|
| Decode | `raw-core/src/decode.rs` (`decode_bytes` → `rawler::decode`) | Full-res only (~300 MB). No scale knob. Floor. |
| Demosaic | `raw-core/src/demosaic/` — full (`bilinear`/`hamilton_adams`/`amaze`) + `half_res` (2:1) only | half_res for large/Preview; **no quarter/eighth** |
| Sized develop | `raw-core/src/pipeline/develop_sized.rs` — linearize (≈400 MB f32) → demosaic (half 300 MB / full 1.4 GB) → crop → `downsample.rs::downsample_image_area` → small chain | **CPU bounded (#1637)** — downsample is post-demosaic, never upscales |
| Auto-Profile fit | `raw-core/src/pipeline/render/auto_fit.rs` (`AUTO_FIT_SIZED_SENSOR_LE = 8000`) → develops at preview res; fits a tone curve + 49³ residual LUT vs the embedded JPEG | **Sized for >50 MP (#1637).** Uses aggregate stats, not detail |
| GPU fit | `GpuLiveSession.fitAutoProfile` → `maple_gpu_fit_auto_profile` → same CPU `fit_auto_profile_from_raw` at preview res | Sized (not a 2nd full develop) |
| GPU live present | wgpu chain at **retina display res**; textures + ≤4 storage buffers/stage | **NOT bounded** — the remaining OOM |
| Tiling | `raw-core/src/pipeline/tile/` — random-access tiles for deep zoom + panos (`sensor_linearize_region`, 48 px overlap) | Exists, but **not** used for cold-open or export streaming |

## 5. Phased plan

### M0 — Stopgap (done, shipping in PR #1641)
CPU bounds (#1637) + GPU-live large-sensor gate (conservative on unknown size for async-seeded library photos). Resolves the crash; large RAWs run CPU-only. **Keep as the safety net** until M1 lands.

### M1 — Bound the GPU-live working resolution (highest leverage; lifts the gate)
The direct fix for the proven OOM. The live preview is display-res anyway; the retina oversample is the waste.
- **First: instrument.** Surface `os_proc_available_memory()` from Swift (in-app HUD + a container file we pull via `devicectl`), and log the wgpu session's texture + storage-buffer byte totals at open/present. Confirm the GPU breakdown (textures vs per-stage buffers) before tuning — the two research passes disagree on the exact split.
- Cap the GPU present working resolution to a memory-safe display long edge (upscale to the drawable for the final blit); reuse the ping-pong texture set across slider ticks (already partly readback-free); audit per-stage storage buffers for reuse instead of per-stage allocation (honors the "no allocation in render loop" invariant, `≤4 storage buffers/stage`).
- **Exit criterion:** 100 MP opens with GPU-live ON under budget on Artemis; then raise/remove the `gpuLiveMaxSensorLongEdge` gate.

### M2 — Proxy Auto-Profile fit (robustness + parity-safe memory)
- Develop the fit at a **fixed small proxy** (target ~2–4 MP), spatially aligned with the embedded JPEG, independent of sensor size (today it's preview-res — make it an explicit proxy cap).
- Compute the curve **once**, propagate to CPU + GPU (single-source; avoids preview-vs-full drift).
- Highlight/white-point knot: max-aware downsample or a cheap full-res threshold-count scan (research caveat).
- **Parity:** the fit drives the Auto-Profile curve → gated by `baseline_auto` budgets. Tune the proxy res so ΔE doesn't move; ratchet budgets only downward.

### M3 — Backward-ROI render request (the general architecture)
- Introduce a render request carrying output ROI + scale; propagate backward to a minimal decode/demosaic region + scale (darktable `roi_in`/`roi_out`). Generalizes #1637's early-downsample and unifies cold-open / refine / deep-zoom.
- Add a **coarser demosaic divisor** (quarter via 4×4 quad area-average) for fit-views where half-res still oversamples — *preview pipe only, never exported* (the green-centroid diagonal CA makes quad-binning structurally non-parity).

### M4 — Tiled full-res export (memory + the wgpu 8192 cap)
- Tile the full-res develop with per-stage halos for bit-identical output; single-source per-stage tiling metadata (`factor`, `overhead`, `overlap`, halo radius) in raw-core (matches the codegen single-source discipline). Required for a GPU export path and bounds export to one tile.

### M5 — Dynamic memory budget
- Swift passes `os_proc_available_memory()` into FFI as the tiling/cap input (advisory). Degrades gracefully under pressure / on lower-RAM devices.

## 6. Parity contract (load-bearing)
- The ACR pixel-parity gate (`src/scripts/test_color_pipeline.sh`, `maple-cli`) runs on the **full-res export pipe**, never the preview/proxy pipe.
- Half-res/quad-bin demosaic and proxy fits are **preview-only**, never exported or gated.
- Global parameters (Auto-Profile curve, exposure) are computed **once on the proxy** and propagated — never recomputed per pipe.
- Per-stage tiling/halo metadata is single-sourced in raw-core.

## 7. Verification
- **Memory:** `os_proc_available_memory()` instrumentation (in-app + container file); the GPU-off A/B as the survives-baseline; per-stage byte logging.
- **Color:** ΔE harness (`test_color_pipeline.sh` + `budgets.json`) on the export pipe for fit/curve parity; `sized_display_tests`, `SliderMatrixUITests`, the grey harnesses.
- **On-device:** push the 100 MP fixture, launch via `MAPLE_UITEST_FIXTURE`, scan `systemCrashLogs` for jetsams after launch (existing workflow). Also test the **library/PhotoKit** path (async size seed) and a **second-image + slider** session — the real-world triggers a URL fixture can't reproduce.

## 8. Sequencing & recommendation
M0 ships now (crash fixed). **M1 is the next step** — it directly removes the proven GPU OOM and lets us lift the gate, restoring the 16 ms slider on large RAWs, with the smallest blast radius. M2 hardens the fit. M3/M4 are the broader architecture (enable ROI/zoom + a real export path + the WebGPU 8192 cap) and are larger, separable efforts. M5 is the safety net.

First concrete action under M1: the memory instrumentation, because every tuning decision (cap resolution, buffer count) should be driven by the measured GPU breakdown on the actual device, not estimates.
