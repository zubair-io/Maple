# Grey-Card Adjustment Tests — Closed-Form Pipeline Validation

**Status:** design approved, ready for implementation plan
**Date:** 2026-04-28
**Owner:** Zubair
**Builds on:** `docs/superpowers/specs/2026-04-28-synthetic-grey-dng-design.md`

## Problem

The synthetic grey DNG harness validates that the pipeline preserves neutrality on a default `AdjustmentModel`. It does not yet validate that **adjustments produce the values they should** — exposure +1 EV must double the scene-linear value, shadows +50 must lift dark zones along the documented mask, etc.

We need test infrastructure that asserts *predicted* values for every adjustment whose scene-linear math is closed-form, plus relational assertions for the AgX-internal and WB sliders that aren't.

## Goal

Per scope C+ (chosen during brainstorming):

- **Closed-form scene-linear predictions** for every adjustment in `scene_tone_controls::apply` plus saturation / vibrance — tested on the synthetic neutral patch with per-pixel `f32` value comparisons.
- **Relational scene-linear assertions** for AgX-internal sliders (contrast) and WB (temperature, tint) — direction, symmetry, magnitude relationships, no closed-form.
- **Display-encoded neutrality** preserved through the full chain for every case — cheap `R=G=B` assertion in `u8`.
- **Apple parity** — UITest renders the same synthetic input + adjustment XMPs, asserts the canvas is neutral and the mean tracks the Rust-rendered mean within ±3 LSB.

## Non-goals

- **Closed-form display-encoded predictions.** Predicting an exact post-AgX `u8` value from a scene-linear input requires modelling AgX in the test, which is fragile against any AgX tweak. The display-encoded check stays at "R = G = B" plus the parity comparison against Rust.
- **Coverage of the dehaze, NR, sharpen, clarity, texture sliders.** Spatial filters; flatness on a single-patch synthetic input is already covered by `grey_invariants.rs`. Expanding to multi-patch inputs is a follow-up.
- **Testing every slider × every L value.** L sweep is `{0.05, 0.18, 0.50}` per slider, not exhaustive — same convention as the existing harness.

## Architecture

```
src/raw-pipeline/raw-core/
  src/test_support/
    predictions.rs              ← NEW: closed-form predictors per slider
    synth_dng.rs                ← existing
    mod.rs                      ← register predictions module
  tests/
    grey_invariants.rs          ← existing (default-model neutrality+flatness)
    grey_adjustments.rs         ← NEW: closed-form predictions per adjustment

src/apple/MapleUITests/
  Fixtures/synthetic/
    grey-l018-rggb.dng          ← committed (~8KB, generated once via synth-grey example)
    cases/
      default.xmp
      exposure-plus1.xmp
      exposure-minus1.xmp
      shadows-plus50.xmp
      whites-minus50.xmp
      contrast-plus50.xmp
  SyntheticGreyUITests.swift    ← NEW: parity test

src/scripts/
  test_grey_adjustments.sh      ← NEW: CI gate sibling of test_synthetic_grey.sh
```

### Why split `grey_invariants.rs` from `grey_adjustments.rs`

The existing file tests *default-model* neutrality + flatness. The new file tests *non-default* models with predicted values. Different concerns — neutrality preservation vs. value prediction — and the file would balloon if combined.

### Why commit fixtures instead of generating

`test-fixtures/raws/` is gitignored (the camera-RAW corpus is 6.5GB). Generating in Swift means porting the writer; calling `cargo run --example synth-grey` from the Apple test target couples toolchains. The DNG is 8KB and immutable — committing under `MapleUITests/Fixtures/synthetic/` is cheaper than the alternatives and matches the existing `Goldens/` pattern.

## Closed-form predictors (`predictions.rs`)

One pure function per scene-linear adjustment. Each mirrors the math in `scene_tone_controls::apply` exactly — the predictors are not independent reimplementations.

```rust
pub fn predict_exposure(scene: f32, ev: f32) -> f32 {
    scene * ev.exp2()
}

pub fn predict_highlights(scene: f32, h_slider: f32) -> f32 {
    if scene <= 1.0 { return scene; }
    let h_amount = h_slider / 100.0;
    let h_denom = 1.0 + h_amount * 2.0;
    if h_denom.abs() < 1e-6 { return scene; }
    1.0 + (scene - 1.0) / h_denom
}

pub fn predict_shadows(scene: f32, s_slider: f32) -> f32 {
    let s_factor = (s_slider / 100.0) * 0.5;
    let mask = 1.0 - smoothstep(0.0, 0.1, scene); // luma == scene for neutrals
    let lift = mask * s_factor;
    scene * (1.0 + lift)
}

pub fn predict_whites(scene: f32, w_slider: f32) -> f32 { /* mirrors step 4 */ }
pub fn predict_blacks(scene: f32, b_slider: f32) -> f32 { /* mirrors step 5 */ }

pub fn predict_saturation(scene: f32, _s_slider: f32) -> f32 { scene }
pub fn predict_vibrance(scene: f32, _v_slider: f32) -> f32 { scene }
```

Each predictor takes a scalar (the scene-linear value) because R=G=B for a neutral, so luma = the channel value and per-pixel math reduces to scalar math.

**Drift prevention**: each predictor has a unit test that synthesises a 1×1 image, runs `scene_tone_controls::apply` on it, and asserts the production code lands on what the predictor predicted (within `1e-6`). Anyone touching `scene_tone_controls.rs` and forgetting to update the predictor breaks this unit test.

## Rust adjustment tests (`grey_adjustments.rs`)

### Pattern

```rust
fn assert_predicted_scene_linear(
    L: f32,
    configure: impl FnOnce(&mut AdjustmentModel),
    predict: impl Fn(f32) -> f32,
) {
    // 1. synthesize L
    // 2. apply configure(model)
    // 3. develop_scene_linear_from_raw_with_quality
    // 4. assert per-pixel == predict(L) within EPS_SCENE_LINEAR
}

fn assert_neutral_display(L: f32, configure: impl FnOnce(&mut AdjustmentModel)) {
    // synthesize → render_from_raw → assert per-pixel R=G=B in u8
}
```

### Closed-form tests

```rust
#[test] fn exposure_plus1_predicts()    { /* L sweep + neutrality */ }
#[test] fn exposure_minus1_predicts()   { /* L sweep + neutrality */ }
#[test] fn shadows_plus50_predicts()    { /* L sweep + neutrality */ }
#[test] fn shadows_minus50_predicts()   { /* L sweep + neutrality */ }
#[test] fn whites_plus50_predicts()     { /* L sweep + neutrality */ }
#[test] fn whites_minus50_predicts()    { /* L sweep + neutrality */ }
#[test] fn blacks_plus50_predicts()     { /* L sweep + neutrality */ }
#[test] fn blacks_minus50_predicts()    { /* L sweep + neutrality */ }
#[test] fn saturation_no_op_on_neutral() { /* any slider, identity prediction */ }
#[test] fn vibrance_no_op_on_neutral()   { /* any slider, identity prediction */ }
#[test] fn highlights_compresses_above_knee() {
    // composes exposure(+2) → scene 2.0 → highlights(+50) → predicted 1.5
}
```

### Relational tests

```rust
#[test] fn temp_warmer_makes_r_gt_b() { /* +1000K shifts R/B > 1 */ }
#[test] fn temp_cooler_makes_b_gt_r() { /* -1000K shifts R/B < 1 */ }
#[test] fn temp_symmetric() {
    // |R-B| at +1000K ≈ |R-B| at -1000K within ~5%
}
#[test] fn tint_plus_pushes_magenta() { /* R+B > 2G after tint=+50 */ }
#[test] fn tint_minus_pushes_green()  { /* R+B < 2G after tint=-50 */ }
#[test] fn contrast_creates_s_curve() {
    // L=0.50 + contrast=+50 brightens vs default (above midtone)
    // L=0.05 + contrast=+50 darkens vs default (below midtone)
    // No exact prediction; direction-only.
}
```

### Tolerance budgets

| Assertion                        | Budget                  | Justification                                              |
| -------------------------------- | ----------------------- | ---------------------------------------------------------- |
| Scene-linear value (closed-form) | `5e-4` per channel      | Float drift in pipeline; matches existing `grey_invariants` |
| Display-encoded neutrality       | `±2 LSB` (u8)           | AgX LUT + gamma encode quantisation                        |
| Predictor unit tests             | `1e-6`                  | Pure-Rust function pair, must be near-exact                |

### Coverage

- 11 closed-form tests, each running the L sweep `{0.05, 0.18, 0.50}` (or composed values)
- 6 relational tests
- Display-encoded neutrality assertion runs alongside every closed-form test (no separate test functions)
- Total: ~17 test functions, ~50 assertions, well under 1 second wall-clock

## Apple parity (`SyntheticGreyUITests.swift`)

### Fixtures

- `grey-l018-rggb.dng` (committed, ~8KB) — bootstrap: run `cargo run --example synth-grey -- --value 0.18 --out src/apple/MapleUITests/Fixtures/synthetic/grey-l018-rggb.dng` once, commit, never touched again.
- `cases/*.xmp` — hand-written or copied from existing `crs:` slider XMPs in `test-fixtures/references/`, retargeted. Six cases (default, exposure ±1, shadows +50, whites -50, contrast +50).

### Pattern

```swift
private struct Case {
    let xmpName: String
    let expectedDisplayMean: Int  // from grey_adjustments::dump_display_means
    let label: String
}

private let cases: [Case] = [
    Case(xmpName: "default.xmp",         expectedDisplayMean: 134, label: "default"),
    Case(xmpName: "exposure-plus1.xmp",  expectedDisplayMean: /* runtime */, label: "EV+1"),
    Case(xmpName: "exposure-minus1.xmp", expectedDisplayMean: /* runtime */, label: "EV-1"),
    Case(xmpName: "shadows-plus50.xmp",  expectedDisplayMean: /* runtime */, label: "shadows+50"),
    Case(xmpName: "whites-minus50.xmp",  expectedDisplayMean: /* runtime */, label: "whites-50"),
    Case(xmpName: "contrast-plus50.xmp", expectedDisplayMean: /* runtime */, label: "contrast+50"),
]

func testEachCase() {
    for c in cases {
        // 1. Stage tmp dir: copy grey-l018-rggb.dng + rename xmp → grey-l018-rggb.xmp
        // 2. Launch Maple with MAPLE_UITEST_FIXTURE=grey-l018-rggb.dng
        // 3. Wait for canvas-render-ready
        // 4. Screenshot canvas
        // 5. Parse pixels:
        //    - assert per-pixel R == G == B  (Apple-side neutrality, ±2 LSB)
        //    - assert mean within ±3 LSB of c.expectedDisplayMean
    }
}
```

**The `/* runtime */` placeholders get filled during implementation** by a `dump_display_means` helper test in `grey_adjustments.rs` that prints `(case_label, mean_u8)` for every case. The Apple test hard-codes those integers with a comment pointing back to the Rust dumper. The spec leaves them unspecified because they are derived from the production code, not from the spec.

### Tolerance

- Per-pixel R=G=B: `±2 LSB` (Apple Metal float precision)
- Mean delta vs Rust expected: `±3 LSB` (absorbs any drift between Rust CPU AgX and Apple Metal AgX)

### Skipping

If `MapleUITests/Fixtures/synthetic/grey-l018-rggb.dng` is missing (the bootstrap step wasn't run), `XCTSkip` mirroring the existing slider-matrix harness pattern.

## CI gate

`src/scripts/test_grey_adjustments.sh`:

```bash
#!/usr/bin/env bash
# Closed-form adjustment validation gate.
set -euo pipefail
cd "$(dirname "$0")/../raw-pipeline"
cargo test -p raw-core --features test-support --test grey_adjustments -- --nocapture
```

Sibling of `test_synthetic_grey.sh` and `test_color_pipeline.sh`. Same never-skip-passes property — inputs synthesised in-memory.

## Acceptance criteria

- Every public function in `predictions.rs` has a `1e-6` round-trip unit test against `scene_tone_controls::apply`.
- `grey_adjustments.rs` runs all closed-form + relational tests in <1s wall-clock.
- `src/scripts/test_grey_adjustments.sh` exits 0 on `main`.
- `SyntheticGreyUITests` runs all six cases on macOS (`-destination 'platform=macOS'`) with no failures, given the bootstrap DNG present.
- Per-case Apple display mean falls within ±3 LSB of the Rust-rendered display mean documented in `dump_display_means` output.

## Out-of-scope (follow-ups)

- **Multi-patch synthetic input** — a step wedge instead of a single value, exercising every zone curve in one render. Bigger generator change; only worth it if zone-interaction bugs start slipping through.
- **Tone-curve closed-form display predictions** — model AgX in the test as a known function. Fragile; revisit only if AgX stabilises.
- **WB temp absolute prediction** — model the temp/tint → WB-multiplier function. Bounded but involved; relational coverage is enough until a regression demands it.
- **iOS UITest matrix** — the existing slider-matrix harness is macOS-only; same constraint applies here.
