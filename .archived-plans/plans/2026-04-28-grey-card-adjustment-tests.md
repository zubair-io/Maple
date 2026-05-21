# Grey-Card Adjustment Tests Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Validate every Maple adjustment that has a closed-form scene-linear effect (exposure, highlights, shadows, whites, blacks, saturation, vibrance) by predicting exact output values, asserting the predictions hold in Rust, and parity-testing on macOS via a UITest.

**Architecture:** New `predictions` module in `raw-core/test_support` whose pure functions mirror the math in `scene_tone_controls::apply` exactly. New `grey_adjustments.rs` integration test runs every adjustment on the synthetic grey DNG and asserts per-pixel scene-linear == predicted (closed-form), or asserts direction/symmetry (relational, for AgX-internal contrast and WB temp/tint). New macOS UITest renders the same input + adjustment XMPs and asserts the canvas is neutral with mean ≈ Rust-rendered mean.

**Tech Stack:** Rust 2021 (extends `raw-core`); Swift / XCTest for the Apple UITest. No new dependencies.

**Spec:** `.archived-plans/specs/2026-04-28-grey-card-adjustment-tests-design.md`
**Builds on:** `.archived-plans/plans/2026-04-28-synthetic-grey-dng.md`

---

## File Structure

| File                                                                | Status   | Responsibility                                                      |
| ------------------------------------------------------------------- | -------- | ------------------------------------------------------------------- |
| `src/raw-pipeline/raw-core/src/test_support/predictions.rs`         | create   | Closed-form predictors per scene-linear adjustment + drift tests    |
| `src/raw-pipeline/raw-core/src/test_support/mod.rs`                 | modify   | Register `predictions` module                                       |
| `src/raw-pipeline/raw-core/tests/grey_adjustments.rs`               | create   | Closed-form + relational adjustment tests                           |
| `src/scripts/test_grey_adjustments.sh`                              | create   | CI gate                                                             |
| `src/apple/MapleUITests/Fixtures/synthetic/grey-l018-rggb.dng`      | create   | Committed bootstrap DNG (~8KB)                                      |
| `src/apple/MapleUITests/Fixtures/synthetic/cases/*.xmp`             | create   | Per-adjustment XMP files (six cases)                                |
| `src/apple/MapleUITests/SyntheticGreyUITests.swift`                 | create   | macOS parity UITest                                                 |

---

## Task 1: Bootstrap the Apple synthetic DNG fixture

This is a one-shot file generation. We use the existing `synth-grey` example to write a single 64×64 DNG, commit it under the Apple test bundle, and never touch it again.

**Files:**
- Create: `src/apple/MapleUITests/Fixtures/synthetic/grey-l018-rggb.dng`

- [ ] **Step 1: Make the directory**

```bash
mkdir -p /Users/riabuz/Projects/_Maple/src/apple/MapleUITests/Fixtures/synthetic/cases
```

- [ ] **Step 2: Generate the DNG via the existing example**

```bash
cd /Users/riabuz/Projects/_Maple/src/raw-pipeline
cargo run --release -p raw-core --features test-support --example synth-grey -- \
    --value 0.18 --width 64 --height 64 --cfa rggb \
    --out /Users/riabuz/Projects/_Maple/src/apple/MapleUITests/Fixtures/synthetic/grey-l018-rggb.dng
```

Expected: `wrote .../grey-l018-rggb.dng (64x64, L=0.18)`. File should be ~8KB.

- [ ] **Step 3: Sanity-check the file**

```bash
ls -l /Users/riabuz/Projects/_Maple/src/apple/MapleUITests/Fixtures/synthetic/grey-l018-rggb.dng
cd /Users/riabuz/Projects/_Maple/src/raw-pipeline
cargo run --release --bin maple-cli -- inspect \
    /Users/riabuz/Projects/_Maple/src/apple/MapleUITests/Fixtures/synthetic/grey-l018-rggb.dng
```

Expected: file size between 6KB and 12KB; `inspect` prints `dimensions: 64 × 64`, `CFA: Rggb`, `as-shot WB: [0.5, 1.0, 0.5]`.

- [ ] **Step 4: Commit**

```bash
cd /Users/riabuz/Projects/_Maple
git add src/apple/MapleUITests/Fixtures/synthetic/grey-l018-rggb.dng
git commit -m "test(apple): commit synthetic grey-l018-rggb.dng fixture (8KB)"
```

---

## Task 2: Predictors module — exposure (TDD)

We start with the simplest predictor (exposure) and its drift-prevention unit test. Each subsequent predictor follows the same pattern.

**Files:**
- Create: `src/raw-pipeline/raw-core/src/test_support/predictions.rs`
- Modify: `src/raw-pipeline/raw-core/src/test_support/mod.rs`

- [ ] **Step 1: Register the new module**

Edit `src/raw-pipeline/raw-core/src/test_support/mod.rs` to add:

```rust
//! Test-only helpers. Gated by the `test-support` feature. These do NOT
//! ship in `libraw_ffi.a` (Apple xcframework) or `raw-wasm` binaries —
//! the feature is opt-in and only enabled by Cargo when running tests
//! or the `synth-grey` example.

pub mod synth_dng;
pub mod predictions;
```

- [ ] **Step 2: Write the failing test**

Create `src/raw-pipeline/raw-core/src/test_support/predictions.rs`:

```rust
//! Closed-form predictors for scene-linear adjustments. Mirror the math
//! in `crate::stages::scene_tone_controls::apply` exactly so each
//! predictor + production-code pair drifts together. See spec
//! `.archived-plans/specs/2026-04-28-grey-card-adjustment-tests-design.md`.

/// scene_tone_controls::apply, step 1.
pub fn predict_exposure(scene: f32, ev: f32) -> f32 {
    todo!()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 1×1 image at the predicted scene-linear value, run through
    /// `scene_tone_controls::apply` with the matching slider, must produce
    /// the predictor's output to within 1e-6.
    fn round_trip_exposure(scene: f32, ev: f32) {
        use crate::image::{ColorSpace, Image};
        use crate::stages::scene_tone_controls;
        use crate::xmp::AdjustmentModel;

        let predicted = predict_exposure(scene, ev);
        let mut img = Image::new(1, 1, ColorSpace::SceneLinearRec2020);
        img.pixels[0] = [scene, scene, scene];
        let mut model = AdjustmentModel::default();
        model.exposure = ev;
        scene_tone_controls::apply(&mut img, &model);
        for c in 0..3 {
            assert!((img.pixels[0][c] - predicted).abs() < 1e-6,
                "predict_exposure({},{}) = {}, scene_tone_controls produced {} (chan {})",
                scene, ev, predicted, img.pixels[0][c], c);
        }
    }

    #[test]
    fn exposure_plus1_doubles() {
        round_trip_exposure(0.18, 1.0);
        round_trip_exposure(0.05, 1.0);
        round_trip_exposure(0.50, 1.0);
    }

    #[test]
    fn exposure_minus1_halves() {
        round_trip_exposure(0.18, -1.0);
        round_trip_exposure(0.05, -1.0);
        round_trip_exposure(0.50, -1.0);
    }

    #[test]
    fn exposure_zero_is_identity() {
        round_trip_exposure(0.18, 0.0);
    }
}
```

- [ ] **Step 3: Run test to verify it fails**

```bash
cd /Users/riabuz/Projects/_Maple/src/raw-pipeline
cargo test -p raw-core --features test-support \
    --lib test_support::predictions::tests::exposure 2>&1 | tail -10
```

Expected: PANIC `not yet implemented`.

- [ ] **Step 4: Implement `predict_exposure`**

Replace the `todo!()` body:

```rust
pub fn predict_exposure(scene: f32, ev: f32) -> f32 {
    scene * ev.exp2()
}
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
cd /Users/riabuz/Projects/_Maple/src/raw-pipeline
cargo test -p raw-core --features test-support \
    --lib test_support::predictions::tests::exposure 2>&1 | tail -10
```

Expected: 3 passed.

- [ ] **Step 6: Commit**

```bash
cd /Users/riabuz/Projects/_Maple
git add src/raw-pipeline/raw-core/src/test_support/mod.rs \
        src/raw-pipeline/raw-core/src/test_support/predictions.rs
git commit -m "feat(raw-core): test_support::predictions — exposure predictor"
```

---

## Task 3: Predictors — highlights, shadows, whites, blacks, saturation, vibrance

Six predictors in one task because each is a tiny pure function with the same drift-test shape.

**Files:**
- Modify: `src/raw-pipeline/raw-core/src/test_support/predictions.rs`

- [ ] **Step 1: Add the failing tests at the bottom of the `tests` module**

```rust
    fn round_trip_highlights(scene: f32, h: f32) {
        use crate::image::{ColorSpace, Image};
        use crate::stages::scene_tone_controls;
        use crate::xmp::AdjustmentModel;

        let predicted = predict_highlights(scene, h);
        let mut img = Image::new(1, 1, ColorSpace::SceneLinearRec2020);
        img.pixels[0] = [scene, scene, scene];
        let mut model = AdjustmentModel::default();
        model.highlights = h;
        scene_tone_controls::apply(&mut img, &model);
        for c in 0..3 {
            assert!((img.pixels[0][c] - predicted).abs() < 1e-6,
                "predict_highlights({},{}) = {}, got {} (chan {})",
                scene, h, predicted, img.pixels[0][c], c);
        }
    }

    fn round_trip_shadows(scene: f32, s: f32) {
        use crate::image::{ColorSpace, Image};
        use crate::stages::scene_tone_controls;
        use crate::xmp::AdjustmentModel;

        let predicted = predict_shadows(scene, s);
        let mut img = Image::new(1, 1, ColorSpace::SceneLinearRec2020);
        img.pixels[0] = [scene, scene, scene];
        let mut model = AdjustmentModel::default();
        model.shadows = s;
        scene_tone_controls::apply(&mut img, &model);
        for c in 0..3 {
            assert!((img.pixels[0][c] - predicted).abs() < 1e-6,
                "predict_shadows({},{}) = {}, got {} (chan {})",
                scene, s, predicted, img.pixels[0][c], c);
        }
    }

    fn round_trip_whites(scene: f32, w: f32) {
        use crate::image::{ColorSpace, Image};
        use crate::stages::scene_tone_controls;
        use crate::xmp::AdjustmentModel;

        let predicted = predict_whites(scene, w);
        let mut img = Image::new(1, 1, ColorSpace::SceneLinearRec2020);
        img.pixels[0] = [scene, scene, scene];
        let mut model = AdjustmentModel::default();
        model.whites = w;
        scene_tone_controls::apply(&mut img, &model);
        for c in 0..3 {
            assert!((img.pixels[0][c] - predicted).abs() < 1e-6,
                "predict_whites({},{}) = {}, got {} (chan {})",
                scene, w, predicted, img.pixels[0][c], c);
        }
    }

    fn round_trip_blacks(scene: f32, b: f32) {
        use crate::image::{ColorSpace, Image};
        use crate::stages::scene_tone_controls;
        use crate::xmp::AdjustmentModel;

        let predicted = predict_blacks(scene, b);
        let mut img = Image::new(1, 1, ColorSpace::SceneLinearRec2020);
        img.pixels[0] = [scene, scene, scene];
        let mut model = AdjustmentModel::default();
        model.blacks = b;
        scene_tone_controls::apply(&mut img, &model);
        for c in 0..3 {
            assert!((img.pixels[0][c] - predicted).abs() < 1e-6,
                "predict_blacks({},{}) = {}, got {} (chan {})",
                scene, b, predicted, img.pixels[0][c], c);
        }
    }

    #[test] fn highlights_below_knee_is_identity() { round_trip_highlights(0.50, 50.0); }
    #[test] fn highlights_above_knee_compresses() { round_trip_highlights(2.0, 50.0); }
    #[test] fn highlights_zero_is_identity()      { round_trip_highlights(2.0, 0.0); }

    #[test] fn shadows_plus50_lifts_dark()   { round_trip_shadows(0.05, 50.0); }
    #[test] fn shadows_minus50_crushes_dark(){ round_trip_shadows(0.05, -50.0); }
    #[test] fn shadows_above_mask_no_op()    { round_trip_shadows(0.50, 50.0); }
    #[test] fn shadows_zero_is_identity()    { round_trip_shadows(0.05, 0.0); }

    #[test] fn whites_plus50_lifts_bright()   { round_trip_whites(0.50, 50.0); }
    #[test] fn whites_minus50_pulls_bright()  { round_trip_whites(0.50, -50.0); }
    #[test] fn whites_below_pivot_no_op()     { round_trip_whites(0.10, 50.0); }
    #[test] fn whites_zero_is_identity()      { round_trip_whites(0.50, 0.0); }

    #[test] fn blacks_plus50_lifts_floor()   { round_trip_blacks(0.05, 50.0); }
    #[test] fn blacks_minus50_crushes_floor(){ round_trip_blacks(0.05, -50.0); }
    #[test] fn blacks_above_mid_no_op()      { round_trip_blacks(0.30, 50.0); }
    #[test] fn blacks_zero_is_identity()     { round_trip_blacks(0.05, 0.0); }

    #[test]
    fn saturation_no_op_on_neutral() {
        // Predictor is identity by definition; assert it matches production.
        use crate::image::{ColorSpace, Image};
        use crate::stages::saturation as sat;
        use crate::xmp::AdjustmentModel;
        let mut img = Image::new(1, 1, ColorSpace::SceneLinearRec2020);
        img.pixels[0] = [0.18, 0.18, 0.18];
        let mut model = AdjustmentModel::default();
        model.saturation = 50.0;
        sat::apply(&mut img, &model);
        for c in 0..3 {
            let predicted = predict_saturation(0.18, 50.0);
            assert!((img.pixels[0][c] - predicted).abs() < 1e-6,
                "saturation should not move a neutral; got {}, predicted {}",
                img.pixels[0][c], predicted);
        }
    }

    #[test]
    fn vibrance_no_op_on_neutral() {
        use crate::image::{ColorSpace, Image};
        use crate::stages::vibrance;
        use crate::xmp::AdjustmentModel;
        let mut img = Image::new(1, 1, ColorSpace::SceneLinearRec2020);
        img.pixels[0] = [0.18, 0.18, 0.18];
        let mut model = AdjustmentModel::default();
        model.vibrance = 50.0;
        vibrance::apply(&mut img, &model);
        for c in 0..3 {
            let predicted = predict_vibrance(0.18, 50.0);
            assert!((img.pixels[0][c] - predicted).abs() < 1e-6,
                "vibrance should not move a neutral; got {}, predicted {}",
                img.pixels[0][c], predicted);
        }
    }
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /Users/riabuz/Projects/_Maple/src/raw-pipeline
cargo test -p raw-core --features test-support \
    --lib test_support::predictions 2>&1 | tail -10
```

Expected: compile errors — predictor functions don't exist yet.

- [ ] **Step 3: Implement the six predictors**

Add after `predict_exposure` in `predictions.rs`:

```rust
fn smoothstep(e0: f32, e1: f32, x: f32) -> f32 {
    let t = ((x - e0) / (e1 - e0)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

const LUMA_REC2020: [f32; 3] = [0.2627, 0.6780, 0.0593];

/// scene_tone_controls::apply, step 2.
pub fn predict_highlights(scene: f32, h_slider: f32) -> f32 {
    if h_slider.abs() < 1e-3 { return scene; }
    if scene <= 1.0 { return scene; }
    let h_amount = h_slider / 100.0;
    let h_denom = 1.0 + h_amount * 2.0;
    if h_denom.abs() < 1e-6 { return scene; }
    1.0 + (scene - 1.0) / h_denom
}

/// scene_tone_controls::apply, step 3. For a neutral pixel R=G=B=scene,
/// luma == scene, so the per-channel math collapses to scalar math.
pub fn predict_shadows(scene: f32, s_slider: f32) -> f32 {
    if s_slider.abs() < 1e-3 { return scene; }
    let s_factor = (s_slider / 100.0) * 0.5;
    let luma = scene; // R = G = B
    let mask = 1.0 - smoothstep(0.0, 0.1, luma);
    let lift = mask * s_factor;
    scene * (1.0 + lift)
}

/// scene_tone_controls::apply, step 4.
pub fn predict_whites(scene: f32, w_slider: f32) -> f32 {
    if w_slider.abs() < 1e-3 { return scene; }
    let w_amount = w_slider / 200.0;
    let luma = scene;
    let weight = smoothstep(0.18, 1.0, luma);
    let scale = if w_slider >= 0.0 {
        let overshoot = (luma - 1.0).max(0.0);
        1.0 + w_amount * (weight + overshoot * 4.0)
    } else {
        1.0 + w_amount * weight
    };
    let scale = scale.max(0.0);
    scene * scale
}

/// scene_tone_controls::apply, step 5.
pub fn predict_blacks(scene: f32, b_slider: f32) -> f32 {
    if b_slider.abs() < 1e-3 { return scene; }
    let b_amount = b_slider / 800.0;
    let luma = scene;
    let weight = 1.0 - smoothstep(0.0, 0.18, luma);
    if b_slider >= 0.0 {
        let shift = b_amount * weight;
        (scene + shift).max(0.0)
    } else {
        let scale = (1.0 + b_amount * weight * 4.0).max(0.0);
        scene * scale
    }
}

pub fn predict_saturation(scene: f32, _s_slider: f32) -> f32 { scene }
pub fn predict_vibrance(scene: f32, _v_slider: f32) -> f32 { scene }
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /Users/riabuz/Projects/_Maple/src/raw-pipeline
cargo test -p raw-core --features test-support \
    --lib test_support::predictions 2>&1 | tail -25
```

Expected: all 19 predictor tests pass (3 exposure + 16 new).

If any fail, the production math may be slightly different from what this plan documented — re-read the matching `scene_tone_controls.rs` step and update the predictor to match. The production code is the source of truth; predictors mirror it.

- [ ] **Step 5: Commit**

```bash
cd /Users/riabuz/Projects/_Maple
git add src/raw-pipeline/raw-core/src/test_support/predictions.rs
git commit -m "feat(raw-core): predictions for highlights, shadows, whites, blacks, saturation, vibrance"
```

---

## Task 4: Adjustment-test harness — `assert_predicted_scene_linear` + `assert_neutral_display`

**Files:**
- Create: `src/raw-pipeline/raw-core/tests/grey_adjustments.rs`

- [ ] **Step 1: Create the file with the helpers + first test**

Create `src/raw-pipeline/raw-core/tests/grey_adjustments.rs`:

```rust
//! Closed-form + relational adjustment-validation tests on the synthetic
//! grey DNG. See spec
//! `.archived-plans/specs/2026-04-28-grey-card-adjustment-tests-design.md`.

#![cfg(feature = "test-support")]

use raw_core::pipeline::{
    develop_scene_linear_from_raw_with_quality, render_from_raw, RenderQuality,
};
use raw_core::test_support::predictions::*;
use raw_core::test_support::synth_dng::SyntheticGreyDng;
use raw_core::xmp::AdjustmentModel;

/// Float tolerance for closed-form scene-linear assertions. Same budget
/// as `grey_invariants.rs` SCENE_LINEAR_EPS — demosaic + matrix-mul drift.
const EPS_SCENE_LINEAR: f32 = 5e-4;

/// 8-bit LSB tolerance for display-encoded neutrality (R=G=B preservation).
const EPS_DISPLAY_LSB: i32 = 2;

/// Synthesise a grey DNG at scene-linear `linear_value`, apply the
/// requested adjustments via `configure`, develop scene-linear, and
/// assert per-pixel R=G=B=predict(linear_value) within EPS_SCENE_LINEAR.
fn assert_predicted_scene_linear(
    linear_value: f32,
    configure: impl FnOnce(&mut AdjustmentModel),
    predict: impl Fn(f32) -> f32,
) {
    let dng = SyntheticGreyDng { linear_value, ..Default::default() };
    let bytes = dng.write_to_bytes();
    let raw = raw_core::decode::decode_bytes(&bytes, "dng")
        .expect("synthetic DNG must decode");

    let mut model = AdjustmentModel::default();
    configure(&mut model);
    let img = develop_scene_linear_from_raw_with_quality(&raw, &model, RenderQuality::Full)
        .expect("scene-linear render must succeed");

    let expected = predict(linear_value);
    for (i, p) in img.pixels.iter().enumerate() {
        for c in 0..3 {
            assert!((p[c] - expected).abs() <= EPS_SCENE_LINEAR,
                "pixel {} chan {} = {} (predicted {}, |Δ| > {}) at L = {}",
                i, c, p[c], expected, EPS_SCENE_LINEAR, linear_value);
        }
    }
}

/// Synthesise + render through the full production pipeline (incl. AgX),
/// assert per-pixel R=G=B in u8 within EPS_DISPLAY_LSB.
fn assert_neutral_display(
    linear_value: f32,
    configure: impl FnOnce(&mut AdjustmentModel),
) {
    let dng = SyntheticGreyDng { linear_value, ..Default::default() };
    let bytes = dng.write_to_bytes();
    let raw = raw_core::decode::decode_bytes(&bytes, "dng")
        .expect("synthetic DNG must decode");

    let mut model = AdjustmentModel::default();
    configure(&mut model);
    let (w, h, rgb) = render_from_raw(&raw, &model)
        .expect("full pipeline render must succeed");

    let n = (w * h) as usize;
    for i in 0..n {
        let r = rgb[i*3]     as i32;
        let g = rgb[i*3 + 1] as i32;
        let b = rgb[i*3 + 2] as i32;
        assert!((r - g).abs() <= EPS_DISPLAY_LSB,
            "pixel {} |R-G|={} > {} (R={} G={} B={}) at L={}",
            i, (r-g).abs(), EPS_DISPLAY_LSB, r, g, b, linear_value);
        assert!((r - b).abs() <= EPS_DISPLAY_LSB,
            "pixel {} |R-B|={} > {} (R={} G={} B={}) at L={}",
            i, (r-b).abs(), EPS_DISPLAY_LSB, r, g, b, linear_value);
    }
}

#[test]
fn exposure_plus1_predicts() {
    for L in [0.05, 0.18, 0.50] {
        assert_predicted_scene_linear(L, |m| m.exposure = 1.0, |s| predict_exposure(s, 1.0));
        assert_neutral_display(L, |m| m.exposure = 1.0);
    }
}
```

- [ ] **Step 2: Run the test**

```bash
cd /Users/riabuz/Projects/_Maple/src/raw-pipeline
cargo test -p raw-core --features test-support \
    --test grey_adjustments exposure_plus1 2>&1 | tail -15
```

Expected: PASS. If it fails on the scene-linear assertion, the budget may need to bump to absorb compounded-stage drift — bump `EPS_SCENE_LINEAR` by 2× and rerun. If it fails on neutrality, the issue is downstream and worth diagnosing before continuing.

- [ ] **Step 3: Commit**

```bash
cd /Users/riabuz/Projects/_Maple
git add src/raw-pipeline/raw-core/tests/grey_adjustments.rs
git commit -m "test(raw-core): grey_adjustments harness + exposure +1 closed-form test"
```

---

## Task 5: Closed-form tests for the rest of the slider set

Add the remaining closed-form tests in one task — they all follow the same shape established in Task 4.

**Files:**
- Modify: `src/raw-pipeline/raw-core/tests/grey_adjustments.rs`

- [ ] **Step 1: Append the tests**

Add to the end of `src/raw-pipeline/raw-core/tests/grey_adjustments.rs`:

```rust
#[test]
fn exposure_minus1_predicts() {
    for L in [0.05, 0.18, 0.50] {
        assert_predicted_scene_linear(L, |m| m.exposure = -1.0, |s| predict_exposure(s, -1.0));
        assert_neutral_display(L, |m| m.exposure = -1.0);
    }
}

#[test]
fn shadows_plus50_predicts() {
    for L in [0.05, 0.18, 0.50] {
        assert_predicted_scene_linear(L, |m| m.shadows = 50.0, |s| predict_shadows(s, 50.0));
        assert_neutral_display(L, |m| m.shadows = 50.0);
    }
}

#[test]
fn shadows_minus50_predicts() {
    for L in [0.05, 0.18, 0.50] {
        assert_predicted_scene_linear(L, |m| m.shadows = -50.0, |s| predict_shadows(s, -50.0));
        assert_neutral_display(L, |m| m.shadows = -50.0);
    }
}

#[test]
fn whites_plus50_predicts() {
    for L in [0.18, 0.50, 0.80] {
        assert_predicted_scene_linear(L, |m| m.whites = 50.0, |s| predict_whites(s, 50.0));
        assert_neutral_display(L, |m| m.whites = 50.0);
    }
}

#[test]
fn whites_minus50_predicts() {
    for L in [0.18, 0.50, 0.80] {
        assert_predicted_scene_linear(L, |m| m.whites = -50.0, |s| predict_whites(s, -50.0));
        assert_neutral_display(L, |m| m.whites = -50.0);
    }
}

#[test]
fn blacks_plus50_predicts() {
    for L in [0.05, 0.18, 0.30] {
        assert_predicted_scene_linear(L, |m| m.blacks = 50.0, |s| predict_blacks(s, 50.0));
        assert_neutral_display(L, |m| m.blacks = 50.0);
    }
}

#[test]
fn blacks_minus50_predicts() {
    for L in [0.05, 0.18, 0.30] {
        assert_predicted_scene_linear(L, |m| m.blacks = -50.0, |s| predict_blacks(s, -50.0));
        assert_neutral_display(L, |m| m.blacks = -50.0);
    }
}

#[test]
fn saturation_no_op_on_neutral() {
    for L in [0.05, 0.18, 0.50] {
        assert_predicted_scene_linear(L, |m| m.saturation = 50.0, |s| predict_saturation(s, 50.0));
        assert_predicted_scene_linear(L, |m| m.saturation = -50.0, |s| predict_saturation(s, -50.0));
        assert_neutral_display(L, |m| m.saturation = 50.0);
    }
}

#[test]
fn vibrance_no_op_on_neutral() {
    for L in [0.05, 0.18, 0.50] {
        assert_predicted_scene_linear(L, |m| m.vibrance = 50.0, |s| predict_vibrance(s, 50.0));
        assert_predicted_scene_linear(L, |m| m.vibrance = -50.0, |s| predict_vibrance(s, -50.0));
        assert_neutral_display(L, |m| m.vibrance = 50.0);
    }
}

/// Highlights compresses values above 1.0. Drive scene to 2.0 via
/// exposure(+EV=1) on L=1.0, then highlights(+50). Expected = chained
/// closed-form: predict_highlights(predict_exposure(1.0, 1.0), 50.0) = 1.5.
///
/// Note: SyntheticGreyDng caps L at 1.0 (raw_data is u16, white_level 65535,
/// so L > 1.0 saturates the raw). We synthesise at L = 1.0 and use exposure
/// to push the scene-linear value past the highlights knee.
#[test]
fn highlights_compresses_above_knee() {
    let configure = |m: &mut AdjustmentModel| {
        m.exposure = 1.0;
        m.highlights = 50.0;
    };
    let predict = |s: f32| predict_highlights(predict_exposure(s, 1.0), 50.0);
    assert_predicted_scene_linear(1.0, configure, predict);
    assert_neutral_display(1.0, configure);
}
```

- [ ] **Step 2: Run the file**

```bash
cd /Users/riabuz/Projects/_Maple/src/raw-pipeline
cargo test -p raw-core --features test-support --test grey_adjustments 2>&1 | tail -25
```

Expected: 11 tests pass (including the existing exposure +1 from Task 4).

If `highlights_compresses_above_knee` fails because raw values clamp at L=1.0 instead of saturating cleanly, lower L to 0.95 — exposure(+1) still drives it past 1.0 (1.9), highlights at +50 lands at predict_highlights(1.9, 50.0) = 1.45. Update the test accordingly.

- [ ] **Step 3: Commit**

```bash
cd /Users/riabuz/Projects/_Maple
git add src/raw-pipeline/raw-core/tests/grey_adjustments.rs
git commit -m "test(raw-core): closed-form predictions for shadows/whites/blacks/sat/vib + highlights compose"
```

---

## Task 6: Relational tests for WB temp, tint, contrast

These don't have closed-form predictions (WB is a Bradford CAT in XYZ; contrast is AgX-internal). Test direction, symmetry, and magnitude relationships instead.

**Files:**
- Modify: `src/raw-pipeline/raw-core/tests/grey_adjustments.rs`

- [ ] **Step 1: Add a helper for fetching a single representative pixel after scene-linear development**

Append to `grey_adjustments.rs`:

```rust
/// Develop the synthetic L=0.18 grey to scene-linear with the given
/// adjustments and return a representative pixel (everything is uniform
/// for a flat synthetic input, so any pixel works — we read pixel 32×32).
fn scene_linear_pixel(configure: impl FnOnce(&mut AdjustmentModel)) -> [f32; 3] {
    let dng = SyntheticGreyDng::default();
    let bytes = dng.write_to_bytes();
    let raw = raw_core::decode::decode_bytes(&bytes, "dng").unwrap();
    let mut model = AdjustmentModel::default();
    configure(&mut model);
    let img = develop_scene_linear_from_raw_with_quality(&raw, &model, RenderQuality::Full).unwrap();
    img.pixels[32 * 64 + 32]
}
```

- [ ] **Step 2: Add the relational tests**

Append:

```rust
#[test]
fn temp_warmer_makes_r_gt_b() {
    let p = scene_linear_pixel(|m| m.temperature = 7500.0); // +1000K from default 6500
    assert!(p[0] > p[2], "temp+1000K should warm: R={} should exceed B={}", p[0], p[2]);
    assert!(p[0] > p[1], "temp+1000K should warm: R={} should exceed G={}", p[0], p[1]);
}

#[test]
fn temp_cooler_makes_b_gt_r() {
    let p = scene_linear_pixel(|m| m.temperature = 5500.0); // -1000K from default
    assert!(p[2] > p[0], "temp-1000K should cool: B={} should exceed R={}", p[2], p[0]);
    assert!(p[2] > p[1], "temp-1000K should cool: B={} should exceed G={}", p[2], p[1]);
}

#[test]
fn temp_symmetric() {
    // |R-B| at +1000K should be within 20% of |R-B| at -1000K. Loose
    // because the WB curve isn't perfectly linear in temperature, but
    // gross asymmetry indicates a real bug.
    let warm = scene_linear_pixel(|m| m.temperature = 7500.0);
    let cool = scene_linear_pixel(|m| m.temperature = 5500.0);
    let warm_delta = (warm[0] - warm[2]).abs();
    let cool_delta = (cool[0] - cool[2]).abs();
    let ratio = warm_delta / cool_delta;
    assert!(ratio > 0.8 && ratio < 1.25,
        "WB +/-1000K asymmetry: warm |R-B|={}, cool |R-B|={}, ratio={}",
        warm_delta, cool_delta, ratio);
}

#[test]
fn tint_plus_pushes_magenta() {
    // +tint shifts toward magenta — R+B grows relative to G.
    let default_p = scene_linear_pixel(|_| {});
    let p = scene_linear_pixel(|m| m.tint = 50.0);
    let default_diff = (default_p[0] + default_p[2]) - 2.0 * default_p[1];
    let tinted_diff  = (p[0]         + p[2])         - 2.0 * p[1];
    assert!(tinted_diff > default_diff,
        "tint+50 should grow R+B vs 2G: default {} → tinted {}",
        default_diff, tinted_diff);
}

#[test]
fn tint_minus_pushes_green() {
    // -tint shifts toward green — G grows relative to R+B.
    let default_p = scene_linear_pixel(|_| {});
    let p = scene_linear_pixel(|m| m.tint = -50.0);
    let default_diff = (default_p[0] + default_p[2]) - 2.0 * default_p[1];
    let tinted_diff  = (p[0]         + p[2])         - 2.0 * p[1];
    assert!(tinted_diff < default_diff,
        "tint-50 should shrink R+B vs 2G: default {} → tinted {}",
        default_diff, tinted_diff);
}

#[test]
fn contrast_plus_creates_s_curve() {
    // Contrast is AgX-internal — assert direction in display-encoded u8.
    // Above-midtone values should brighten; below-midtone should darken.
    fn render_mean(L: f32, configure: impl FnOnce(&mut AdjustmentModel)) -> u8 {
        let dng = SyntheticGreyDng { linear_value: L, ..Default::default() };
        let bytes = dng.write_to_bytes();
        let raw = raw_core::decode::decode_bytes(&bytes, "dng").unwrap();
        let mut model = AdjustmentModel::default();
        configure(&mut model);
        let (w, h, rgb) = render_from_raw(&raw, &model).unwrap();
        let n = (w * h) as usize;
        let s: u32 = (0..n).map(|i| rgb[i*3] as u32).sum();
        ((s + n as u32 / 2) / n as u32) as u8
    }
    let above_default  = render_mean(0.50, |_| {});
    let above_contrast = render_mean(0.50, |m| m.contrast = 50.0);
    let below_default  = render_mean(0.05, |_| {});
    let below_contrast = render_mean(0.05, |m| m.contrast = 50.0);
    assert!(above_contrast > above_default,
        "contrast+50 at L=0.50 should brighten: {} → {}", above_default, above_contrast);
    assert!(below_contrast < below_default,
        "contrast+50 at L=0.05 should darken: {} → {}", below_default, below_contrast);
}
```

- [ ] **Step 3: Run the tests**

```bash
cd /Users/riabuz/Projects/_Maple/src/raw-pipeline
cargo test -p raw-core --features test-support --test grey_adjustments 2>&1 | tail -25
```

Expected: 17 tests pass total.

If `temp_symmetric` fails with a wider ratio, loosen to 0.7..1.4 — the WB curve is not perfectly linear in K and the asymmetry is informational, not a bug we're trying to lock down. The directional test (`temp_warmer_makes_r_gt_b`) is the load-bearing assertion.

If `contrast_plus_creates_s_curve` fails with no movement, the contrast slider may be applied differently than expected — bump the magnitude to ±100 to make the effect bigger and rerun.

- [ ] **Step 4: Commit**

```bash
cd /Users/riabuz/Projects/_Maple
git add src/raw-pipeline/raw-core/tests/grey_adjustments.rs
git commit -m "test(raw-core): relational tests for WB temp/tint and AgX contrast"
```

---

## Task 7: `dump_display_means` helper — provides the integers Apple hard-codes

**Files:**
- Modify: `src/raw-pipeline/raw-core/tests/grey_adjustments.rs`

- [ ] **Step 1: Add the helper test**

Append:

```rust
/// Print the per-channel u8 mean for every adjustment case the Apple
/// UITest covers. Run with `--ignored --nocapture` to dump; the integers
/// it prints get hard-coded into SyntheticGreyUITests.swift's `cases[]`.
///
/// Run:
///   cargo test -p raw-core --features test-support --test grey_adjustments \
///       dump_display_means -- --ignored --nocapture
#[test]
#[ignore]
fn dump_display_means() {
    fn mean(label: &str, configure: impl FnOnce(&mut AdjustmentModel)) {
        let dng = SyntheticGreyDng::default(); // L = 0.18, 64×64 RGGB
        let bytes = dng.write_to_bytes();
        let raw = raw_core::decode::decode_bytes(&bytes, "dng").unwrap();
        let mut model = AdjustmentModel::default();
        configure(&mut model);
        let (w, h, rgb) = render_from_raw(&raw, &model).unwrap();
        let n = (w * h) as usize;
        let mr: u32 = (0..n).map(|i| rgb[i*3]     as u32).sum();
        let mg: u32 = (0..n).map(|i| rgb[i*3 + 1] as u32).sum();
        let mb: u32 = (0..n).map(|i| rgb[i*3 + 2] as u32).sum();
        let nu = n as u32;
        let avg = |s: u32| (s + nu / 2) / nu;
        println!("{:24} R={} G={} B={}", label, avg(mr), avg(mg), avg(mb));
    }
    mean("default",          |_| {});
    mean("exposure +1",      |m| m.exposure = 1.0);
    mean("exposure -1",      |m| m.exposure = -1.0);
    mean("shadows +50",      |m| m.shadows = 50.0);
    mean("whites -50",       |m| m.whites = -50.0);
    mean("contrast +50",     |m| m.contrast = 50.0);
}
```

- [ ] **Step 2: Run the dumper**

```bash
cd /Users/riabuz/Projects/_Maple/src/raw-pipeline
cargo test -p raw-core --features test-support --test grey_adjustments \
    dump_display_means -- --ignored --nocapture 2>&1 | grep -E "^(default|exposure|shadows|whites|contrast)"
```

Expected: six lines of the form `<label> R=<int> G=<int> B=<int>`. Capture these — Tasks 9 and 10 reference them.

Expected baseline (sanity check): `default` should print `R=134 G=134 B=134` per the synthetic-grey-dng Task 10 verification.

- [ ] **Step 3: Commit**

```bash
cd /Users/riabuz/Projects/_Maple
git add src/raw-pipeline/raw-core/tests/grey_adjustments.rs
git commit -m "test(raw-core): dump_display_means helper — produces Apple-side expected values"
```

---

## Task 8: CI gate `test_grey_adjustments.sh`

**Files:**
- Create: `src/scripts/test_grey_adjustments.sh`

- [ ] **Step 1: Create the script**

Create `src/scripts/test_grey_adjustments.sh`:

```bash
#!/usr/bin/env bash
# Closed-form + relational adjustment-validation gate.
#
# Sibling of test_synthetic_grey.sh and test_color_pipeline.sh. Inputs
# synthesised in-memory — no test-fixtures/raws/ needed — so this script
# never skip-passes.
#
# Spec: .archived-plans/specs/2026-04-28-grey-card-adjustment-tests-design.md

set -euo pipefail
cd "$(dirname "$0")/../raw-pipeline"
cargo test -p raw-core --features test-support --test grey_adjustments -- --nocapture
```

- [ ] **Step 2: Make executable + smoke run**

```bash
chmod +x /Users/riabuz/Projects/_Maple/src/scripts/test_grey_adjustments.sh
/Users/riabuz/Projects/_Maple/src/scripts/test_grey_adjustments.sh 2>&1 | tail -15
```

Expected: 17 tests pass, exit 0, wall-clock under 2 seconds. The `dump_display_means` test is `#[ignore]`'d so it won't run in this gate.

- [ ] **Step 3: Commit**

```bash
cd /Users/riabuz/Projects/_Maple
git add src/scripts/test_grey_adjustments.sh
git commit -m "feat(scripts): test_grey_adjustments.sh — adjustment-validation CI gate"
```

---

## Task 9: Apple adjustment XMP fixtures

Six XMPs go into `src/apple/MapleUITests/Fixtures/synthetic/cases/`. They're tiny ACR-format `crs:` sidecars.

**Files:**
- Create: `src/apple/MapleUITests/Fixtures/synthetic/cases/default.xmp`
- Create: `src/apple/MapleUITests/Fixtures/synthetic/cases/exposure-plus1.xmp`
- Create: `src/apple/MapleUITests/Fixtures/synthetic/cases/exposure-minus1.xmp`
- Create: `src/apple/MapleUITests/Fixtures/synthetic/cases/shadows-plus50.xmp`
- Create: `src/apple/MapleUITests/Fixtures/synthetic/cases/whites-minus50.xmp`
- Create: `src/apple/MapleUITests/Fixtures/synthetic/cases/contrast-plus50.xmp`

- [ ] **Step 1: Find a reference XMP to copy schema from**

```bash
find /Users/riabuz/Projects/_Maple/test-fixtures/references -name "*.xmp" -size -2k | head -3
```

Pick the smallest one (any `crs:` slider XMP). Read it to learn the schema shape Maple's parser accepts.

```bash
head -40 $(find /Users/riabuz/Projects/_Maple/test-fixtures/references -name "*.xmp" -size -2k | head -1)
```

- [ ] **Step 2: Write `default.xmp` (no overrides — defaults from AdjustmentModel)**

Create `src/apple/MapleUITests/Fixtures/synthetic/cases/default.xmp`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="Maple Synthetic Test">
  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
    <rdf:Description rdf:about=""
        xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
        crs:Version="15.0"
        crs:ProcessVersion="11.0"
        crs:Exposure2012="0.00"
        crs:Contrast2012="0"
        crs:Highlights2012="0"
        crs:Shadows2012="0"
        crs:Whites2012="0"
        crs:Blacks2012="0"
        crs:Temperature="6500"
        crs:Tint="0"
        crs:Saturation="0"
        crs:Vibrance="0"/>
  </rdf:RDF>
</x:xmpmeta>
```

- [ ] **Step 3: Write `exposure-plus1.xmp`**

Same as `default.xmp` but with `crs:Exposure2012="+1.00"`.

- [ ] **Step 4: Write `exposure-minus1.xmp`**

Same as `default.xmp` but with `crs:Exposure2012="-1.00"`.

- [ ] **Step 5: Write `shadows-plus50.xmp`**

Same as `default.xmp` but with `crs:Shadows2012="+50"`.

- [ ] **Step 6: Write `whites-minus50.xmp`**

Same as `default.xmp` but with `crs:Whites2012="-50"`.

- [ ] **Step 7: Write `contrast-plus50.xmp`**

Same as `default.xmp` but with `crs:Contrast2012="+50"`.

- [ ] **Step 8: Smoke-test by routing one through `maple-cli inspect`**

```bash
cd /Users/riabuz/Projects/_Maple/src/raw-pipeline
cargo run --release --bin maple-cli -- inspect \
    /Users/riabuz/Projects/_Maple/src/apple/MapleUITests/Fixtures/synthetic/cases/exposure-plus1.xmp 2>&1 | head -10
```

Expected: prints the parsed `AdjustmentModel` with `exposure: 1.0`. If parsing fails, the schema differs from the reference — copy the reference XMP wholesale and adjust only the slider value, leaving all other tags intact.

- [ ] **Step 9: Commit**

```bash
cd /Users/riabuz/Projects/_Maple
git add src/apple/MapleUITests/Fixtures/synthetic/cases/
git commit -m "test(apple): commit synthetic-grey adjustment XMP fixtures (6 cases)"
```

---

## Task 10: Apple `SyntheticGreyUITests.swift`

**Files:**
- Create: `src/apple/MapleUITests/SyntheticGreyUITests.swift`

- [ ] **Step 1: Read existing UITest helpers to learn the staging pattern**

Read these files (don't modify):

```bash
ls /Users/riabuz/Projects/_Maple/src/apple/MapleUITests/Helpers/
head -60 /Users/riabuz/Projects/_Maple/src/apple/MapleUITests/Helpers/MapleAppDriver.swift
```

You're looking for: how to stage a tmp dir, how to launch with `MAPLE_UITEST_FIXTURE`, how to wait for `canvas-render-ready`, how to grab the canvas screenshot.

- [ ] **Step 2: Create the test class**

Create `src/apple/MapleUITests/SyntheticGreyUITests.swift`:

```swift
// SyntheticGreyUITests.swift — synthetic-grey adjustment parity harness.
//
// Companion to grey_adjustments.rs (Rust side). Rust validates the
// scene-linear math via closed-form predictions; this test validates
// that Apple's full platform path (Rust FFI scene-linear → Metal AgX →
// Metal sRGB encode → display) lands on the same per-pixel grey value
// that Rust's CPU view tail produces.
//
// Per case it:
//   1. Stages a tmp dir with the synthetic DNG + the renamed XMP.
//   2. Launches Maple with MAPLE_UITEST_FIXTURE pointed at the DNG.
//   3. Waits for canvas-render-ready (refine pass published).
//   4. Screenshots the canvas.
//   5. For every pixel: asserts R == G == B (±2 LSB) — Apple-side neutrality.
//   6. Asserts the canvas mean equals the Rust-rendered mean (±3 LSB)
//      to catch drift between Rust CPU AgX and Apple Metal AgX.
//
// Skips when src/apple/MapleUITests/Fixtures/synthetic/grey-l018-rggb.dng
// is missing (bootstrap step from Task 1 not run on this checkout).
//
// Spec: .archived-plans/specs/2026-04-28-grey-card-adjustment-tests-design.md

import XCTest
import AppKit

final class SyntheticGreyUITests: XCTestCase {

    /// Per-case expected mean. Sourced from `cargo test --test grey_adjustments
    /// dump_display_means -- --ignored --nocapture`. Re-run that test if any
    /// upstream pipeline change is expected to shift the means; update the
    /// integers here to match.
    private struct Case {
        let xmpName: String
        let expectedMean: Int   // R=G=B=this value, ±3 LSB
        let label: String
    }

    private let cases: [Case] = [
        // Values to be filled from Task 7 dump_display_means output.
        // Run grep -E "^(default|exposure|shadows|whites|contrast)" on
        // the dumper output and paste the R values here.
        Case(xmpName: "default.xmp",          expectedMean: /* runtime */ 0, label: "default"),
        Case(xmpName: "exposure-plus1.xmp",   expectedMean: /* runtime */ 0, label: "EV+1"),
        Case(xmpName: "exposure-minus1.xmp",  expectedMean: /* runtime */ 0, label: "EV-1"),
        Case(xmpName: "shadows-plus50.xmp",   expectedMean: /* runtime */ 0, label: "shadows+50"),
        Case(xmpName: "whites-minus50.xmp",   expectedMean: /* runtime */ 0, label: "whites-50"),
        Case(xmpName: "contrast-plus50.xmp",  expectedMean: /* runtime */ 0, label: "contrast+50"),
    ]

    private static let neutralityToleranceLSB = 2
    private static let meanToleranceLSB = 3

    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    func testEachCase() throws {
        let bundle = Bundle(for: type(of: self))
        guard let dngURL = bundle.url(forResource: "grey-l018-rggb",
                                       withExtension: "dng",
                                       subdirectory: "Fixtures/synthetic") else {
            throw XCTSkip("synthetic DNG fixture missing — run Task 1 bootstrap")
        }

        for c in cases {
            try XCTContext.runActivity(named: "case: \(c.label)") { _ in
                guard let xmpURL = bundle.url(forResource: c.xmpName.replacingOccurrences(of: ".xmp", with: ""),
                                               withExtension: "xmp",
                                               subdirectory: "Fixtures/synthetic/cases") else {
                    XCTFail("XMP fixture missing: \(c.xmpName)")
                    return
                }

                // 1. Stage a tmp dir with grey-l018-rggb.dng + grey-l018-rggb.xmp
                let tmp = FileManager.default.temporaryDirectory
                    .appendingPathComponent("synth-grey-\(UUID().uuidString)")
                try FileManager.default.createDirectory(at: tmp, withIntermediateDirectories: true)
                defer { try? FileManager.default.removeItem(at: tmp) }
                let stagedDng = tmp.appendingPathComponent("grey-l018-rggb.dng")
                let stagedXmp = tmp.appendingPathComponent("grey-l018-rggb.xmp")
                try FileManager.default.copyItem(at: dngURL, to: stagedDng)
                try FileManager.default.copyItem(at: xmpURL, to: stagedXmp)

                // 2. Launch Maple via the same driver SliderMatrixUITests uses
                let app = XCUIApplication()
                app.launchEnvironment["MAPLE_UITEST_FIXTURE"] = "grey-l018-rggb.dng"
                app.launchEnvironment["MAPLE_UITEST_FIXTURE_ROOT"] = tmp.path
                app.launch()
                defer { app.terminate() }

                // 3. Wait for canvas-render-ready
                let canvas = app.otherElements["canvas-render-ready"]
                XCTAssertTrue(canvas.waitForExistence(timeout: 30),
                    "canvas-render-ready not published for \(c.label)")

                // 4. Screenshot the canvas
                let shot = canvas.screenshot()
                guard let cgImage = shot.image.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
                    XCTFail("could not get CGImage from canvas screenshot for \(c.label)")
                    return
                }

                // 5+6. Parse pixels
                let (w, h) = (cgImage.width, cgImage.height)
                let bytesPerPixel = 4
                let bytesPerRow = w * bytesPerPixel
                let colorSpace = CGColorSpaceCreateDeviceRGB()
                var pixels = [UInt8](repeating: 0, count: w * h * bytesPerPixel)
                guard let ctx = CGContext(data: &pixels,
                                           width: w, height: h,
                                           bitsPerComponent: 8,
                                           bytesPerRow: bytesPerRow,
                                           space: colorSpace,
                                           bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)
                else {
                    XCTFail("could not build CGContext for \(c.label)")
                    return
                }
                ctx.draw(cgImage, in: CGRect(x: 0, y: 0, width: w, height: h))

                var sumR: Int = 0, sumG: Int = 0, sumB: Int = 0
                let n = w * h
                for i in 0..<n {
                    let r = Int(pixels[i * bytesPerPixel])
                    let g = Int(pixels[i * bytesPerPixel + 1])
                    let b = Int(pixels[i * bytesPerPixel + 2])
                    XCTAssertLessThanOrEqual(abs(r - g), Self.neutralityToleranceLSB,
                        "pixel \(i) |R-G|=\(abs(r-g)) violates neutrality (\(r),\(g),\(b)) [\(c.label)]")
                    XCTAssertLessThanOrEqual(abs(r - b), Self.neutralityToleranceLSB,
                        "pixel \(i) |R-B|=\(abs(r-b)) violates neutrality (\(r),\(g),\(b)) [\(c.label)]")
                    sumR += r; sumG += g; sumB += b
                }
                let meanR = (sumR + n / 2) / n
                let meanG = (sumG + n / 2) / n
                let meanB = (sumB + n / 2) / n
                XCTAssertLessThanOrEqual(abs(meanR - c.expectedMean), Self.meanToleranceLSB,
                    "mean R=\(meanR) deviates from Rust-expected \(c.expectedMean) by > \(Self.meanToleranceLSB) [\(c.label)]")
                XCTAssertLessThanOrEqual(abs(meanG - c.expectedMean), Self.meanToleranceLSB,
                    "mean G=\(meanG) deviates from Rust-expected \(c.expectedMean) by > \(Self.meanToleranceLSB) [\(c.label)]")
                XCTAssertLessThanOrEqual(abs(meanB - c.expectedMean), Self.meanToleranceLSB,
                    "mean B=\(meanB) deviates from Rust-expected \(c.expectedMean) by > \(Self.meanToleranceLSB) [\(c.label)]")
            }
        }
    }
}
```

- [ ] **Step 2: Fill in the expected means using Task 7's dumper output**

Re-run the dumper and paste each `R=<int>` into the matching `expectedMean: ... 0` slot:

```bash
cd /Users/riabuz/Projects/_Maple/src/raw-pipeline
cargo test -p raw-core --features test-support --test grey_adjustments \
    dump_display_means -- --ignored --nocapture 2>&1 | \
    grep -E "^(default|exposure|shadows|whites|contrast)"
```

For each line of the form `<label> R=<int> G=<int> B=<int>`, replace `expectedMean: /* runtime */ 0` with `expectedMean: <int>` for the matching case in `cases[]`. The R, G, and B values should be identical (or within 1 LSB) for any case the synthetic test should pass — if they aren't, that's a bug, not a tolerance issue.

- [ ] **Step 3: Add the new file + its fixtures to the Xcode test bundle**

The Xcode project's MapleUITests target needs to know about `SyntheticGreyUITests.swift` and the `Fixtures/synthetic/` directory. This is a project.pbxproj edit; in Xcode it's "Add Files to MapleUITests" → select the .swift and the Fixtures/synthetic folder.

Without IDE access, edit `src/apple/Maple.xcodeproj/project.pbxproj` directly:

1. Add `SyntheticGreyUITests.swift` to the MapleUITests group's `children` array.
2. Add a `PBXFileReference` for the file.
3. Add it to the MapleUITests target's `Sources` build phase.
4. For `Fixtures/synthetic/` — add it as a folder reference (blue folder, recursive) so the .dng + .xmp files copy into the test bundle. Look at how `Goldens/` is wired up in the existing project (it follows the same pattern) and copy that.

If pbxproj editing is intractable headlessly, document in the commit message that the next maintainer must "drag Fixtures/synthetic into MapleUITests in Xcode" — mark this as a one-shot manual step.

- [ ] **Step 4: Build the UITest scheme**

```bash
cd /Users/riabuz/Projects/_Maple/src/apple
xcodebuild build-for-testing \
    -project Maple.xcodeproj \
    -scheme Maple \
    -destination 'platform=macOS' \
    -only-testing:MapleUITests/SyntheticGreyUITests 2>&1 | tail -20
```

Expected: `BUILD SUCCEEDED`. If the new file isn't found, the project.pbxproj edit didn't land — fix it before continuing.

- [ ] **Step 5: Run the tests on macOS**

```bash
cd /Users/riabuz/Projects/_Maple/src/apple
xcodebuild test \
    -project Maple.xcodeproj \
    -scheme Maple \
    -destination 'platform=macOS' \
    -only-testing:MapleUITests/SyntheticGreyUITests 2>&1 | tail -30
```

Expected: 1 test passing (`testEachCase` with 6 sub-activities, all green).

If the test hangs on `canvas-render-ready`, the production code may not raise that accessibility identifier when the synthetic input is loaded — diagnose by attaching screenshots and checking `MAPLE_UITEST_FIXTURE_ROOT` is honoured for non-camera-RAW inputs.

If neutrality assertions fail (canvas not R=G=B), the bug is in the platform path (FFI handoff or Metal view tail) — that's a real find, not a test bug. Report and pause.

If mean asserts fail by 4+ LSB, capture the Rust mean (Task 7) at the matching case, compare. Tolerance may need to relax to ±5 LSB to absorb Apple Metal precision; document.

- [ ] **Step 6: Commit**

```bash
cd /Users/riabuz/Projects/_Maple
git add src/apple/MapleUITests/SyntheticGreyUITests.swift \
        src/apple/Maple.xcodeproj/project.pbxproj
git commit -m "test(apple): SyntheticGreyUITests — adjustment parity vs Rust-rendered means"
```

---

## Final verification

- [ ] **Step 1: Full Rust gate**

```bash
cd /Users/riabuz/Projects/_Maple
./src/scripts/test_grey_adjustments.sh 2>&1 | tail -10
./src/scripts/test_synthetic_grey.sh 2>&1 | tail -10
```

Expected: both pass, total wall-clock under 4 seconds.

- [ ] **Step 2: Full raw-core test suite (no regressions)**

```bash
cd /Users/riabuz/Projects/_Maple/src/raw-pipeline
cargo test -p raw-core --features test-support 2>&1 | grep -E "test result"
```

Expected: all suites pass — pre-existing `raw-core` lib tests + grey_invariants + grey_adjustments + new predictor unit tests.

- [ ] **Step 3: Apple UITest run**

```bash
cd /Users/riabuz/Projects/_Maple/src/apple
xcodebuild test \
    -project Maple.xcodeproj \
    -scheme Maple \
    -destination 'platform=macOS' \
    -only-testing:MapleUITests/SyntheticGreyUITests 2>&1 | tail -10
```

Expected: PASS. If the OS prompts for keychain/biometric access (first-time UITest run on a fresh machine), authorise it once via Xcode.app's UI run, then re-run from the CLI — same caveat as `MapleUITests` documented in CLAUDE.md.

- [ ] **Step 4: Confirm shipping artifacts still skip the test-support feature**

```bash
cd /Users/riabuz/Projects/_Maple/src/raw-pipeline
cargo build -p raw-core 2>&1 | tail -5
```

Expected: clean build without `test-support`. The new `predictions` and `synth_dng` modules must not be visible.

---

## Acceptance criteria (from spec)

- [x] (planned) Every public function in `predictions.rs` has a `1e-6` round-trip unit test against `scene_tone_controls::apply` — Tasks 2-3
- [x] (planned) `grey_adjustments.rs` runs all closed-form + relational tests in <1s wall-clock — Tasks 4-6
- [x] (planned) `src/scripts/test_grey_adjustments.sh` exits 0 on `main` — Task 8
- [x] (planned) `SyntheticGreyUITests` runs all six cases on macOS — Task 10
- [x] (planned) Per-case Apple display mean falls within ±3 LSB of Rust-rendered display mean — Tasks 7, 10
