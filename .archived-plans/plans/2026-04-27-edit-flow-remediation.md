# Edit-flow remediation — making the user story green

**Status:** Draft
**Owner:** Zubair
**Last updated:** 2026-04-27
**Story:** [user-story-edit-flow.md](../../user-story-edit-flow.md)

## TL;DR

The "open → adjust → export" story is broken on Apple in **four** independent ways, visible at both fit-zoom and 100% zoom. None of them are caused by deep-zoom (which is gated off by default). **Fix the existing flow first; do not enable deep-zoom yet** — turning it on would compound the color and timing bugs because the per-tile composite path inherits the same FFI hot-path and adds boundary artifacts on top.

Order of work: **(1) restore color parity at default sliders, (2) fix the slider hot-path so 16 ms is achievable at fit, (3) fix the visible-region refine so 100% zoom is achievable in budget, (4) eliminate the fast/refine color flip and the "first paint flashes" violation.** Then evaluate deep-zoom on a green baseline.

---

## Evidence

Color harness on the committed reference set ([`src/scripts/test_color_pipeline.sh`](../../../src/scripts/test_color_pipeline.sh), `BUDGET=15`):

```
FAIL test_0000   mean=13.20 p95=37.56 max=82.53 bias=(+0.052,+0.047,+0.051)
PASS test_0006   mean= 8.41 p95=12.34 max=27.50 bias=(-0.043,+0.004,-0.030)
FAIL test_0007   mean=10.67 p95=31.83 max=86.47 bias=(-0.098,-0.056,-0.018)
FAIL test_0015   mean=14.34 p95=25.29 max=58.59 bias=(+0.001,-0.089,-0.148)
FAIL test_0017   mean=10.11 p95=21.56 max=84.07 bias=(-0.075,-0.077,-0.054)

1 pass, 4 fail, 2 skip
```

Four of seven fixtures fail `p95`/`max`/`bias` budgets. test_0017 is the same fixture the UITest visual harness uses for the baseline open. The unwind in [ba8e0ec](../../../src/raw-pipeline/raw-core/src/decode.rs) explicitly raised `mean ΔE` 12.46 → 13.49 vs ACR; that's the "colors don't match reference" the user is seeing on open.

---

## Root causes (diagnosed, with file:line)

### A. Color is too dark / off vs reference at default sliders

1. [ba8e0ec](https://github.com/_/_) removed `MAPLE_AGX_BASELINE_COMPENSATION_EV = +0.65` and set `AE_DAMPING = 0.0`. The unwind is architecturally correct (don't tune AgX toward ACR) but it leaves Maple ~1.5 EV darker than the reference XMPs the team has been working against. The reference set was implicitly recalibrated to "Maple-with-bias" before, so it now reads as wrong.
2. Per-fixture biases are negative across most channels (Maple < ACR) — consistent with a global brightness regression, not per-pixel noise.

**This is a calibration problem, not a pipeline correctness problem.** The pipeline is doing what it was rewritten to do. The references were written against the prior brightness.

### B. Slider tick is way over the 16ms budget

Per-tick path: [ImageEditPipeline.swift:425-477](../../../src/apple/Packages/MapleCore/Sources/MapleCore/ImageEditPipeline.swift)

1. `Data(count: totalBytes)` — at viewport ~2-3 MP fp16 RGBA = **22 MB allocation, every tick**. Same allocation on the output. ~44 MB/tick × 60 Hz drag = **2.6 GB/s allocation pressure**, no buffer pooling.
2. `context.render(scaled, toBitmap:...)` materializes the entire lazy CoreImage chain (orientation, decode normalize, prescale) into bytes synchronously off-main but **on the slider critical path**.
3. Hop into Rust via `apply_scene_linear_chain` ([pipeline.rs:475](../../../src/raw-pipeline/raw-core/src/pipeline.rs)) — itself allocates `Vec<[f32;3]>` of pixel_count × 12 bytes (line 504), runs 9 stages on CPU, repacks fp16 (line 547). On a 2 MP viewport this single FFI call is the dominant tick cost.
4. Wrap output bytes back into `CIImage(bitmapData:)`, which copies into a CoreImage-managed buffer.
5. **Then** sharpen + nr_color run as separate Metal kernels post-AgX (display-linear domain — a known behavior change called out at lines 603–614 of `ImageEditPipeline.swift`).

50ms `Task.sleep` debounce ([EditSession.swift:1132](../../../src/apple/Packages/MapleCore/Sources/MapleCore/EditSession.swift)) on top of all the above means a slider drag at 120 Hz can drop most ticks but every surviving tick is structurally too slow.

**Architectural observation:** "Option C" collapsed 9 GPU kernels into 1 CPU-resident Rust call. This was correct for parity (the Metal copies had drift), but **it traded GPU throughput for CPU throughput at viewport size** — which is the worst direction for the slider hot-path. The cheap stages run faster as 9 GPU kernels than as one CPU function call across the FFI boundary, even with rayon.

### C. Visible-region refine pays full-image FFI cost at 100% zoom

This is what makes the bugs reproduce at 100% just as badly as at fit.

At `pixelScale = 1.0` on a 100 MP RAW:
- `fastTargetSize` = viewport (~2-3 MP). Fast phase runs the FFI chain at viewport extent. ~50 ms-class.
- `refinedTargetSize` = `nativeImageSize × 1.0` = **the full sensor (~96 MP)**.

The visible-region refine path ([EditSession.swift:1224-1268](../../../src/apple/Packages/MapleCore/Sources/MapleCore/EditSession.swift)) was added to avoid materializing the whole 96 MP — it crops the output to `visibleRect` before `createCGImage`. **But the crop is on the wrong side of the FFI.** The call sequence:

1. `processSceneLinear(decoded: cached, model, targetSize: nil, ...)` — `targetSize: nil`, so no prescale; chain runs at full native extent of `cached`.
2. Inside, `applySceneLinearChainViaFFI(scaled)` reads `scaled.extent` ([ImageEditPipeline.swift:415](../../../src/apple/Packages/MapleCore/Sources/MapleCore/ImageEditPipeline.swift)) — full native 96 MP.
3. `context.render(scaled, toBitmap:..., bounds: full extent)` ([line 429](../../../src/apple/Packages/MapleCore/Sources/MapleCore/ImageEditPipeline.swift)) materializes **all 96 MP** into a 768 MB fp16 RGBA buffer.
4. Rust FFI runs every stage on every pixel — **9 stages × 96 M pixels** even with rayon is north of a second on a Mac, multi-second on iPad.
5. Output wrapped as CIImage at full extent, returned to caller.
6. Caller does `chain.cropped(to: visibleRect)` ([EditSession.swift:1260](../../../src/apple/Packages/MapleCore/Sources/MapleCore/EditSession.swift)) — but this is just a metadata crop on already-materialized bytes. The work is done.
7. `materializeRegion(cropped, rect: visibleRect)` ([line 1261](../../../src/apple/Packages/MapleCore/Sources/MapleCore/EditSession.swift)) only crops the output blit, not the FFI work.

**Net at 100%: every refine pays full-image FFI cost regardless of viewport.** That is the "long time to apply back" the user is reporting at 100%. The refine debounce (250 ms) hides nothing — it's all the FFI's full-image scan.

### D. Fast → refine produces a visible color/resolution swap

1. **Different demosaic at fast vs refine.** Fast uses half-res demosaic (4×4 averaged after [03aab0e](../../../src/raw-pipeline/raw-core/src/demosaic/half_res.rs)); refine uses Hamilton-Adams or bilinear at full res. The two paths feed different histograms into pre-AgX tone stages → AgX anchors differently → mid-tones drift.
2. **Different prescale targets.** `fastTargetSize` is viewport pixels; `refinedTargetSize` is `nativeImageSize × min(pixelScale, 1)`. CoreImage rebuilds the filter graph for each, so local-context filters (clarity, texture, sharpen) see different boundary conditions. ([EditSession.swift:539-555](../../../src/apple/Packages/MapleCore/Sources/MapleCore/EditSession.swift))
3. **Visible-region refine composites a fresh patch over a stale upscaled preview** at [EditSession.swift:1286](../../../src/apple/Packages/MapleCore/Sources/MapleCore/EditSession.swift). When the patch is at native res and the underlay is upscaled viewport, the seam is visible at the patch edge — that's the "artifacts on slider" the user is seeing during pan/zoom.

### E. Open path violates "no unedited flash"

Story acceptance criterion: "the preview reflects the sidecar's adjustments at first paint — never an unedited starting point that briefly flips to the edited state."

Today: [EditSession.swift:1054](../../../src/apple/Packages/MapleCore/Sources/MapleCore/EditSession.swift) sets `renderedPreview = ci` (camera embedded JPEG, sRGB-encoded, camera tone curve) before any chain runs. The user sees the camera's interpretation, then ~50–200ms later the AgX-processed view replaces it. That's the flash, exactly what the spec forbids. Same path for the disk cache seed at line 1028 if the cache was populated under the old EV bias.

### F. WB delta correctness on sidecar load

[EditSession.swift:1230](../../../src/apple/Packages/MapleCore/Sources/MapleCore/EditSession.swift) reads `decodedAtModel` to compute `wb_gains(live) / wb_gains(decoded)`. `decodedAtModel` is set by `sharedDecode` and by `parseSidecarModel` (line 1782, 1627). Audit pending — if the seed paths (cache, embedded) write `decodedImage` without setting `decodedAtModel`, the first slider tick will compute a wrong WB delta against `nil` (which falls back to 6500/0). Suspected, not yet proven; see Phase 2.

---

## Plan

### Phase 1 — Calibration reset (1 day)

Decide the reference. Two ways forward, pick one:

- **(a) Re-record references against current pipeline.** Run [`src/scripts/render.sh`](../../../src/scripts/render.sh) on the fixture set, commit new ACR-pair manifests + new UITest goldens (`src/apple/MapleUITests/Goldens/`). Set per-fixture `BUDGET` knobs to the actual current numbers, then declare those the new baseline. This is the "we own AgX, AgX is the truth" stance the unwind commit committed us to.
- **(b) Bring back a smaller, *transparent* baseline EV.** If the eyeball test still says current renders are too dark on real scenes (not just vs ACR), consider a smaller `MAPLE_AGX_OFFSET_EV` (e.g. +0.3) tuned against canonical Blender 4.x AgX, **not** ACR. Document in `docs/architecture.md` § "Scene-linear chain" with the specific reference image.

I recommend (a) — the unwind commit's reasoning is sound. Path (b) reopens the trap the unwind was getting out of.

**Exit criterion:** `test_color_pipeline.sh` is 7-of-7 PASS at the chosen budgets. UITest visual harness baseline is regenerated and committed.

### Phase 2 — Slider hot-path surgery (3–5 days)

Goal: p50 ≤ 16 ms, p99 ≤ 50 ms on a 100 MP RAW at fit zoom, on supported hardware. Allocations per tick: zero on the hot path.

Three candidate fixes, apply in order, measure after each:

1. **Buffer pool the FFI input/output.** Replace the `Data(count: totalBytes)` allocations with a session-scoped reusable `MTLBuffer` (or `IOSurface`-backed buffer) sized to the largest seen viewport, and pass its pointer into Rust via `bytemuck` instead of copying. Reuses storage across ticks; eliminates 44 MB/tick allocation pressure. Verify with Instruments Allocations.
2. **Rejoin the cheap stages to the GPU side.** Move `white_balance`, `tone_controls`, `vibrance`, `saturation`, `clarity`, `texture`, `dehaze`, `nr_luminance`, `agx` back to Metal compute kernels, **using coefficient tables generated from Rust** by [`src/scripts/codegen/`](../../../src/scripts/codegen/). The Rust crate stays the source of truth for math; the GPU stays the slider hot-path. This is the option-A/B path the team rejected for parity reasons; the parity argument now goes the other way (codegen-from-Rust closes the drift). Keep the Rust FFI chain in place for headless/CLI/exports.
3. **Drop the 50 ms render-task debounce on fast phase.** With per-tick cost in budget, debouncing at scheduler level is unnecessary — let the GPU schedule itself. Keep the 250 ms refine debounce.

Aggressive variant if (1)+(2) don't get there: cap the fast-phase target at a smaller multiple of `previewSize` (e.g. always render fast at half-viewport, upscale on display). The story's "single 60 Hz frame" budget allows this — perceptual quality during drag, full quality on release.

**Exit criterion:** `SliderMatrixUITests` ratchets to mean ≤ 8, p95 ≤ 16, max ≤ 35 across all sliders. Manual: drag the exposure slider continuously on test_0017, see Instruments Time Profiler with no main-thread spikes > 16 ms.

### Phase 3 — 100%-zoom refine path (2 days)

Goal: at `pixelScale = 1.0`, slider release lands a refined viewport in budget (~150–300 ms), not 1–2 s.

1. **Crop on the input side of the FFI, not the output side.** Take the existing `visibleRect`, expand it by the maximum filter ROI (clarity / dehaze / sharpen kernel radii — say 64 px of padding), crop the cached `decodedImage` to that expanded rect *before* calling `processSceneLinear`. The FFI then runs only on the visible-plus-padding extent. The expanded ROI prevents boundary artifacts in local-context stages that read neighbor pixels. Re-crop to `visibleRect` exactly on the output side.
2. **Pass `targetSize` to the visible-region path.** `processSceneLinear(targetSize: nil)` is the wrong default for refines that already know they only need viewport pixels. Pipe the cropped extent through so `prescaleForDisplay` / the FFI sees the right size.
3. **Cap `refinedTargetSize` at `viewport × pixelScale × displayScale`.** The current cap (`nativeImageSize × min(pixelScale, 1)`) makes the refine target at 100% on a 100 MP RAW be 96 MP — but the user can only see ~2-3 MP through the viewport. The refine target should never exceed visible pixels at the current zoom. This is the structural fix; (1) and (2) are the implementation that delivers it.
4. **Re-test pan-only behavior.** Pan currently doesn't trigger a refine (by design — the user is looking at already-rendered pixels). After (1)–(3), the refine output is cropped to the visibleRect at the time of the last model change, so panning past that rect *does* need a re-refine. Either pre-render a slightly larger rect than visible (cheap, hides small pans) or trigger a refine on pan-end via a debounced gesture handler.

**Exit criterion:** at 100% zoom on `dji-mavic3pro-100mp.dng`, slider release → refined preview lands within 300 ms p95 (Instruments Time Profiler measurement). FFI work scales with viewport extent, not sensor extent (verify via stage profiler logs).

### Phase 4 — Fast/refine parity (2–3 days)

Goal: zero visible color or resolution shift between fast and refine phases.

1. **Single demosaic for fast and refine.** Drop the half-res path on the slider hot-path; render fast at full-res demosaic but at viewport size (the prescale happens after demosaic, so per-pixel work scales with viewport, not sensor). This kills the half-res chroma-noise artifact and the half-res-vs-full-res histogram drift. Half-res demosaic stays alive only for the thumbnail decode.
2. **Make `fastTargetSize == refinedTargetSize`** when zoom ≤ 1.0. At fit, the refine pass is currently no-op already (line 1182–1186); make sure the fast pass matches the refine target exactly so the local-context filters see identical boundary conditions.
3. **Remove the visible-region composite-over-stale.** With Phase 2 + Phase 3 done, the refine cost is just FFI on viewport-expanded pixels — comparable to the fast pass. The composite-over-underlay was a workaround for "render is too slow at native"; once the budget is met, the workaround creates more bugs than it solves. Replace with a full-canvas refine that simply replaces the fast preview.
4. **Open-path: never publish an unprocessed seed.** Run the cached/embedded JPEG through `processSceneLinearNonRaw` (with `skip_agx: true`) before publishing as `renderedPreview`. The first paint is then the chain's interpretation of whatever low-fidelity source we have, which still flips to the Rust-decoded full version when it lands — but the *colors* between flips are consistent because both paths share the FFI tail. Audit the `decodedAtModel` write paths so that when a sidecar exists, the embedded seed's downstream chain runs at the sidecar's WB.

**Exit criterion:** UITest harness records pre-release (mid-drag) and post-release frames at p99 ΔE ≤ 1 against each other. Manual: drag any slider, release, see no perceptible flash.

### Phase 5 — Validate against the story (1 day)

Walk every acceptance criterion in `docs/user-story-edit-flow.md`. Run:

- `cargo test -p raw-core --all-features`
- `swift test` in `Packages/MapleCore`
- `xcodebuild test -only-testing:MapleUITests` (visual + slider matrix)
- `BUDGET=10 src/scripts/test_color_pipeline.sh` (ratcheted)

Capture before/after screenshots of `dji-mavic3pro-100mp.dng` open and three-slider drag for the PR description.

---

## Why not deep-zoom first

Deep-zoom ([docs/zoom.md](../../zoom.md), [`src/apple/Packages/MapleCore/Sources/MapleCore/Sources/Tile*.swift`](../../../src/apple/Packages/MapleCore/Sources/MapleCore/)) is gated off by `EditSession.deepZoomEnabled = false`. Comment at [EditSession.swift:1160-1168](../../../src/apple/Packages/MapleCore/Sources/MapleCore/EditSession.swift) explicitly says the per-tile path has known color-discontinuity artifacts at tile boundaries because local-context stages (sharpen/clarity) see different overlap context per tile.

If we enabled deep-zoom now:
- Every tile renders through the **same FFI hot-path** that's already too slow per tick. Tiling reduces per-tile pixel count but multiplies tick count.
- The boundary artifacts compound the existing fast-vs-refine color drift — users would see seams *and* phase flips.
- Deep-zoom only matters at `pixelScale ≥ 1.0`. The user's described bugs all show up at fit-zoom (story open default), where deep-zoom doesn't activate.

Deep-zoom is the right fix for "the user has zoomed to 200% on a 100 MP RAW and pan is choppy." That is not what's broken. After the slider hot-path is fixed (Phase 2), the per-tile path inherits the same gains and the boundary-artifact ticket becomes a smaller, more focused piece of work.

---

## Open questions for Zubair

1. **Reference policy.** Phase 1 (a) vs (b). I recommend (a). Confirm before regenerating the references — it deletes the implicit "ACR brightness" target the team has been working against.
2. **Cheap-stages location (Phase 2.2).** Moving the chain back to Metal kernels is a real reversal of "Option C." It pays dividends (16 ms tick) but it's a structural change. Alternative: invest in a faster Rust path (SIMD, rayon-tuned per stage, batched f16 unpack) — likely 2× faster but probably not 8× faster, which is what we'd need.
3. **Acceptable fast-phase resolution.** If buffer pooling + GPU-resident cheap stages still don't hit 16ms on a 100 MP fit-zoom render, are we OK with fast phase rendering at half-viewport and upscaling? The story's "single 60 Hz frame" budget allows it; the spec doesn't guarantee fast-phase pixel parity with refine.
