//! `Case` builders for the composed-chain parity gate (`full_chain/tests.rs`).
//!
//! Split out purely for the file-size budget: adding `film_case` (epic
//! #2683, Task 7 fix round 1 — composed-chain coverage for `FilmLutPass`)
//! pushed `tests.rs` to 638 lines, past the 600-line hard limit. Included via
//! `#[path = "tests_cases.rs"] mod tests_cases;` from `tests.rs`, so it
//! reaches the parent module's items through `super::*`.

use super::*;

/// The mild case: every per-pixel stage engaged just PAST its raw-core no-op
/// threshold, so the CPU `apply` fn does NOT short-circuit and computes the same
/// function the always-running GPU Pass does. (A truly-neutral all-identity case
/// would diverge by design: raw-core's `apply` fns return early at default
/// values while the GPU Passes run their arithmetic unconditionally — their
/// short-circuit is delegated to the *caller*, i.e. develop's `if` guards / the
/// P4b live chain, NOT to this composition layer. The all-identity *plumbing* is
/// covered by the structural prefix+suffix / pass-count tests below.)
///
/// `capture_sharpening` stays `None` here — that is the ONE legitimate builder
/// gate (symmetric: the CPU oracle also `if let Some`), validated by the pass-
/// count test. Mild magnitudes keep the per-image curve + LUT non-identity so the
/// view-tail matrix/Oklab/trilinear paths also run for real on both sides.
pub(super) fn mild_case() -> Case {
    let model = AdjustmentModel {
        temperature: 6000.0, // past the (6500±0.5) WB short-circuit
        tint: 3.0,
        exposure: 0.1,
        contrast: 8.0,
        highlights: -5.0, // past the |h| < 1e-3 scene-tone short-circuit
        shadows: 5.0,
        whites: 4.0,
        blacks: -4.0,
        parametric_lights: 6.0, // engage tone_curves (past PARAMETRIC_EPSILON)
        parametric_shadows: 5.0,
        vibrance: 6.0,   // past the |vibrance| < 1e-3 Oklab short-circuit
        saturation: 5.0, // past the |saturation| < 1e-3 short-circuit
        clarity: 8.0,    // self-copy-through at 0, but engaged so it's tested
        texture: 6.0,
        dehaze: 10.0,           // non-zero so dehaze runs (airlight engaged)
        vignette_amount: -10.0, // past the |amount| < 1e-3 short-circuit (#1109)
        vignette_feather: 50.0,
        grain_amount: 15.0, // engaged display-tail grain (#1110)
        grain_size: 25.0,
        grain_roughness: 50.0,
        split_tone_shadow_hue: 30.0, // engaged display-tail tint (#1111)
        split_tone_shadow_saturation: 20.0,
        split_tone_highlight_hue: 210.0,
        split_tone_highlight_saturation: 15.0,
        split_tone_balance: 10.0,
        sharpen_amount: 50.0,
        sharpen_radius: 1.0,
        sharpen_detail: 25.0,
        sharpen_masking: 0.0,
        nr_luminance: 10.0,
        nr_color: 15.0,
        // auto_exposure is not a GPU stage; pin Off so the model is unambiguous
        // (the develop chain runs AE CPU-side — out of scope here).
        auto_exposure: AutoExposureMode::Off,
        ..AdjustmentModel::default()
    };
    Case {
        model,
        capture: None, // the one legitimate builder gate (pass-count test)
        curve: nonidentity_curve(),
        lut: nonidentity_lut(9),
        wb_method: WbMethod::Cat16,
        film_lut: None, // no film look — see `film_case` for that coverage
        film_strength: 0.0,
    }
}

/// The aggressive case: every stage engaged so every kernel runs for real.
pub(super) fn aggressive_case() -> Case {
    let model = AdjustmentModel {
        temperature: 4800.0, // non-default WB (dodges the (6500,0) identity)
        tint: 18.0,
        exposure: 0.4,
        contrast: 35.0,
        highlights: -40.0,
        shadows: 30.0,
        whites: 20.0,
        blacks: -15.0,
        parametric_shadows: 20.0,
        parametric_darks: -10.0,
        parametric_lights: 15.0,
        parametric_highlights: -20.0,
        // A non-identity per-channel point curve (luma), exercising tone_curves'
        // luma-coupled path. Knots in [0,1]^2.
        tone_curve_luma: ToneCurve::new(vec![(0.0, 0.0), (0.25, 0.18), (0.75, 0.82), (1.0, 1.0)]),
        tone_curve_mode: ToneCurveMode::RatioPreserving,
        vibrance: 35.0,
        saturation: 25.0,
        clarity: 40.0,
        texture: 30.0,
        dehaze: 45.0, // non-zero so the dehaze path actually runs (airlight matters)
        vignette_amount: -65.0, // engaged radial gain (#1109)
        vignette_feather: 30.0,
        grain_amount: 60.0, // engaged display-tail grain (#1110)
        grain_size: 70.0,
        grain_roughness: 80.0,
        split_tone_shadow_hue: 30.0, // engaged display-tail tint (#1111)
        split_tone_shadow_saturation: 70.0,
        split_tone_highlight_hue: 250.0,
        split_tone_highlight_saturation: 60.0,
        split_tone_balance: -40.0,
        sharpen_amount: 80.0,
        sharpen_radius: 1.5,
        sharpen_detail: 30.0,
        sharpen_masking: 20.0,
        nr_luminance: 30.0,
        nr_color: 40.0,
        auto_exposure: AutoExposureMode::Off,
        ..AdjustmentModel::default()
    };
    Case {
        model,
        capture: Some(CaptureSharpeningParams {
            sigma: 0.8,
            iterations: 2,
            highlight_threshold: 0.9,
            strength: 1.0,
            noise_floor: 3e-4,
        }),
        curve: nonidentity_curve(),
        lut: nonidentity_lut(9),
        wb_method: WbMethod::Cat16,
        film_lut: None, // no film look — see `film_case` for that coverage
        film_strength: 0.0,
    }
}

/// The film-look case (epic #2683, Task 7 fix round 1): proves the composed
/// GPU chain's `FilmLutPass` is wired at the CORRECT position — between
/// `color_grade` and `grain` — with correct ping-pong buffer threading inside
/// the real ~21-pass chain, not just in isolation (the direct parity gate in
/// `film_lut/tests.rs`) or in presence-only form (the `live_chain::
/// tests_gating` gating test). Both neighbors are deliberately engaged
/// (non-identity `color_grade` feeding IN, non-zero `grain_amount` reading
/// OUT) so a pass ordering bug — film running before color_grade, or after
/// grain — could not accidentally cancel out and produce a false green: a
/// swap would feed film_look a different upstream buffer than the CPU oracle
/// used, and would hand grain a buffer the CPU oracle's grain never saw.
pub(super) fn film_case() -> Case {
    let model = AdjustmentModel {
        temperature: 6000.0,
        tint: 3.0,
        exposure: 0.1,
        contrast: 8.0,
        vibrance: 6.0,
        saturation: 5.0,
        // Non-identity color_grade (the pass immediately BEFORE film_look) —
        // engaged on every wheel's saturation AND luminance so
        // `color_grade_is_identity` reads false and the pass genuinely runs.
        split_tone_shadow_hue: 30.0,
        split_tone_shadow_saturation: 20.0,
        split_tone_highlight_hue: 210.0,
        split_tone_highlight_saturation: 15.0,
        split_tone_balance: 10.0,
        color_grade_midtone_hue: 150.0,
        color_grade_midtone_saturation: 25.0,
        color_grade_midtone_luminance: 12.0,
        // Non-zero grain (the pass immediately AFTER film_look) — engaged so
        // it genuinely reads film_look's output, not a bypassed buffer.
        grain_amount: 20.0,
        grain_size: 40.0,
        grain_roughness: 60.0,
        auto_exposure: AutoExposureMode::Off,
        ..AdjustmentModel::default()
    };
    Case {
        model,
        capture: None,
        curve: nonidentity_curve(),
        lut: nonidentity_lut(9),
        wb_method: WbMethod::Cat16,
        // A real, non-identity 9^3 film LUT at an interior strength (63) —
        // interior so both the "keep some original" and "take some film"
        // legs of the blend are exercised, not just the strength-100
        // substitution.
        film_lut: Some(random_film_lut(9, 0x0268_3F17)),
        film_strength: 63.0,
    }
}
