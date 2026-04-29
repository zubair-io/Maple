# DCP Code-Path Coverage on Synthetic Inputs

**Status:** design approved, ready for implementation plan
**Date:** 2026-04-29
**Owner:** Zubair
**Builds on:**
- `docs/superpowers/specs/2026-04-28-synthetic-grey-dng-design.md`
- `docs/superpowers/specs/2026-04-28-grey-card-adjustment-tests-design.md`

## Problem

The synthetic grey DNG infrastructure validates pipeline neutrality and per-slider scene-linear math. It does not exercise the DCP (DNG Camera Profile) code paths — `color/dcp.rs`, `color/hsm.rs`, `color/profile_tone_curve.rs`, `color/profile_gain_table_map.rs`. Every real DNG that ships through Maple runs through these stages; the synthetic uses identity matrices and skips all of them.

Bugs in DCP application would silently affect every real RAW. The dual-CM CCT interpolation in particular is gnarly math (Bradford CA in XYZ, dual-illuminant blend by reciprocal-CCT) and runs unobserved in production tests.

## Goal

Two-phase coverage:

**Phase 1 — Single-patch + DCP scalars** (extends `SyntheticGreyDng`):
- Dual ColorMatrix1+2 with real Hasselblad data (drives the CCT-interpolation path)
- Optional ForwardMatrix1+2 (drives the FM-replaces-Bradford path)
- Hand-crafted ProfileToneCurve (closed-form predictable)

**Phase 2 — Multi-patch + DCP LUTs** (new `SyntheticColorChart`):
- 24-patch ColorChecker-style synthetic input
- Hand-crafted minimal HSM, ProfileLookTable, ProfileGainTableMap
- Per-patch closed-form predictions for HSM marked cells, identity cells, radial gain

Predictions follow the principle established earlier (predict from spec, not from current Maple output). Tests fail when Maple deviates from documented DCP math.

## Non-goals

- **Real production-grade HSM tables**. Hand-crafted minimal LUTs with one non-identity cell are tractable to predict; real 90×30×1 tables tuned for cameras are not.
- **Vendor-specific RAW format support**. Synthetic remains DNG with documented tag layouts.
- **End-to-end Apple parity**. Earlier work paused that lane on ImageIO incompatibility; that work is independent of DCP coverage.

## Architecture

```
src/raw-pipeline/raw-core/
  src/test_support/
    synth_dng.rs                 ← extend: optional ColorMatrix2, FM, PTC, HSM, LUT, GainTableMap
    synth_chart.rs               ← NEW: Macbeth 6×4 multi-patch generator
    predictions.rs               ← extend: predict_tone_curve, predict_hsm_cell, predict_radial_gain
    hasselblad_dcp.rs            ← NEW: baked Hasselblad constants from test_0000.DNG
    extract_dcp.rs               ← NEW: one-shot dumper (compiled, run on demand)
    mod.rs                       ← register new modules
  tests/
    grey_dcp_phase1.rs           ← NEW: dual-CM, FM, ProfileToneCurve closed-form
    chart_dcp_phase2.rs          ← NEW: HSM, LookTable, GainTableMap on color chart

src/scripts/
  test_grey_dcp.sh               ← NEW: CI gate
```

### Why split `synth_chart` from `synth_dng`

The Macbeth chart generator handles patch layout, guard bands, demosaic-aware boundaries — concerns the single-patch generator doesn't have. Sharing `Ifd` / `write_*_le` primitives keeps duplication minimal. The split also keeps the existing 17 tests on `SyntheticGreyDng` from regressing — Phase 1 extends `SyntheticGreyDng` only via `Option<...>` fields with `None` defaults.

### Data sourcing

| What | Source | Why |
| --- | --- | --- |
| ColorMatrix1+2, AsShotNeutral | Real Hasselblad (test_0000.DNG) | Tests real CM math under CCT interpolation; dumper bakes constants once |
| ForwardMatrix1+2 | Hand-crafted near-identity | Drives FM path predictably |
| ProfileToneCurve | Hand-crafted 5-point S-curve | Closed-form predictable |
| HSM | Hand-crafted 8×4×1 with one marked cell | Single non-identity cell makes predictions explicit |
| ProfileLookTable | Hand-crafted, same shape | Composes after HSM, observable separately |
| ProfileGainTableMap | Hand-crafted 5-point radial | Tests radial gain at center vs corner |

A one-shot Rust example program at `examples/extract-dcp.rs` reads `test-fixtures/raws/test_0000.DNG`, prints the constants in source-pasteable form, and the engineer pastes them into `hasselblad_dcp.rs`. The dumper itself is committed but only run when the source DNG changes.

## Phase 1 — `SyntheticGreyDng` extensions

```rust
pub struct SyntheticGreyDng {
    // Existing fields (unchanged):
    pub linear_value: f32,
    pub width: u32,
    pub height: u32,
    pub cfa: CfaPattern,
    pub illuminant: Illuminant,

    // NEW — optional, default None preserves existing test behavior:
    pub color_matrix_2: Option<[[f32; 3]; 3]>,
    pub calibration_illuminant_2: Option<u16>,        // 17 = StdA, 21 = D65, etc.
    pub forward_matrix_1: Option<[[f32; 3]; 3]>,
    pub forward_matrix_2: Option<[[f32; 3]; 3]>,
    pub profile_tone_curve: Option<Vec<(f32, f32)>>,  // (input, output) pairs
    pub as_shot_neutral_override: Option<[f32; 3]>,
}
```

Two builder methods:

```rust
impl SyntheticGreyDng {
    pub fn with_hasselblad_dcp(self) -> Self;
    pub fn with_simple_tone_curve(self) -> Self;
}
```

`with_hasselblad_dcp()`:
- Replaces existing ColorMatrix1 (currently identity) with the Hasselblad StdA matrix
- Sets ColorMatrix2 to the Hasselblad D65 matrix
- Sets AsShotNeutral to the real Hasselblad value (~[0.37, 1.0, 0.68])
- Leaves PTC, HSM, etc. as `None`

`with_simple_tone_curve()`:
- Hand-crafted 5 control points: (0,0), (0.18, 0.15), (0.5, 0.55), (0.82, 0.9), (1.0, 1.0)
- Slight contrast S-curve, monotonic, easy to predict

### Phase 1 tests (`tests/grey_dcp_phase1.rs`)

Four tests, all closed-form:

```rust
#[test] fn neutral_preserved_under_real_dcp();
#[test] fn cct_interpolation_continuous();
#[test] fn forward_matrix_replaces_bradford();
#[test] fn profile_tone_curve_predicts();
```

`neutral_preserved_under_real_dcp`: synthesise neutral input + Hasselblad dual-CM. Per DCP definition, a neutral camera reading at the calibration illuminant must render neutral after CM application. Assert post-DCP `R == G == B` within `5e-4`.

`cct_interpolation_continuous`: sweep AsShotNeutral across the StdA→D65 axis (5 sample points). Assert max |Δ| between adjacent samples is bounded — no discontinuity at the CCT crossover.

`forward_matrix_replaces_bradford`: compare FM-on vs FM-off outputs. They should differ in scene-linear (FM and Bradford aren't equivalent in general), confirming the FM path activates when the tag is present.

`profile_tone_curve_predicts`: synthesise across L ∈ {0.05, 0.18, 0.50, 0.82}; assert post-PTC scene-linear == `predict_tone_curve(L, control_points)` within `5e-4`.

## Phase 2 — `SyntheticColorChart`

```rust
pub struct SyntheticColorChart {
    /// 6×4 = 24 scene-linear Rec.2020 RGB targets per patch.
    pub patches: [[[f32; 3]; 6]; 4],
    pub patch_size: u32,    // default 32
    pub guard: u32,         // default 8
    pub cfa: CfaPattern,
    pub illuminant: Illuminant,

    // Same DCP fields as SyntheticGreyDng (Phase 1) plus Phase 2:
    pub hsm_dims: Option<[u32; 3]>,
    pub hsm_data_1: Option<Vec<f32>>,
    pub hsm_data_2: Option<Vec<f32>>,
    pub look_table_dims: Option<[u32; 3]>,
    pub look_table_data: Option<Vec<f32>>,
    pub gain_table_map: Option<GainTableMap>,
    // Plus all Phase 1 fields (color_matrix_2, etc.).
}

impl SyntheticColorChart {
    pub fn write_to(&self, path: &Path) -> io::Result<()>;
    pub fn write_to_bytes(&self) -> Vec<u8>;

    /// Read patch (col, row) from a rendered Image. Skips guard bands —
    /// returns the mean of the patch's interior (excluding 4-pixel edge).
    pub fn read_patch_mean(&self, image: &Image, col: usize, row: usize) -> [f32; 3];
}
```

Default patches: precomputed scene-linear Rec.2020 versions of the 24 X-Rite ColorChecker swatches.

Layout (default sizes): 6 × (32 + 8) − 8 = 232 wide, 4 × 40 − 8 = 152 tall. Small enough to render in <50ms.

### Hand-crafted LUTs

```rust
pub fn make_test_hsm() -> (Vec<u32>, Vec<f32>) {
    // 8×4×1, identity everywhere except cell (hue=2, sat=2).
    // Marked cell: hue_shift = +30°, sat_scale = 2.0, val_scale = 1.0.
}

pub fn make_test_look_table() -> (Vec<u32>, Vec<f32>) {
    // Same shape, marked cell at (hue=5, sat=2): hue_shift = -15°.
}

pub fn make_test_gain_table() -> GainTableMap {
    // 5-point radial: 1.5× at center, 1.0× at 50%, 0.7× at edge.
}
```

### Phase 2 tests (`tests/chart_dcp_phase2.rs`)

```rust
#[test] fn hsm_applies_at_marked_cell();
#[test] fn hsm_off_marked_cell_is_identity();
#[test] fn look_table_composes_after_hsm();
#[test] fn gain_table_radial();
```

`hsm_applies_at_marked_cell`: pick the patch whose (h, s, v) lands in cell (2, 2, 0). After DCP + HSM, assert the patch's hue shift = +30° ± tolerance and saturation scale = 2× ± tolerance.

`hsm_off_marked_cell_is_identity`: patches outside the marked cell round-trip through HSM unchanged. Per-patch closed-form: post-HSM == post-DCP-pre-HSM within `5e-4`.

`look_table_composes_after_hsm`: enable both LUTs. The observed shift at a patch hitting both marked cells should be the composition of the two predictors (`predict_look_table(predict_hsm_cell(input))`).

`gain_table_radial`: pick two patches with the same target color at different chart radii (center vs corner). Post-gain ratio should match `predict_radial_gain(1.0, r_norm)` ratio between the two radii.

### Predictor extensions

```rust
/// Mirrors color/profile_tone_curve::apply (monotonic-cubic interp).
pub fn predict_tone_curve(scene: f32, control_points: &[(f32, f32)]) -> f32;

/// Mirrors color/hsm::apply. Input/output is ProPhoto-D50 linear RGB (the
/// space production HSM operates in); internally the predictor converts
/// to HSV for the LUT lookup and back to RGB for the return.
pub fn predict_hsm_cell(input_rgb: [f32; 3], dims: &[u32; 3], data: &[f32]) -> [f32; 3];

/// Mirrors color/profile_gain_table_map::apply (radial 1D LUT, linear interp).
pub fn predict_radial_gain(input: f32, radius_norm: f32, gain_values: &[f32]) -> f32;
```

Each predictor has a 1×1 drift unit test against the matching production stage at `1e-6`.

## Tolerance budgets

| Assertion | Budget | Justification |
| --- | --- | --- |
| Phase 1 scene-linear | `5e-4` | Same as existing grey_invariants — float drift |
| Phase 2 patch-mean scene-linear | `5e-4` | Mean over 24×24 interior averages out edge noise |
| Predictor unit tests (1×1) | `1e-6` | Pure-Rust function pair, near-exact |
| CCT continuity max-delta | `1e-2` per channel | Sweep is intentionally coarse; locks down "no discontinuity" not "smooth math" |

Budgets ratchet downward only.

## CI gate

`src/scripts/test_grey_dcp.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../raw-pipeline"
cargo test -p raw-core --features test-support \
    --test grey_dcp_phase1 --test chart_dcp_phase2 -- --nocapture
```

Sibling of `test_grey_adjustments.sh` and `test_synthetic_grey.sh`.

## Acceptance criteria

- Every public predictor function in `predictions.rs` has a `1e-6` round-trip unit test against the matching production stage.
- Phase 1 tests in `grey_dcp_phase1.rs` all pass under default budget on `main`.
- Phase 2 tests in `chart_dcp_phase2.rs` all pass under default budget on `main`.
- `test_grey_dcp.sh` exits 0 in <2 seconds wall-clock.
- Existing `grey_invariants.rs` and `grey_adjustments.rs` continue to pass without modification (no regressions in Phase 1 extensions).
- Shipping `cargo build -p raw-core` (no `test-support`) remains clean — all DCP additions are gated.

## Out-of-scope (follow-ups)

- **Real HSM tables from cameras**. Hand-crafted minimal LUTs are sufficient for now; real tables would require modeling complex tuning curves.
- **iOS-side parity**. Apple test track paused on ImageIO compatibility; revisit after restructuring the synthetic DNG to a thumbnail-IFD0 layout.
- **Non-DNG vendor formats**. CFA RAW from Canon, Nikon, etc. won't carry DCP tags the same way; that's a separate path.
- **Real-camera AsShotNeutral with synthetic patches**. The chart is rendered with a generic D65 AsShotNeutral; combining real CM with real WB needs a third pass.
