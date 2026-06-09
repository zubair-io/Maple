# Live WebGPU render — manual verification (W3 user checkpoint, #925 P4b-web / #1029)

The live web canvas can render through the wgpu+WGSL GPU chain (`render_bytes_gpu`,
W1) instead of the WASM-CPU `render_bytes`, behind the `GPU_LIVE_RENDER_ENABLED`
flag (W2). Parity + the 16 ms slider-tick budget need a **real WebGPU browser** —
headless CI WebGPU is unreliable (Playwright Chromium is SwiftShader-only), so this
is a **maintainer checkpoint**, not an agent-closable gate. Sibling of the P0
`exposure-webgpu` and P1c `present-webgpu` harnesses; same build/serve recipe.

## What is already verified (autonomous, no browser)

- **W1 wasm parity (native/Metal proxy):** `render_gpu_core` (the platform-neutral
  body of `render_bytes_gpu`) vs the CPU `render_from_raw_with_quality_and_source`
  pipeline on the committed synthetic grey DNG, neutral + aggressive models →
  **max byte delta = 0, 0 / 12288 bytes differ**. Run:
  `cargo test -p raw-wasm --features gpu render_bytes_gpu_matches_cpu_render_bytes`.
- **GPU bundle compiles + wasm-bindgen-clean:** `wasm-pack build --target web
--features gpu` (RUSTFLAGS="") exports `render_bytes_gpu(raw, ext, xmp?) ->
Promise<MapleRender>` with no `duplicate string enums` collision.
- **Flag plumbing:** `raw-pipeline.gpu-flag.spec.ts` (flag-off → `gpu:false`,
  flag-on → `gpu:true`); full Maple-common vitest suite green.

## What this checkpoint covers (real browser only)

1. The live canvas renders the GPU pixels **within the per-fixture web budgets**
   of the CPU `render_bytes` (the SAME bar the W1 native gate uses — diff against
   the CPU bitmap, do not eyeball "looks right"; the ΔE / byte-delta number is the
   oracle). **Do NOT expect ≤1 LSB on a real RAW** — the W1 byte-exact result is a
   flat-Neutral synthetic DNG on Metal; the checkpoint opens a real RAW where two
   real, bounded divergences appear (see below).
2. A slider drag re-renders within the **16 ms** target / **50 ms** hard limit on
   the reference scene set (read DevTools → Performance → the `maple:wasm-gpu`
   User-Timing entry; compare to `maple:wasm` flag-off).

> **Expected (correct) parity divergences vs the CPU canvas — NOT regressions:**
>
> - **Auto Profile fit (#972):** `Profile::default()` is `Auto`. The GPU path fits
>   the curve/LUT via `fit_auto_profile_from_raw`, which zeroes NR + sharpen for
>   the fit; the CPU `render_bytes` fits via `apply_auto_profile` against the full
>   NR/sharpened buffer. So the baked tail differs marginally (a global + low-freq
>   fit target vs high-freq ops — near zero, but real). The two paths share the
>   `auto_profile` cache keyed on bytes, so **clear it between the CPU and GPU runs**
>   (or run them in separate sessions) or the number is run-order-dependent.
> - **Backend (Metal vs WebGPU):** the W1 ≤1 LSB was Metal; this checkpoint is
>   WebGPU. Identical WGSL, different backend → a few LSB on boundary pixels.
>
> Both are inside the loose web budgets; both are convergence toward the canonical
> render, documented for the maintainer so a correct GPU render isn't read as a fail.

> **Dehaze caveat (#1033):** dehaze-active scenes pay a per-tick mid-chain
> GPU→CPU airlight readback (C5a). The live path is **correct** for all scenes,
> but the 16 ms budget is NOT claimed for dehaze-active edits until the on-GPU
> airlight reduction (#1033) lands. Measure dehaze-off scenes for the perf gate.

> **Per-tick context/session cost (perf follow-up, NOT #1033):** the one-shot
> `render_bytes_gpu(bytes, ext, xmp)` signature this PR wires builds a FRESH
> `GpuContext` (fresh `OnceCell` pipeline cache, so ~35 WGSL pipelines recompile),
> re-decodes, and re-uploads the image on EVERY call. So even a dehaze-off slider
> tick is far over 16 ms today. Hitting the budget needs cross-tick context +
> `LiveSession` persistence (a pooled session keyed on the open image) — a separate
> follow-up on top of #1033. The render is correct; only the per-tick setup cost is
> unoptimized.

## Build the GPU bundle + wire it into the app

```bash
# 1. Build the single-threaded GPU bundle (RUSTFLAGS="" drops the rayon
#    shared-memory flags — wgpu and wasm-bindgen-rayon are mutually exclusive,
#    so the GPU bundle has NO thread pool; that is expected).
cd src/raw-pipeline/raw-wasm
RUSTFLAGS="" wasm-pack build --target web --release --out-dir pkg -- --features gpu

# 2. Sync it into maple-common (replaces the default parallel bundle).
bash ../../web/scripts/sync-raw-wasm.sh
```

Then provide the flag in the consuming app's `app.config.ts`:

```ts
import { GPU_LIVE_RENDER_ENABLED } from '@maple-common';
// ...
providers: [{ provide: GPU_LIVE_RENDER_ENABLED, useValue: true }],
```

```bash
cd src/web && bun x ng serve maple --port 4201
```

Open `http://localhost:4201` in a **WebGPU-capable browser** (Chrome/Edge ≥ 113,
or Safari Technology Preview). Open a RAW, drive the sliders, and:

- **Parity:** toggle the flag (rebuild without `--features gpu` for the CPU
  baseline, or provide `useValue: false`) and confirm the canvas matches. The
  worker tags the GPU render `maple:wasm-gpu` in the Performance panel so the two
  paths are distinguishable.
- **Perf:** confirm the `maple:wasm-gpu` measure is ≤ 16 ms (≤ 50 ms hard) on a
  dehaze-off reference scene.

## Notes / known boundaries

- **Flag-off == today, byte-for-byte.** With `GPU_LIVE_RENDER_ENABLED` false (the
  default) the worker calls `render_bytes` exactly as before. A flag-on request
  against a **gpu-off** bundle (one missing `render_bytes_gpu`) also falls back to
  `render_bytes` rather than throwing — so the app never breaks on a bundle mismatch.
- **Present target.** This checkpoint validates the GPU render via the existing
  display-p3 2D canvas (`ctx.drawImage` of the u8 readback) — already
  colour-correct. A zero-readback WebGPU-**surface** present (P1c's `present_web`
  to an `OffscreenCanvas`) is a further perf optimization, NOT wired in this PR;
  it would be a follow-up that this same checkpoint recipe validates.
- **Single-threaded.** The GPU bundle omits `initThreadPool`; the decode worker
  comes up single-threaded (the heavy work is on the GPU). The "single-threaded
  mode" UI badge will show — expected for this bundle.
