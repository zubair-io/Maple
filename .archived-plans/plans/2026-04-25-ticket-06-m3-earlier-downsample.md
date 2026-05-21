# Ticket 06 Milestone 3 — Earlier Downsample Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Brief:** [`.archived-plans/specs/2026-04-25-ticket-06-m3-earlier-downsample-brief.md`](../specs/2026-04-25-ticket-06-m3-earlier-downsample-brief.md). The brief's § 1 picks the post-demosaic slot (between [`pipeline.rs:96`](../../../src/raw-pipeline/raw-core/src/pipeline.rs:96) and [`pipeline.rs:119`](../../../src/raw-pipeline/raw-core/src/pipeline.rs:119)) as the insertion point; § 5 keeps the FFI signature unchanged and adds one new internal helper; § 6 sets the parity gate at mean ΔE delta < 1.0 vs the committed harness baseline; § 9 commits to the smallest viable first plan (one new Rust helper, one rewire, one unit test, one harness re-run, one Apple golden re-record).
>
> **Source ticket:** [`docs/tickets/06-viewport-sized-rust-ffi-preview.md`](../../tickets/06-viewport-sized-rust-ffi-preview.md) § Recommended Milestones / Milestone 3. Plan 1 v2 Task 8 ([`.archived-plans/plans/2026-04-24-ffi-split-plan-1.md`](2026-04-24-ffi-split-plan-1.md) Task 8) added the post-pipeline `downsample_image_area` we are now moving earlier.
>
> **Out-of-scope (explicit):**
> - Tile rendering (ticket 06 M4 / Plan 3 deep-zoom). M3 only touches the `_sized` FFI path; the `_tile` FFI path stays on the full-res `develop_scene_linear_from_padded_mosaic` helper at [`pipeline.rs:485`](../../../src/raw-pipeline/raw-core/src/pipeline.rs:485) unchanged.
> - Web/WASM port. The new helper compiles for both targets via `raw-core`; the WASM shim re-exports the develop functions. No WASM-specific source change. Plan 3 picks the helper up for free if it wants the speedup.
> - Lanczos / Mitchell upgrade for `downsample_image_area`. Brief § 4 — area-average is bias-free for natural scenes at default model values; a higher-quality kernel is its own follow-up.
> - Reducing `ffi_rawler_decode` (2.34 s floor on the 100 MP fixture). Separate ticket: [`.archived-plans/plans/2026-04-24-sub-second-raw-decode.md`](2026-04-24-sub-second-raw-decode.md).
> - Refinement-on-zoom (ticket 06 § Product Requirements 4). Independent of M3 — when the user zooms past the current viewport buffer, a new sized render fires; that flow is unchanged.

**Goal:** Move the existing `downsample_image_area` call inside the sized FFI path from *after* `nr_color` to *immediately after* demosaic, so every post-demosaic stage (baseline_exposure → highlight_recovery → DCP → WB → tone → vibrance → saturation → clarity → texture → dehaze → sharpen → NR luminance → NR color) runs on the viewport-sized buffer instead of the half-res sensor buffer. On the 100 MP Mavic 3 Pro fixture this is expected to drop the Rust FFI total from ~5.25 s to ≤ 3.0 s. Acceptance: parity harness mean ΔE delta < 1.0 vs the committed baseline on every Bayer fixture, golden test_0017 visually equivalent.

**Architecture:**

1. **One new Rust helper, one rewire.** Add `develop_scene_linear_sized_from_raw_with_quality(raw, model, quality, max_long_edge)` to [`pipeline.rs`](../../../src/raw-pipeline/raw-core/src/pipeline.rs) that runs linearize + demosaic + early `downsample_image_area`, then the existing post-demosaic chain (baseline_exposure through nr_color). Rewire `render_scene_linear_sized_from_raw_with_quality` ([`pipeline.rs:368`](../../../src/raw-pipeline/raw-core/src/pipeline.rs:368)) to call the new sized develop helper instead of `develop_scene_linear_from_raw_with_quality` + post-pipeline downsample. The full-res `develop_scene_linear_from_raw_with_quality` ([`pipeline.rs:77`](../../../src/raw-pipeline/raw-core/src/pipeline.rs:77)) stays unchanged for export, the tile path's `develop_scene_linear_from_padded_mosaic` ([`pipeline.rs:485`](../../../src/raw-pipeline/raw-core/src/pipeline.rs:485)) is also unchanged. Per-stage timing names use a `sized_` prefix (e.g. `sized_baseline_exposure`, `sized_dcp_apply`) so `MAPLE_PROFILE=1` traces don't collide between paths — same convention the tile path already uses with `tile_*` (see [`pipeline.rs:495-525`](../../../src/raw-pipeline/raw-core/src/pipeline.rs:495)).

2. **No FFI signature change.** The two FFI entries `maple_render_file_scene_linear_sized` and `maple_render_bytes_scene_linear_sized` ([`raw-ffi/src/lib.rs`](../../../src/raw-pipeline/raw-ffi/src/lib.rs)) keep their existing parameters (`max_long_edge: u32`, `quality_preview: i32`) and call into the rewired `render_scene_linear_sized_from_raw_with_quality`. No xcframework header regen needed — just a static-library rebuild.

3. **No Apple change.** `PipelineRenderer.renderPreviewSized`, `ImageEditPipeline.decodePreviewSized`, and the `EditSession` routing are all upstream of the FFI signature and reuse the same struct (`MapleSceneLinearBuffer`).

4. **No Web change.** Plan 3 (Web FFI) consumes the same `raw-core` crate; if it has wired up `render_scene_linear_sized_from_raw_with_quality` it inherits the speedup; if not, M3 makes its eventual wire-up cheaper.

5. **Commutativity gate.** A new Rust unit test renders test_0017.dng via both paths (full → end-downsample, vs early-downsample). Mean per-channel fp16 delta ≤ 0.005 in linear-light. The harness ([`src/scripts/test_color_pipeline.sh`](../../../src/scripts/test_color_pipeline.sh)) gives the perceptual gate at the published BUDGET=15 — mean ΔE delta vs committed baseline must stay < 1.0.

6. **Performance gate.** Re-measure on the 100 MP Mavic 3 Pro fixture via the procedure in [`docs/measurement/2026-04-25-ffi-decode-baseline.md`](../../measurement/2026-04-25-ffi-decode-baseline.md) (Plan 1 v2 Task 7 established that procedure). Target total ≤ 3.0 s, hard limit ≤ 3.5 s.

7. **Apple golden re-record.** [`SceneLinearVisualRegressionTests.swift`](../../../src/apple/Packages/MapleCore/Tests/MapleCoreTests/SceneLinearVisualRegressionTests.swift:104)'s `test_0017-default.png` golden may shift slightly from area-average commutativity. The test re-records the baseline, the user inspects the diff visually, and accepts.

**Tech Stack:**

- Rust (`raw-core`) — additions to:
  - `src/raw-pipeline/raw-core/src/pipeline.rs` — new `develop_scene_linear_sized_from_raw_with_quality` (Task 2). Rewire of `render_scene_linear_sized_from_raw_with_quality` (Task 3). Per-stage `sized_*` timing labels (Task 2). New unit test `early_vs_late_downsample_within_fp16_tolerance` (Task 4).
- Build glue — `./src/apple/scripts/build-xcframework.sh` rerun after Rust changes so Apple's xcframework picks up the new behavior. No header-regen-affecting change.
- Bash — `src/scripts/test_color_pipeline.sh` invoked unchanged at `BUDGET=15` (Task 5).
- Test fixtures — `test-fixtures/raws/test_0017.dng` (33 MB, gitignored, present per `ls -lh`) for the unit test in Task 4 and the Apple golden re-record in Task 7. The 100 MP Mavic 3 Pro fixture (`dji-mavic3pro-100mp.dng`) is needed for Task 6's perf measurement; if absent the executor falls back to test_0017 with a documented note.

---

## File Structure

**Rust core (read-write):**

- Modify: `src/raw-pipeline/raw-core/src/pipeline.rs` —
  - Task 2 adds `develop_scene_linear_sized_from_raw_with_quality(raw, model, quality, max_long_edge) -> Result<crate::image::Image>` immediately after `develop_scene_linear_from_raw_with_quality` (after [`pipeline.rs:143`](../../../src/raw-pipeline/raw-core/src/pipeline.rs:143), before `render_from_raw_with_quality` at [`pipeline.rs:145`](../../../src/raw-pipeline/raw-core/src/pipeline.rs:145)).
  - Task 3 rewires `render_scene_linear_sized_from_raw_with_quality` ([`pipeline.rs:368-394`](../../../src/raw-pipeline/raw-core/src/pipeline.rs:368)) to call the new helper and drop the post-pipeline `downsample_image_area` call (which moved inside the helper).
  - Task 4 appends `early_vs_late_downsample_within_fp16_tolerance` to `mod tests`.
- Read-only during verification:
  - `src/raw-pipeline/raw-core/src/pipeline.rs` — confirms `develop_scene_linear_from_raw_with_quality` ([`:77`](../../../src/raw-pipeline/raw-core/src/pipeline.rs:77)), `downsample_image_area` ([`:322`](../../../src/raw-pipeline/raw-core/src/pipeline.rs:322)), and `develop_scene_linear_from_padded_mosaic` ([`:485`](../../../src/raw-pipeline/raw-core/src/pipeline.rs:485)) line numbers haven't drifted.
  - `src/raw-pipeline/raw-core/src/stages/noise_reduction.rs` — confirms `nr_color`'s blur radius is `(amount/100) * 4` ([`:64`](../../../src/raw-pipeline/raw-core/src/stages/noise_reduction.rs:64)) so we know the post-downsample radius behavior.
  - `src/raw-pipeline/raw-core/src/stages/clarity.rs` — confirms `CLARITY_RADIUS = 40` ([`:8`](../../../src/raw-pipeline/raw-core/src/stages/clarity.rs:8)).
  - `src/raw-pipeline/raw-core/src/xmp.rs` — confirms default model has `sharpen_amount = 0`, `nr_luminance = 0`, `nr_color = 25`, `clarity = 0`, etc. ([`xmp.rs:45-58`](../../../src/raw-pipeline/raw-core/src/xmp.rs:45)).

**Build artifacts (touched):**

- `src/apple/Frameworks/RawPipeline.xcframework/` — rebuilt by Task 7 (per the M3 milestone gate). The xcframework's static libraries are gitignored.
- `src/apple/MapleUITests/Goldens/test_0017-default.png` — re-recorded by Task 7 if the golden test fails. Committed once the user signs off visually.

**Bash (read-only during verification):**

- `src/scripts/test_color_pipeline.sh` — invoked at `BUDGET=15` in Task 5 (no script change).

---

## Ordering constraint

**Tasks must be done in the order: Task 1 (spike) → Task 2 → Task 3 → Task 4 → Task 5 → Task 6 → Task 7 (M3 milestone gate).**

- **Task 1 is a baseline spike — measure today's per-stage timings on test_0017 before any code change.** This is the hard gate the perf budget runs against. If the spike turns up something unexpected (e.g. `nr_color` is < 100 ms on test_0017 because it's small, so the speedup math doesn't reproduce until we test at 100 MP), the plan needs revision before code changes.
- **Task 2 adds the new sized develop helper.** No callers yet; it's pure addition. Compiles green.
- **Task 3 rewires `render_scene_linear_sized_from_raw_with_quality`.** Existing tests may fail on minor commutativity drift; Task 4 quantifies the drift; Task 5's harness gate is the perceptual budget.
- **Task 4 adds the commutativity unit test.** Quantifies the early-vs-late delta on test_0017 in linear-light fp16. Hard fail at mean delta > 0.005.
- **Task 5 runs the parity harness.** `BUDGET=15 src/scripts/test_color_pipeline.sh` against the new path. Mean ΔE delta vs committed baseline < 1.0 on each Bayer fixture.
- **Task 6 runs the performance gate** on the 100 MP fixture under `MAPLE_PROFILE=1`. Total ≤ 3.0 s; hard limit ≤ 3.5 s.
- **Task 7 is the M3 milestone gate.** Rebuilds the xcframework, runs the full Swift test suite, re-records the visual-regression golden if needed, ships.

After every task: `cd src/raw-pipeline && cargo test -p raw-core --lib`. After Task 5: `BUDGET=15 src/scripts/test_color_pipeline.sh`. After Task 7: `swift test` from `src/apple/Packages/MapleCore`.

---

## Task 1: Spike — confirm brief assumptions and capture today's per-stage timings on test_0017

**Files:**
- Read-only: `src/raw-pipeline/raw-core/src/pipeline.rs`
- Read-only: `src/raw-pipeline/raw-core/src/stages/clarity.rs`, `stages/sharpen.rs`, `stages/noise_reduction.rs`, `stages/dehaze.rs`
- Read-only: `src/raw-pipeline/raw-core/src/xmp.rs`
- Read-only: `test-fixtures/raws/test_0017.dng`
- Read-only: `docs/measurement/2026-04-25-ffi-decode-baseline.md` (if present)

**Why this matters:** The brief's § 1 numbers (linearize 104 ms, demosaic 110 ms, nr_color 1.93 s, etc.) come from the user's MAPLE_PROFILE log on the 100 MP Mavic 3 Pro fixture. Before rewiring the path we need a deterministic reproducible baseline on a fixture that *every* developer has — test_0017 (33 MB). If test_0017's stage profile doesn't show the expected dominance pattern (post-demosaic stages > pre-demosaic), the brief's "8× speedup" math has a bad assumption.

- [ ] **Step 1.1: Confirm `pipeline.rs` line numbers haven't drifted from the brief.**

Run:
```bash
grep -n "fn develop_scene_linear_from_raw_with_quality\|fn render_scene_linear_sized_from_raw_with_quality\|fn downsample_image_area\|fn develop_scene_linear_from_padded_mosaic" src/raw-pipeline/raw-core/src/pipeline.rs
```

Expected: 4 lines:
- `pub fn develop_scene_linear_from_raw_with_quality(` near line 77.
- `pub fn downsample_image_area(image: &mut crate::image::Image, max_long_edge: u32)` near line 322.
- `pub fn render_scene_linear_sized_from_raw_with_quality(` near line 368.
- `fn develop_scene_linear_from_padded_mosaic(` near line 485.

If any has shifted by more than ±10 lines, update the file-structure references in this plan before proceeding.

- [ ] **Step 1.2: Confirm `develop_scene_linear_from_raw_with_quality` ends with `nr_color` at the right slot.**

Run:
```bash
sed -n '77,143p' src/raw-pipeline/raw-core/src/pipeline.rs
```

Expected:
- Function signature: `pub fn develop_scene_linear_from_raw_with_quality(raw, model, quality) -> Result<crate::image::Image>`.
- Match arm at `:82-98` decodes mosaic vs LinearRgb.
- `stage("baseline_exposure", ...)` block at `:119-128` (gated on `raw.baseline_exposure.abs() > 1e-4`).
- `stage("highlight_recovery", ...)` at `:129`.
- Last stage `stage("nr_color", ...)` at `:141`.
- Function returns `Ok(scene)` at `:142`.

The insertion slot for the new sized helper is *between* the demosaic match arm at `:96` (where `camera_rgb` is materialized) and the `baseline_exposure` block at `:119`.

- [ ] **Step 1.3: Confirm the default `AdjustmentModel` has the values the brief assumes.**

Run:
```bash
sed -n '45,58p' src/raw-pipeline/raw-core/src/xmp.rs
```

Expected:
- `sharpen_amount: 0.0` — sharpen stage short-circuits.
- `nr_luminance: 0.0` — luminance NR stage short-circuits.
- `nr_color: 25.0` — color NR runs at ~radius 1 px (`(25/100) * 4 = 1`).
- `clarity: 0.0` — clarity short-circuits.
- `dehaze: 0.0` — dehaze stage short-circuits (returns early).

These defaults are what the parity harness fixtures and the visual-regression golden run. If any has changed (e.g. `nr_color` raised to 50), the perf math needs adjustment because two stages would now run instead of one.

- [ ] **Step 1.4: Capture today's per-stage timings on test_0017 via MAPLE_PROFILE=1.**

Run:
```bash
cd src/raw-pipeline && \
  MAPLE_PROFILE=1 cargo run --release -p raw-core --example stage-trace -- \
  ../../../test-fixtures/raws/test_0017.dng 0 0 2>&1 | tail -40
```

Expected: a table of per-stage timings. Save the output to `docs/measurement/2026-04-25-ticket-06-m3-baseline-test_0017.md` (new file, body = the captured trace + a header naming the date and the commit SHA via `git rev-parse HEAD`). The captured numbers are the *baseline*; Task 6 measures *after* the change and the file gets a "verified after M3" appendix.

If `stage-trace` doesn't accept the path, use `cargo run --release --bin maple-cli -- batch <manifest>` per the recipe in [`docs/measurement/2026-04-25-ffi-decode-baseline.md`](../../measurement/2026-04-25-ffi-decode-baseline.md).

If the test_0017 trace shows post-demosaic stages aggregating to *less* than 100 ms, the speedup math doesn't apply at this fixture size and Task 6 *must* run on the 100 MP Mavic 3 Pro fixture for the perf gate to be meaningful. Document that in the baseline file.

- [ ] **Step 1.5: Confirm the test_0017 fixture exists and exercises the Bayer path.**

Run:
```bash
ls -lh test-fixtures/raws/test_0017.dng
cd src/raw-pipeline && cargo run --release -p raw-core --example raw-stats -- ../../../test-fixtures/raws/test_0017.dng 2>&1 | head -10
```

Expected: file present (~33 MB), `raw-stats` output showing CFA pattern (RGGB / BGGR / GRBG / GBRG — *not* `LinearRgb`). LinearRgb fixtures take a different path that doesn't go through `demosaic`; the speedup math doesn't apply there. test_0017 is a Bayer fixture per the harness's pass list.

- [ ] **Step 1.6: `cargo test -p raw-core --lib` to capture the test count baseline.**

Run:
```bash
cd src/raw-pipeline && cargo test -p raw-core --lib 2>&1 | tail -5
```

Expected: green. Note the test count for comparison after Task 4 (which adds 1 test).

- [ ] **Step 1.7: Spike commit (notes only — no code).**

This task touches no source files. Skip the commit step; the baseline measurement file from Step 1.4 commits with Task 6's perf-gate result. Move on to Task 2.

---

## Task 2: Add `develop_scene_linear_sized_from_raw_with_quality` helper

**Files:**
- Modify: `src/raw-pipeline/raw-core/src/pipeline.rs`

**Why this matters:** This is the structural change. Task 3 rewires the FFI to call this; Tasks 4-7 verify the rewire is correct. The helper mirrors `develop_scene_linear_from_raw_with_quality` body-for-body but inserts a `sized_downsample_area_f32` stage between demosaic and `baseline_exposure`. Per-stage labels use a `sized_` prefix to distinguish from the full-res chain in `MAPLE_PROFILE=1` traces — same convention the tile path uses (`tile_*` per [`pipeline.rs:495`](../../../src/raw-pipeline/raw-core/src/pipeline.rs:495)).

- [ ] **Step 2.1: Add the helper.**

In `src/raw-pipeline/raw-core/src/pipeline.rs`, immediately after `develop_scene_linear_from_raw_with_quality` ends (after the `Ok(scene)` line at [`:142`](../../../src/raw-pipeline/raw-core/src/pipeline.rs:142)) and before `pub fn render_from_raw_with_quality` at [`:145`](../../../src/raw-pipeline/raw-core/src/pipeline.rs:145), append:

```rust
/// Sized variant of `develop_scene_linear_from_raw_with_quality` that
/// runs `linearize` + `demosaic` (or `linearraw_to_camera_rgb` for
/// LinearRaw fixtures), then immediately downsamples the camera-RGB
/// buffer to fit within `max_long_edge`, then runs the rest of the
/// development chain on the smaller buffer. Saves ~8× on every
/// post-demosaic stage when the source is 100 MP and the viewport is
/// ~3 MP. See ticket 06 § Recommended Milestones / Milestone 3 and
/// .archived-plans/specs/2026-04-25-ticket-06-m3-earlier-downsample-brief.md.
///
/// Per-stage profile labels are prefixed `sized_` so MAPLE_PROFILE=1
/// traces don't collide with the full-res `develop_…` labels — same
/// convention the tile path uses (`tile_*`).
///
/// Never upscales: `downsample_image_area` early-returns when the
/// source long edge is already <= `max_long_edge`. In that case this
/// helper is functionally identical to
/// `develop_scene_linear_from_raw_with_quality`, only with `sized_*`
/// stage labels.
pub fn develop_scene_linear_sized_from_raw_with_quality(
    raw: &RawImage,
    model: &AdjustmentModel,
    quality: RenderQuality,
    max_long_edge: u32,
) -> Result<crate::image::Image> {
    let mut camera_rgb = match raw.cfa {
        crate::image::CfaPattern::LinearRgb => {
            stage("sized_linearraw_decode", || linearize::linearraw_to_camera_rgb(raw))?
        }
        _ => {
            let mosaic = stage("sized_linearize", || linearize::sensor_linearize(raw));
            stage("sized_demosaic", || match quality {
                RenderQuality::Preview => demosaic::half_res(&mosaic, raw.cfa),
                #[cfg(feature = "high-quality-demosaic")]
                RenderQuality::Full => demosaic::hamilton_adams(&mosaic, raw.cfa),
                #[cfg(not(feature = "high-quality-demosaic"))]
                RenderQuality::Full => demosaic::bilinear(&mosaic, raw.cfa),
            })
        }
    };

    // Early downsample — the heart of this milestone. After this call
    // every later stage runs on the viewport-sized buffer instead of
    // the half-res sensor buffer. `downsample_image_area` is a no-op
    // when the source long edge is already <= `max_long_edge`.
    stage("sized_downsample_area_f32", || {
        downsample_image_area(&mut camera_rgb, max_long_edge)
    });

    if raw.baseline_exposure.abs() > 1e-4 {
        stage("sized_baseline_exposure", || {
            let be_gain = raw.baseline_exposure.exp2();
            for p in &mut camera_rgb.pixels {
                p[0] *= be_gain;
                p[1] *= be_gain;
                p[2] *= be_gain;
            }
        });
    }
    stage("sized_highlight_recovery", || highlight_recovery::apply(&mut camera_rgb, model.highlight_recovery));
    let profile = stage("sized_dcp_profile_for", || dcp::profile_for(raw))?;
    let mut scene = stage("sized_dcp_apply", || dcp::apply(&camera_rgb, &profile))?;
    stage("sized_white_balance", || white_balance::apply(&mut scene, model.temperature, model.tint));
    stage("sized_scene_tone_controls", || scene_tone_controls::apply(&mut scene, model));
    stage("sized_vibrance", || vibrance::apply(&mut scene, model.vibrance));
    stage("sized_saturation", || saturation::apply(&mut scene, model.saturation));
    stage("sized_clarity", || clarity::apply(&mut scene, model.clarity));
    stage("sized_texture", || texture::apply(&mut scene, model.texture));
    stage("sized_dehaze", || dehaze::apply(&mut scene, model.dehaze));
    stage("sized_sharpen", || sharpen::apply(&mut scene, model.sharpen_amount, model.sharpen_radius, model.sharpen_detail, model.sharpen_masking));
    stage("sized_nr_luminance", || noise_reduction::apply_luminance(&mut scene, model.nr_luminance));
    stage("sized_nr_color", || noise_reduction::apply_color(&mut scene, model.nr_color));
    Ok(scene)
}
```

- [ ] **Step 2.2: `cargo build -p raw-core` to confirm the new helper compiles cleanly.**

Run:
```bash
cd src/raw-pipeline && cargo build -p raw-core 2>&1 | tail -5
```

Expected: green. Warnings about an unused public function are acceptable here — Task 3 wires it up.

- [ ] **Step 2.3: `cargo test -p raw-core --lib` confirms no existing test regressed.**

Run:
```bash
cd src/raw-pipeline && cargo test -p raw-core --lib 2>&1 | tail -5
```

Expected: same test count as Step 1.6, all passing. The new helper has no callers yet so no behavior change.

- [ ] **Step 2.4: Commit.**

```bash
git add src/raw-pipeline/raw-core/src/pipeline.rs
git commit -m "$(cat <<'EOF'
feat(raw-core): add develop_scene_linear_sized helper for early downsample

Adds `develop_scene_linear_sized_from_raw_with_quality` next to the
existing `develop_scene_linear_from_raw_with_quality`. Same body but
inserts `downsample_image_area` immediately after demosaic so every
later stage runs on the viewport-sized buffer.

No callers yet — Task 3 rewires the sized FFI entry to use the new
helper. Per-stage labels use a `sized_` prefix to keep
MAPLE_PROFILE=1 traces uncrowded.

Plan: .archived-plans/plans/2026-04-25-ticket-06-m3-earlier-downsample.md
Brief: .archived-plans/specs/2026-04-25-ticket-06-m3-earlier-downsample-brief.md

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Rewire `render_scene_linear_sized_from_raw_with_quality` to call the new helper

**Files:**
- Modify: `src/raw-pipeline/raw-core/src/pipeline.rs`

**Why this matters:** This is the behavioral change. The FFI surface is unchanged but the rendered pixels may shift slightly because of the (early-downsample ∘ filter) vs (filter ∘ end-downsample) commutativity error. Task 4 measures the shift; Task 5 perceives it.

- [ ] **Step 3.1: Replace the body of `render_scene_linear_sized_from_raw_with_quality`.**

In `src/raw-pipeline/raw-core/src/pipeline.rs`, locate `pub fn render_scene_linear_sized_from_raw_with_quality(` at [`:368`](../../../src/raw-pipeline/raw-core/src/pipeline.rs:368). Today the body reads:

```rust
pub fn render_scene_linear_sized_from_raw_with_quality(
    raw: &RawImage,
    model: &AdjustmentModel,
    quality: RenderQuality,
    max_long_edge: u32,
) -> Result<(u32, u32, Vec<u16>)> {
    let mut scene = develop_scene_linear_from_raw_with_quality(raw, model, quality)?;
    stage("downsample_area_f32", || downsample_image_area(&mut scene, max_long_edge));
    let (w0, h0) = (scene.width, scene.height);
    let rgba_f32 = stage("pack_rgba_f32_sized", || {
        let mut v = Vec::with_capacity(scene.pixels.len() * 4);
        for p in &scene.pixels {
            v.push(p[0]);
            v.push(p[1]);
            v.push(p[2]);
            v.push(1.0);
        }
        v
    });
    let (w, h, oriented_f32) = stage("apply_orientation_rgba_sized", || {
        apply_orientation_f32_rgba(&rgba_f32, w0, h0, raw.orientation)
    });
    let fp16: Vec<u16> = stage("pack_fp16_sized", || {
        oriented_f32.iter().map(|&v| f32_to_f16_bits(v)).collect()
    });
    Ok((w, h, fp16))
}
```

Replace with:

```rust
pub fn render_scene_linear_sized_from_raw_with_quality(
    raw: &RawImage,
    model: &AdjustmentModel,
    quality: RenderQuality,
    max_long_edge: u32,
) -> Result<(u32, u32, Vec<u16>)> {
    // M3: develop with the early-downsample helper. The downsample
    // happens immediately after demosaic so post-demosaic stages run
    // on the viewport-sized buffer. The post-pipeline
    // `downsample_image_area` call this function used to make is now
    // inside the helper.
    let scene = develop_scene_linear_sized_from_raw_with_quality(
        raw, model, quality, max_long_edge,
    )?;
    let (w0, h0) = (scene.width, scene.height);
    let rgba_f32 = stage("pack_rgba_f32_sized", || {
        let mut v = Vec::with_capacity(scene.pixels.len() * 4);
        for p in &scene.pixels {
            v.push(p[0]);
            v.push(p[1]);
            v.push(p[2]);
            v.push(1.0);
        }
        v
    });
    let (w, h, oriented_f32) = stage("apply_orientation_rgba_sized", || {
        apply_orientation_f32_rgba(&rgba_f32, w0, h0, raw.orientation)
    });
    let fp16: Vec<u16> = stage("pack_fp16_sized", || {
        oriented_f32.iter().map(|&v| f32_to_f16_bits(v)).collect()
    });
    Ok((w, h, fp16))
}
```

The only difference: the `develop_scene_linear_from_raw_with_quality` + `stage("downsample_area_f32", ...)` two-line invocation becomes a single `develop_scene_linear_sized_from_raw_with_quality` call. The post-helper packing / orientation / fp16 logic is unchanged.

- [ ] **Step 3.2: `cargo test -p raw-core --lib` confirms existing pipeline tests still pass.**

Run:
```bash
cd src/raw-pipeline && cargo test -p raw-core --lib 2>&1 | tail -5
```

Expected: green. The existing test `render_scene_linear_sized_test_0002_caps_long_edge_at_1500` ([`pipeline.rs:`mod tests]) checks size cap and alpha, both of which still hold post-rewire.

If any existing test fails because of small numerical drift, *do not* relax the test's tolerance silently. Open the test, characterize the drift (mean / max channel delta on the affected fixture), document it in the commit message in Step 3.4. Tightening tolerances only with explicit commit per CLAUDE.md § "Objective color testing".

- [ ] **Step 3.3: `cargo test -p raw-ffi --lib` confirms the FFI tests still pass.**

Run:
```bash
cd src/raw-pipeline && cargo test -p raw-ffi --lib 2>&1 | tail -10
```

Expected: green. The FFI tests `render_scene_linear_sized_via_ffi_caps_long_edge` and `sized_zero_long_edge_sets_error` exercise size-cap and error-handling, both unchanged.

- [ ] **Step 3.4: Commit.**

```bash
git add src/raw-pipeline/raw-core/src/pipeline.rs
git commit -m "$(cat <<'EOF'
perf(raw-core): early downsample on sized FFI render path

Rewires render_scene_linear_sized_from_raw_with_quality to call the
new develop_scene_linear_sized helper. The downsample now happens
immediately after demosaic instead of after nr_color, so every
post-demosaic stage runs on the viewport-sized buffer.

Expected speedup ~8× on every post-demosaic stage at 100 MP →
~1500 px viewport. Plan 1 v2's MAPLE_PROFILE=1 trace put nr_color at
1.93 s on the 100 MP fixture; this drops it to ~250 ms.

No FFI signature change. The full-res
develop_scene_linear_from_raw_with_quality stays for export and the
tile path's develop_scene_linear_from_padded_mosaic.

Plan: .archived-plans/plans/2026-04-25-ticket-06-m3-earlier-downsample.md

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Commutativity unit test — early-downsample vs late-downsample on test_0017

**Files:**
- Modify: `src/raw-pipeline/raw-core/src/pipeline.rs` (append to `mod tests`)

**Why this matters:** This is the deterministic numerical gate. We render test_0017 via the *full-res-then-end-downsample* path (today's full-res helper + post-pipeline `downsample_image_area`) and the new *early-downsample* path (Task 2's helper), then compare per-channel f32 delta. The mean delta must stay ≤ 0.005 in linear-light. This test is fixture-gated and will SKIP if test_0017.dng is absent.

- [ ] **Step 4.1: Append the test to `mod tests` in `pipeline.rs`.**

Locate `mod tests {` in `src/raw-pipeline/raw-core/src/pipeline.rs` (around [`:625`](../../../src/raw-pipeline/raw-core/src/pipeline.rs:625)). Append after the existing `render_scene_linear_sized_test_0002_caps_long_edge_at_1500` test:

```rust
    /// M3 commutativity gate: render test_0017.dng via the original
    /// late-downsample path (full-res develop, then
    /// `downsample_image_area`) and the new early-downsample path
    /// (`develop_scene_linear_sized_from_raw_with_quality` runs
    /// downsample right after demosaic), then compare per-channel
    /// f32 mean delta in scene-linear Rec.2020.
    ///
    /// Budget: mean per-channel delta ≤ 0.005 in linear-light. The
    /// expected dominant source of difference is the
    /// non-commutativity of (downsample ∘ filter) vs
    /// (filter ∘ downsample); for natural scenes at the default
    /// AdjustmentModel (sharpen_amount=0, nr_luminance=0,
    /// nr_color=25 with radius 1 px, clarity=0, dehaze=0) this is
    /// dominated by the nr_color blur and bounded by the
    /// downsample kernel's low-pass character.
    ///
    /// Skips if test_0017.dng is absent (gitignored fixtures).
    #[test]
    fn early_vs_late_downsample_within_fp16_tolerance() {
        let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../test-fixtures/raws/test_0017.dng");
        if !path.exists() { return; }
        let bytes = std::fs::read(&path).expect("read raw");
        let raw = crate::decode::decode_bytes(&bytes, "dng").expect("decode");
        let model = AdjustmentModel::default();
        let max_long_edge: u32 = 1500;

        // Late-downsample: full-res develop, then downsample.
        let mut late = develop_scene_linear_from_raw_with_quality(
            &raw, &model, RenderQuality::Preview,
        ).expect("late develop");
        downsample_image_area(&mut late, max_long_edge);

        // Early-downsample: new helper runs downsample post-demosaic.
        let early = develop_scene_linear_sized_from_raw_with_quality(
            &raw, &model, RenderQuality::Preview, max_long_edge,
        ).expect("early develop");

        // Sizes must match — both end at <= max_long_edge on the long edge.
        assert_eq!(early.width, late.width, "width mismatch");
        assert_eq!(early.height, late.height, "height mismatch");
        assert_eq!(early.pixels.len(), late.pixels.len(), "pixel count mismatch");

        let n = early.pixels.len();
        let mut sum_dr = 0.0f64;
        let mut sum_dg = 0.0f64;
        let mut sum_db = 0.0f64;
        let mut max_dr = 0.0f32;
        let mut max_dg = 0.0f32;
        let mut max_db = 0.0f32;
        for (a, b) in early.pixels.iter().zip(late.pixels.iter()) {
            let dr = (a[0] - b[0]).abs();
            let dg = (a[1] - b[1]).abs();
            let db = (a[2] - b[2]).abs();
            sum_dr += dr as f64;
            sum_dg += dg as f64;
            sum_db += db as f64;
            if dr > max_dr { max_dr = dr; }
            if dg > max_dg { max_dg = dg; }
            if db > max_db { max_db = db; }
        }
        let mean_dr = (sum_dr / n as f64) as f32;
        let mean_dg = (sum_dg / n as f64) as f32;
        let mean_db = (sum_db / n as f64) as f32;
        eprintln!(
            "early-vs-late: mean ΔR={:.5} ΔG={:.5} ΔB={:.5}  max ΔR={:.5} ΔG={:.5} ΔB={:.5}",
            mean_dr, mean_dg, mean_db, max_dr, max_dg, max_db,
        );

        // Mean per-channel delta budget. 0.005 in [0, ~5] scene-linear
        // headroom is ~0.1% of typical scene values.
        assert!(mean_dr < 0.005, "mean R delta {} > 0.005", mean_dr);
        assert!(mean_dg < 0.005, "mean G delta {} > 0.005", mean_dg);
        assert!(mean_db < 0.005, "mean B delta {} > 0.005", mean_db);
    }
```

- [ ] **Step 4.2: Run the test.**

Run:
```bash
cd src/raw-pipeline && cargo test -p raw-core --lib pipeline::tests::early_vs_late_downsample_within_fp16_tolerance -- --nocapture 2>&1 | tail -15
```

Expected: PASS, with an `eprintln!` line showing the captured mean / max per-channel deltas. Record those numbers in the commit message in Step 4.4.

If the test fails (mean delta > 0.005), DO NOT relax the budget. Investigate which stage is the dominant contributor by repeating with each stage individually disabled (set `nr_color = 0` and re-run; if the delta drops, nr_color is the source). Open a finding-of-fact comment in the test's docstring before tightening or relaxing — same rigor as the harness's color budget per CLAUDE.md.

- [ ] **Step 4.3: Run the full test suite.**

Run:
```bash
cd src/raw-pipeline && cargo test -p raw-core --lib 2>&1 | tail -5
```

Expected: green. Test count is Step 1.6's baseline + 1.

- [ ] **Step 4.4: Commit.**

```bash
git add src/raw-pipeline/raw-core/src/pipeline.rs
git commit -m "$(cat <<'EOF'
test(raw-core): commutativity gate for early-vs-late downsample

Renders test_0017.dng via the legacy late-downsample path and the
new early-downsample path, asserts mean per-channel f32 delta ≤
0.005 in linear-light Rec.2020.

Captured mean deltas (test_0017, Preview, default model):
  ΔR=<RECORD> ΔG=<RECORD> ΔB=<RECORD>

The dominant source of difference is the non-commutativity of
(downsample ∘ filter) vs (filter ∘ downsample); on natural scenes
at the default model this is bounded by the area-average kernel's
low-pass character.

Plan: .archived-plans/plans/2026-04-25-ticket-06-m3-earlier-downsample.md

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

Replace `<RECORD>` with the actual captured numbers from Step 4.2 before committing.

---

## Task 5: Parity gate — full color harness vs committed baseline

**Files:**
- Read-only: `src/scripts/test_color_pipeline.sh`
- Read-only (verification only): `src/raw-pipeline/maple-cli` build outputs

**Why this matters:** The unit test in Task 4 measures linear-light delta. The harness measures *perceptual* CIEDE2000 ΔE, which is what the user actually sees after AgX + sRGB encoding. The harness is the gate the product ships against.

- [ ] **Step 5.1: Capture today's harness baseline before re-running.**

Run:
```bash
cd /Users/riabuz/Projects/_Maple/.claude/worktrees/keen-gould-063563
git log -1 --format=%H  # baseline commit
BUDGET=15 src/scripts/test_color_pipeline.sh 2>&1 | tee /tmp/m3-pre-harness.txt | tail -30
```

Expected: PASS on every Bayer fixture at BUDGET=15 (and BUDGET=25 for LinearRaw fixtures, gated by the harness itself per the LinearRaw ticket #07 fix that's already landed). Record the per-fixture mean / p95 / max ΔE numbers in `/tmp/m3-pre-harness.txt` for the comparison in Step 5.3.

- [ ] **Step 5.2: Re-run the harness on the post-Task-3 code.**

Already on the new code from Task 3. Run:
```bash
cd /Users/riabuz/Projects/_Maple/.claude/worktrees/keen-gould-063563
BUDGET=15 src/scripts/test_color_pipeline.sh 2>&1 | tee /tmp/m3-post-harness.txt | tail -30
```

Expected: PASS on every Bayer fixture at BUDGET=15.

- [ ] **Step 5.3: Compare per-fixture mean ΔE between pre and post.**

Run:
```bash
diff /tmp/m3-pre-harness.txt /tmp/m3-post-harness.txt | head -80
```

**Hard gate:** mean ΔE delta per fixture must be < 1.0 between pre and post. If any Bayer fixture's mean ΔE moved by ≥ 1.0, the early-downsample changed the visible look more than acceptable. Investigate before proceeding to Task 6.

If the maple-cli binary calls `render_scene_linear_sized_from_raw_with_quality`, it picks up the M3 change. If it calls a *different* render entry (e.g. `render_from_raw` for the legacy display-encoded path), the harness output may be unaffected — in that case the harness's gate doesn't directly bind on M3 and only Task 4's unit test + Task 6's perf gate + Task 7's Apple golden cover the change. Verify which path the harness uses by inspecting `cargo run --release --bin maple-cli -- batch ...` source — out of this plan's scope to refactor, but in scope to *verify* and to document if the harness binding is indirect.

- [ ] **Step 5.4: Commit (harness pre/post traces).**

```bash
mkdir -p docs/measurement
cp /tmp/m3-pre-harness.txt docs/measurement/2026-04-25-ticket-06-m3-harness-pre.txt
cp /tmp/m3-post-harness.txt docs/measurement/2026-04-25-ticket-06-m3-harness-post.txt
git add docs/measurement/2026-04-25-ticket-06-m3-harness-{pre,post}.txt
git commit -m "$(cat <<'EOF'
docs(measurement): M3 parity harness pre/post traces

Captures the BUDGET=15 color harness output before and after the
M3 early-downsample rewire. Mean ΔE delta < 1.0 on every Bayer
fixture per the parity gate.

Plan: .archived-plans/plans/2026-04-25-ticket-06-m3-earlier-downsample.md

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Performance gate on the 100 MP Mavic 3 Pro fixture

**Files:**
- Read-only: `test-fixtures/raws/dji-mavic3pro-100mp.dng` (if present)
- Modify: `docs/measurement/2026-04-25-ticket-06-m3-baseline-test_0017.md` (Task 1's baseline file gets a "verified after M3" appendix)

**Why this matters:** The brief's expected speedup (5.25 s → 3.0 s) is based on the user's MAPLE_PROFILE=1 trace on the 100 MP fixture. The unit test and harness gates are correctness; this is the perf gate the milestone ships against.

- [ ] **Step 6.1: Confirm the 100 MP Mavic 3 Pro fixture is present.**

Run:
```bash
ls -lh test-fixtures/raws/dji-mavic3pro-100mp.dng 2>&1 || echo "FIXTURE MISSING"
```

If absent (CLAUDE.md notes this fixture is gitignored), the executor must source the file before proceeding. The plan does not block on it, but the perf gate cannot be verified without it. If absent, document in Step 6.4 and skip to Task 7 — the milestone gate becomes "test_0017 unit test passes + harness passes + Apple golden re-records" with the perf claim left to a follow-up measurement on a developer machine that has the fixture.

- [ ] **Step 6.2: Run MAPLE_PROFILE=1 on the 100 MP fixture via the procedure in `docs/measurement/2026-04-25-ffi-decode-baseline.md`.**

If `docs/measurement/2026-04-25-ffi-decode-baseline.md` exists, follow its procedure exactly. Otherwise, the canonical recipe is:

```bash
cd src/raw-pipeline && \
  MAPLE_PROFILE=1 cargo run --release --bin maple-cli -- \
  batch --manifest /tmp/m3-perf-manifest.json --out-dir /tmp/m3-perf-out 2>&1 | \
  tee /tmp/m3-perf-trace.txt | tail -60
```

Where `/tmp/m3-perf-manifest.json` is:

```json
{
  "cases": [
    {
      "name": "100mp_sized_preview",
      "raw_path": "../../../test-fixtures/raws/dji-mavic3pro-100mp.dng",
      "render_path": "sized",
      "max_long_edge": 1500,
      "quality": "preview"
    }
  ]
}
```

(If maple-cli does not yet support the `sized` render_path or `max_long_edge` field, this Step 6.2 is *gated* on a maple-cli wrapper that calls `render_scene_linear_sized_from_raw_with_quality`. Plan 1 v2 Task 8 added the FFI entry but maple-cli's own code may need a small adapter; if so, that adapter is a sub-task of Task 6. Document as a sub-step.)

If maple-cli doesn't have a sized adapter yet, the executor measures via the running Apple app under MAPLE_PROFILE=1, opening the 100 MP fixture through the editor and reading `os_log` output — same procedure as Plan 1 v2 Task 7 step 7.5. The numbers come out the same.

- [ ] **Step 6.3: Verify the perf gate.**

Sum the per-stage timings from the trace:

```bash
grep -E "^[[:space:]]*(sized_|ffi_)" /tmp/m3-perf-trace.txt | awk '{sum+=$NF} END{print "TOTAL:", sum}'
```

**Gate:** total ≤ 3.0 s (target), 3.5 s (hard limit). The expected stage breakdown:

| Stage | Pre-M3 (ms) | Post-M3 expected (ms) | Speedup |
|---|---:|---:|---:|
| ffi_rawler_decode | 2340 | 2340 | 1.0× (untouched) |
| sized_linearize | 104 | 104 | 1.0× (pre-downsample) |
| sized_demosaic | 110 | 110 | 1.0× (pre-downsample) |
| sized_downsample_area_f32 | n/a (was post-pipeline) | ~30 | new slot |
| sized_baseline_exposure | 78 | ~10 | 8× |
| sized_dcp_apply | 21 | ~3 | 8× |
| sized_nr_color | 1930 | ~250 | 8× |
| pack_fp16_sized | 134 | ~17 | 8× |

Concretely: if the post-M3 trace shows `sized_nr_color > 600 ms` on the 100 MP fixture, the early downsample didn't take effect — investigate (most likely the downsample's `if long_edge <= max_long_edge { return; }` early-return is firing because half-res 100 MP demosaic produced a buffer ≤ 1500 px on the long edge; bug in the test setup, not in the helper).

- [ ] **Step 6.4: Append the post-M3 trace to the baseline file from Task 1 Step 1.4.**

Open `docs/measurement/2026-04-25-ticket-06-m3-baseline-test_0017.md` (created in Task 1.4), append a new section "Post-M3 verification" with the captured trace from Step 6.2. Commit:

```bash
git add docs/measurement/2026-04-25-ticket-06-m3-baseline-test_0017.md
git commit -m "$(cat <<'EOF'
docs(measurement): M3 perf verification — total Rust FFI <RECORD> s on 100 MP fixture

Pre-M3 baseline: <RECORD> s. Post-M3: <RECORD> s. Speedup: <RECORD>×.
The dominant gain is sized_nr_color falling from <RECORD> ms to
<RECORD> ms. ffi_rawler_decode (~2.3 s) is untouched and remains
the binding floor.

Plan: .archived-plans/plans/2026-04-25-ticket-06-m3-earlier-downsample.md

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

Replace `<RECORD>` with the captured numbers before committing.

---

## Task 7: M3 milestone gate — rebuild xcframework, re-record Apple golden, finalize

**Files:**
- Modify: `src/apple/Frameworks/RawPipeline.xcframework/` (rebuilt by `build-xcframework.sh`)
- Modify (potentially): `src/apple/MapleUITests/Goldens/test_0017-default.png` (re-recorded if the visual-regression test fails)

**Why this matters:** The xcframework picks up the new `develop_scene_linear_sized_from_raw_with_quality` helper. The Apple `decodePreviewSized` path goes through the rewired sized FFI entry; if the visual-regression golden ([`SceneLinearVisualRegressionTests.swift:104`](../../../src/apple/Packages/MapleCore/Tests/MapleCoreTests/SceneLinearVisualRegressionTests.swift:104)) drifts beyond budget (mean ΔE ≤ 5, p95 ≤ 10, max ≤ 30, bias ≤ 0.05), the test fails and the executor re-records — but only after a visual eyeball pass to confirm the new render is *correct*, not regressed.

- [ ] **Step 7.1: Rebuild the xcframework so Apple picks up the rewired Rust path.**

Run:
```bash
./src/apple/scripts/build-xcframework.sh 2>&1 | tail -10
```

Expected: `==> Done.` plus a regenerated `RawPipeline.h` (no signature changes, but the script always regenerates).

Confirm `RawPipeline.h` is unchanged (no signature drift):
```bash
git diff src/apple/Packages/MapleCore/Sources/MapleCore/include/RawPipeline.h | head -20
```

Expected: no diff (the FFI signatures are preserved by Tasks 2-3).

- [ ] **Step 7.2: Run the full Swift test suite.**

Run:
```bash
cd src/apple/Packages/MapleCore && swift test 2>&1 | grep -E "passed|failed|error" | tail -10
```

Expected: all passing *except possibly* `SceneLinearVisualRegressionTests.testRenderTest_0017_defaultMatchesGolden` (if the early-downsample shifted the rendered pixels enough to fail the budget). If only that test fails, proceed to Step 7.3 — re-record. If others fail, investigate root cause before re-recording anything.

- [ ] **Step 7.3: Visually inspect the candidate render before re-recording.**

The golden test writes a candidate PNG when it fails. Open it alongside the existing golden:

```bash
ls -lh src/apple/MapleUITests/Goldens/
# Find: test_0017-default.png (committed) and test_0017-default-candidate.png (new run)
open src/apple/MapleUITests/Goldens/test_0017-default.png \
     src/apple/MapleUITests/Goldens/test_0017-default-candidate.png
```

Eyeball check: the candidate must look *correct*, not just different. If it looks wrong (color cast, lost detail, blown highlights), the early-downsample is producing a regression and the executor must investigate before re-recording. If it looks correct (no perceptible difference, or only the expected slight variation in noise texture from the downsample-frequency shift), proceed.

- [ ] **Step 7.4: Re-record the golden if the candidate looks correct.**

Run:
```bash
rm src/apple/MapleUITests/Goldens/test_0017-default.png
cd src/apple/Packages/MapleCore && swift test --filter SceneLinearVisualRegressionTests 2>&1 | tail -5
```

Expected first run after delete: "baseline written" (the test writes the new baseline + fails). Re-run to confirm:
```bash
cd src/apple/Packages/MapleCore && swift test --filter SceneLinearVisualRegressionTests 2>&1 | tail -5
```

Expected: PASS.

- [ ] **Step 7.5: Commit the re-recorded golden.**

```bash
git add src/apple/MapleUITests/Goldens/test_0017-default.png
git commit -m "$(cat <<'EOF'
test(apple): re-record SceneLinear golden for M3 early-downsample

The early-downsample shifts the rendered pixels by less than the
visual-regression budget on test_0017 (mean ΔE ≤ 5, p95 ≤ 10, max ≤
30). Visually inspected the candidate render alongside the previous
golden; the difference is bounded by the downsample-frequency-shift
and is not a regression.

Plan: .archived-plans/plans/2026-04-25-ticket-06-m3-earlier-downsample.md

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 7.6: Final smoke test — open the 100 MP fixture in the running app.**

Run:
```bash
cd src/apple && xcodebuild -project Maple.xcodeproj -scheme Maple -destination 'platform=macOS' build 2>&1 | tail -3
```

Expected: `BUILD SUCCEEDED`.

Open the resulting `Maple.app`, load the 100 MP Mavic 3 Pro DNG, drag through several zoom levels. Confirm: the cold-open feels noticeably faster (target ≤ 3.0 s Rust FFI total), the image looks correct, no zoom-dependent color shift.

- [ ] **Step 7.7: M3 milestone PASS record.**

Append to the bottom of `.archived-plans/plans/2026-04-25-ticket-06-m3-earlier-downsample.md` (this file):

```
## M3 result: PASSED on YYYY-MM-DD

- Unit test: early-vs-late mean ΔR=<RECORD> ΔG=<RECORD> ΔB=<RECORD>
  (budget 0.005 each) — PASS.
- Color harness BUDGET=15: mean ΔE delta < 1.0 on every Bayer
  fixture vs commit <SHA> — PASS.
- Performance gate: <RECORD> s total Rust FFI on 100 MP fixture
  (budget 3.0 s target / 3.5 s hard limit) — PASS.
- Apple golden: test_0017-default.png re-recorded; visual
  inspection confirmed no regression — PASS.
- xcframework rebuilt; full Swift test suite green.
```

Replace placeholders. Commit:

```bash
git add .archived-plans/plans/2026-04-25-ticket-06-m3-earlier-downsample.md
git commit -m "$(cat <<'EOF'
docs(plans): mark Ticket 06 M3 PASSED

Plan: .archived-plans/plans/2026-04-25-ticket-06-m3-earlier-downsample.md

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review Checklist

Run through this once after the plan is in place, before handoff to execution.

**1. Spec coverage:**
- [ ] Task 1 (spike) confirms brief assumptions and captures today's per-stage timings on test_0017 — the deterministic baseline.
- [ ] Task 2 adds `develop_scene_linear_sized_from_raw_with_quality` to `pipeline.rs` between [`:143`](../../../src/raw-pipeline/raw-core/src/pipeline.rs:143) and [`:145`](../../../src/raw-pipeline/raw-core/src/pipeline.rs:145), with `sized_*` per-stage labels mirroring the tile path's `tile_*` convention.
- [ ] Task 3 rewires `render_scene_linear_sized_from_raw_with_quality` to call the new helper; the FFI signature is unchanged.
- [ ] Task 4 adds the commutativity unit test on test_0017 with mean per-channel f32 delta ≤ 0.005 budget.
- [ ] Task 5 runs `BUDGET=15 src/scripts/test_color_pipeline.sh` pre and post; mean ΔE delta < 1.0 on every Bayer fixture is the hard gate.
- [ ] Task 6 measures the 100 MP perf gate: ≤ 3.0 s target, ≤ 3.5 s hard limit.
- [ ] Task 7 rebuilds the xcframework, runs the full Swift suite, re-records `test_0017-default.png` if needed (with eyeball check before re-recording), final smoke test on the running app.
- [ ] Out-of-scope items (tile rendering, Web/WASM port, Lanczos upgrade, rawler decode reduction, refinement-on-zoom) are explicitly listed.

**2. Placeholder scan:**
- [ ] Task 1 Step 1.4, Task 4 Step 4.4, Task 6 Step 6.4, and Task 7 Step 7.7 use `<RECORD>` for measurements captured at execution time. The hard-fail thresholds (Task 4: 0.005, Task 5: 1.0 ΔE delta, Task 6: 3.5 s) are concrete.
- [ ] No "TBD" / "TODO" / "implement later".
- [ ] No "similar to Task N" without code — Task 2's helper is spelled out in full.
- [ ] Task 6 Step 6.2's maple-cli adapter is flagged as a sub-step *if* the binary doesn't yet support the sized render path, with a documented fallback (measure via the running app).

**3. Type consistency:**
- [ ] `develop_scene_linear_sized_from_raw_with_quality` (Task 2) is the new helper; it returns `Result<crate::image::Image>` matching the existing full-res helper's signature.
- [ ] `render_scene_linear_sized_from_raw_with_quality` (Task 3 rewire) keeps its existing signature `(raw, model, quality, max_long_edge) -> Result<(u32, u32, Vec<u16>)>`.
- [ ] Per-stage labels use the `sized_` prefix (Task 2) — matches the tile path's `tile_` convention so MAPLE_PROFILE=1 traces are unambiguous.
- [ ] No new types introduced; no FFI struct change.

**4. Ordering and BLOCKING constraints:**
- [ ] Task 1 (spike) is informational and blocks Tasks 2-7 only on confirmation that brief assumptions hold.
- [ ] Task 2 → Task 3: Task 3 calls Task 2's helper; the order is sequential.
- [ ] Task 4 follows Task 3 because the unit test compares old-path vs new-path; both must coexist (Task 2 didn't remove the old path; Task 3 didn't either — the full-res `develop_scene_linear_from_raw_with_quality` is unchanged for export).
- [ ] Task 5 (harness) follows Task 4 (unit test) — passes the perceptual gate.
- [ ] Task 6 (perf) follows Task 5 — perf is the milestone deliverable but only meaningful if correctness passes.
- [ ] Task 7 (milestone gate + xcframework + Apple golden) is last — depends on every prior task.

If any of the above is unchecked when reviewing, fix inline; do not re-review.

---

## Cross-references

- **Ticket source:** [`docs/tickets/06-viewport-sized-rust-ffi-preview.md`](../../tickets/06-viewport-sized-rust-ffi-preview.md) § Recommended Milestones / Milestone 3.
- **Brief:** [`.archived-plans/specs/2026-04-25-ticket-06-m3-earlier-downsample-brief.md`](../specs/2026-04-25-ticket-06-m3-earlier-downsample-brief.md).
- **Plan 1 v2 Task 8** (introduced the post-pipeline downsample we are moving): [`.archived-plans/plans/2026-04-24-ffi-split-plan-1.md`](2026-04-24-ffi-split-plan-1.md) Task 8.
- **Plan 3 deep-zoom tile rendering** (uses the unaffected `_tile` FFI variant): [`.archived-plans/plans/2026-04-25-deep-zoom-tile-rendering.md`](2026-04-25-deep-zoom-tile-rendering.md).
- **Sub-second decode** (the `ffi_rawler_decode` floor M3 does not touch): [`.archived-plans/plans/2026-04-24-sub-second-raw-decode.md`](2026-04-24-sub-second-raw-decode.md).
- **CLAUDE.md** § "Performance invariants" (16 ms slider, 250-1000 ms cold open uncached) and § "Objective color testing" (no eyeballing — every change passes the harness).
- **Measurement procedure:** [`docs/measurement/2026-04-25-ffi-decode-baseline.md`](../../measurement/2026-04-25-ffi-decode-baseline.md) (Plan 1 v2 Task 7 procedure, reused for Task 1 and Task 6 here).

---

## M3 result: PASSED on 2026-04-25

- **Unit test:** `early_vs_late_downsample_within_fp16_tolerance`
  on test_0017.dng (24 MP Leica M10): mean dR=0.00257 dG=0.00123
  dB=0.00329 (budget 0.005 each) — PASS. Max single-pixel deltas
  dR=0.17407 dG=0.09572 dB=0.19395.
- **Color harness BUDGET=15:** mean ΔE delta = 0.000 on every
  fixture vs commit `abfe1a3` — PASS. Pre and post are
  bit-identical because `maple-cli` calls `render_from_raw` (the
  legacy display-encoded path), not the M3-rewired sized FFI. The
  harness gate doesn't directly bind on M3 (open question from
  the plan, now confirmed). Task 4's unit test + Task 7's Apple
  golden re-record are the binding correctness gates.
- **Performance gate:** measured on **test_0000.DNG** (12288×8192
  Hasselblad L3D-100c, ~100 MP — the actual reference RAW in this
  worktree; the named `dji-mavic3pro-100mp.dng` is gitignored and
  absent locally). Total Rust FFI 459 ms (read 14 ms + decode
  336 ms + render 109 ms) — well under the 3.0 s target / 3.5 s
  hard limit — PASS. Render-only speedup: 448 ms → 109 ms = 4.1×.
  Per-stage wins: `sized_nr_color` 340 ms → 20 ms (17×),
  `sized_baseline_exposure` 8.78 ms → 0.44 ms (20×),
  `sized_dcp_apply` 12.77 ms → 1.93 ms (6.6×). The user's reported
  baseline is ~6× slower than this developer machine on absolute
  numbers; the relative speedup ratios are the binding finding.
- **Apple golden:** test_0017-default.png re-recorded post-M3 at
  2992×1996 (10.5 MB PNG). Bit-identical regenerated — the test's
  `decodeSceneLinear` path doesn't go through the M3-rewired sized
  FFI; it uses the unchanged full-res `decodeSceneLinear`. **Per
  user instruction, the new golden stays untracked for the user
  to eyeball.**
- xcframework rebuilt; `RawPipeline.h` byte-identical (no FFI
  signature change). 230 raw-core tests pass + 1 pre-existing
  unrelated failure (`xmp::tests::parse_baseline_is_defaults`,
  expects different defaults than the codebase ships — not
  introduced by M3). Swift test suite: 151 pass / 3 skip / 2 fail
  (`AgXKernelDiagnosticTests`, pre-existing, in untracked file
  `AgXKernelDiagnosticTests.swift`, unrelated to M3).

Commits: `88e13f4` (Task 2 helper), `cd606c5` (Task 3 rewire),
`ef27bbd` (Task 4 unit test), `bbf8ff5` (Task 5 harness traces),
`9d3c2e8` (Task 6 perf doc).
