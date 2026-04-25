# Optimize nr_color (chroma noise reduction in Oklab)

## Context

After commit [ed96688](../../src/raw-pipeline/raw-core/src/pipeline.rs) added
per-stage timing via `MAPLE_PROFILE`, the baseline on `test_0002.dng`
(M-series, release build) revealed `nr_color` dominates total pipeline wall
time. **2.46 s out of ~2.62 s — over 93% of the cold-open render budget.**
Every other stage combined is ~150 ms.

Full baseline for reference:

```
[raw-core] linearize                         14.26ms
[raw-core] demosaic                          23.79ms
[raw-core] highlight_recovery                 1.00µs
[raw-core] dcp::profile_for                  18.29µs
[raw-core] dcp::apply                        11.84ms
[raw-core] white_balance                    958.00ns
[raw-core] scene_tone_controls              250.00ns
[raw-core] vibrance                         167.00ns
[raw-core] saturation                       958.00ns
[raw-core] clarity                          542.00ns
[raw-core] texture                          208.00ns
[raw-core] dehaze                           333.00ns
[raw-core] sharpen                          333.00ns
[raw-core] nr_luminance                     15.71µs
[raw-core] nr_color                           2.46s
[raw-core] agx                              29.33ms
[raw-core] rec2020_to_srgb                   3.16ms
[raw-core] quantize_u8                      69.25ms
[raw-core] apply_orientation                 2.04ms
```

This is at the default `nr_color = 25` (matching ACR's default), which resolves
to blur `radius = 1` per the `amount * 4` scale factor at
[`noise_reduction.rs:44`](../../src/raw-pipeline/raw-core/src/stages/noise_reduction.rs:44).
Even at radius 1 the stage is 100× the next-heaviest pipeline step.

Current implementation at
[`src/raw-pipeline/raw-core/src/stages/noise_reduction.rs:41`](../../src/raw-pipeline/raw-core/src/stages/noise_reduction.rs:41):

1. Allocate an `Image` and convert every pixel Rec.2020 → Oklab
   (two matrix mults + a cbrt per pixel).
2. Allocate another 3-channel `Image`, copy `(a, b, 0.0)` into it.
3. Call
   [`gaussian_blur_rgb`](../../src/raw-pipeline/raw-core/src/stages/blur.rs:66)
   — which runs six box-blur passes (3 passes × 2 axes) on **all three
   channels**, including the zero-filled B plane.
4. Copy blurred (a, b) back into `oklab_img`.
5. Convert every pixel Oklab → Rec.2020 back into the original image.

So for 100 MP the stage does: 2× full-image color-space conversions
(~8 FMAs + 2 cbrts per pixel), 3× redundant plane allocations, and 50% wasted
blur work on a channel of zeros.

## Proposal

Investigate on **two orthogonal axes** and pick the combination that clears the
16 ms slider-tick budget from CLAUDE.md § "Performance invariants":

### Algorithmic

- **Blur only the (a, b) planes.**
  `gaussian_blur_plane` already exists in
  [`blur.rs:54`](../../src/raw-pipeline/raw-core/src/stages/blur.rs:54). Calling
  it twice drops the blur work by ~33% vs. the current 3-channel detour and
  removes two allocations.
- **Avoid the Oklab round-trip when possible.** Consider a perceptually-close
  chroma decorrelation directly in Rec.2020 (e.g. Y'CbCr-style separation via
  a cheap 3×3 matrix). The Rec.2020 ↔ Oklab cbrts are the per-pixel cost, not
  the blur itself — skipping them would likely dominate any blur-side win.
- **Tighten the radius scale.**
  `radius = ceil(amount/100 * 4)` means the default `amount = 25` produces the
  same radius as `amount = 1`. A scale like `(amount/100 * 2).round()` would
  let `amount < 25` pay less, with no visible change above 25.
- **Frequency-domain blur** (FFT convolve) for large radii. Probably overkill
  at radius 1–4 but keep on the table for the NLM implementation that
  [`noise_reduction.rs:1-4`](../../src/raw-pipeline/raw-core/src/stages/noise_reduction.rs:1)
  flags as the eventual target — NLM's effective kernel is much wider.
- **Separable kernel reuse.** The three box-blur passes currently allocate
  a fresh `Vec` for every pass
  ([`blur.rs:29,32,44`](../../src/raw-pipeline/raw-core/src/stages/blur.rs:29)).
  Two ping-pong buffers instead of N fresh allocations would cut allocator
  pressure significantly at 100 MP.

### Parallel

- **`rayon::par_iter` the scanline loops inside `box_blur_channel`.**
  Each row / column pass is embarrassingly parallel on a single-channel plane.
  Current implementation is strictly serial.
- **Per-tile parallelism** at the `apply_color` level: split the image into
  horizontal strips with `radius` rows of overlap per strip, blur each strip
  on its own thread, stitch. Works well with a future tiled renderer
  (see [ticket #03](./03-cicontext-tiled-render.md)).
- **SIMD.** The Oklab conversion and the box-blur inner loops are both
  amenable to `std::simd` / `wide`. Four-wide f32 is 4× on the per-pixel math
  for effectively free.
- **P-core pinning on Apple Silicon.** The timing is from a release build on
  an M-series chip; if `rayon` is scheduling onto E-cores during a cold open
  the ceiling is much lower than the core count suggests.

## Acceptance criteria

- `nr_color` on the reference 100 MP DNG
  (`test-fixtures/raws/dji-mavic3pro-100mp.dng`) drops below ~50 ms at
  `amount = 25` — i.e. no longer the dominant stage, and fits inside the
  16 ms slider-tick budget for the Preview quality (half-res).
- `scripts/test_color_pipeline.sh` still passes — chroma denoising is a
  visual quality lever, but the harness uses `amount = 25` as ACR default
  and must not regress.
- Existing `raw-core` unit tests pass (`zero_color_is_identity`,
  `luminance_smooths_without_killing_color`, etc.).
- No new allocation in the render loop per-slider-tick
  (CLAUDE.md § "Performance invariants").

## Pointers

- `src/raw-pipeline/raw-core/src/stages/noise_reduction.rs:41` — `apply_color`.
- `src/raw-pipeline/raw-core/src/stages/blur.rs` — `gaussian_blur_rgb` and the
  plane variant that should replace it here.
- `src/raw-pipeline/raw-core/src/color/oklab.rs` — `rec2020_to_oklab` /
  `oklab_to_rec2020`, the cbrt-heavy path that likely dominates.
- `src/raw-pipeline/raw-core/src/pipeline.rs:122` — call site inside
  `render_from_raw_with_quality`.
- To re-measure after a change:
  `MAPLE_PROFILE=1 cargo run --release -p raw-core --example stage-trace` or
  the `maple-cli batch` invocation from commit ed96688's Step 5.

## Notes / risks

- This is not a bug fix — `apply_color` is correct. It's a perf-only ticket,
  so color parity (`test_color_pipeline.sh`) is the merge gate.
- The current implementation is flagged in-file as a "slice-5 shim" awaiting a
  proper NLM pass. Any optimization should be written so it composes with the
  eventual NLM — e.g. pulling the Oklab round-trip out into a helper that NLM
  can reuse.
- Preview path runs at half-res
  ([`pipeline.rs:47`](../../src/raw-pipeline/raw-core/src/pipeline.rs:47)
  `demosaic::half_res`), so `nr_color` at 2.46 s is already operating on a
  25 MP image — scaling that to Full-quality renders would be ~4× worse.
- The **optimization itself needs its own brainstorm + spec round** before a
  full implementation plan — the two axes above are the search space, not a
  chosen direction.

## Estimated impact

If `nr_color` drops from 2.46 s to ~50 ms, total cold-open Rust pipeline time
goes from ~2.62 s → ~200 ms on the reference fixture — a ~13× speedup for the
same output. That moves the dominant cost back to CoreImage / GPU-side work
(addressed by [ticket #01](./01-decode-direct-to-mtltexture.md) and
[ticket #02](./02-display-resolution-preview.md)) where the remaining budget
lives.
