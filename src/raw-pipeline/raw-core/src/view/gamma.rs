//! Piecewise sRGB gamma OETF/EOTF pair. Per IEC 61966-2-1.
//!
//! Split out of `encode.rs` to keep that file under the 600-LOC hard budget
//! (#2683) — same sibling-module precedent as `encode_gamut_guard.rs` /
//! `encode_p3_tests.rs`, but registered as a first-class `view` module
//! (alongside `dither`) rather than nested under `encode`, since both
//! functions here are genuinely cross-cutting: `encode.rs`'s own quantize
//! chain uses [`srgb_gamma`], and the `film_look` stage
//! (`stages::film_look`) uses both directions to round-trip a `.mlut`
//! lattice sample. `encode.rs` re-exports both names so
//! `view::encode::srgb_gamma` / `view::encode::srgb_degamma` keep resolving
//! for every existing caller.

/// Piecewise sRGB gamma encode (OETF): linear → gamma-encoded, `[0, 1]`.
pub fn srgb_gamma(x: f32) -> f32 {
    let x = x.clamp(0.0, 1.0);
    if x <= 0.003_130_8 {
        x * 12.92
    } else {
        1.055 * x.powf(1.0 / 2.4) - 0.055
    }
}

/// Piecewise sRGB gamma decode (EOTF, inverse of [`srgb_gamma`]). Factored
/// out for the `film_look` stage (#2683), which round-trips a `.mlut`
/// lattice sample (encoded sRGB) back to linear before the Rec.2020 gamut
/// matrix — unlike [`srgb_gamma`], this does not clamp its input (the
/// lattice sample it consumes is already in `[0, 1]` by construction).
/// This is a fresh, public sibling of the private `srgb_to_linear_one`
/// copies in `color/hsm.rs` and `color/dcp.rs`, which stay untouched —
/// their call sites are unrelated to this stage.
pub fn srgb_degamma(x: f32) -> f32 {
    if x <= 0.04045 {
        x / 12.92
    } else {
        ((x + 0.055) / 1.055).powf(2.4)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gamma_zero_maps_to_zero() {
        assert!((srgb_gamma(0.0) - 0.0).abs() < 1e-6);
    }

    #[test]
    fn gamma_one_maps_to_one() {
        assert!((srgb_gamma(1.0) - 1.0).abs() < 1e-3);
    }

    #[test]
    fn gamma_below_threshold_is_linear_times_12_92() {
        let x = 0.001;
        let expected = x * 12.92;
        assert!((srgb_gamma(x) - expected).abs() < 1e-6);
    }

    #[test]
    fn srgb_degamma_is_inverse_of_srgb_gamma() {
        for &x in &[0.0f32, 0.001, 0.003_130_8, 0.05, 0.18, 0.5, 0.8, 1.0] {
            let encoded = srgb_gamma(x);
            let back = srgb_degamma(encoded);
            assert!(
                (back - x).abs() < 1e-5,
                "round-trip {x} -> {encoded} -> {back}"
            );
        }
    }
}
