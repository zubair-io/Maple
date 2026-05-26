//! Empirically-derived DisplayLookCurve (ticket #371).
//!
//! 1D per-channel LUT (256 entries x 3 channels = 768 bytes), derived from
//! per-pixel (canonical_Maple sRGB u8, ACR reference sRGB u8) pairs across
//! 14 training fixtures. Closes ~65% of the bias-to-ACR gap on training
//! (3x MAE reduction), generalizes to held-out fixtures (2x MAE reduction).
//!
//! ## Placement
//!
//! Applied as an f32 transform in sRGB-gamma-encoded space, BETWEEN
//! `encode::srgb_gamma_encode` and `encode::dither_and_quantize`. That
//! domain matches the LUT's empirical derivation
//! (canonical Maple sRGB u8 → ACR sRGB u8) — same primaries, same OETF.
//!
//! ## Why f32 + linear interpolation (#519)
//!
//! Pre-#519 the LUT ran as a `u8 → u8` nearest lookup AFTER the Bayer
//! dither + 8-bit quantise. Wherever the LUT's slope ≠ 1, multiple
//! input codes collapsed to one output code — creating histogram gaps
//! the upstream dither could no longer mask, surfacing as visible
//! banding in shadows and warm gradients.
//!
//! The fix: sample the same 256-entry u8 LUT in f32 space with linear
//! interpolation between adjacent entries, then dither + quantise once
//! at the end of the chain. Smooth gradients stay smooth; the dither
//! controls the final quantisation step exactly as it would without
//! the LUT in the chain.
//!
//! The LUT byte data in `look_lut.rs` is unchanged; only the consumer
//! changed.
//!
//! ## Scope (this PR)
//!
//! Applied on the **display-encoded RGB output paths** — every
//! `srgb_gamma_encode` / `dither_and_quantize` call site in
//! `pipeline/render.rs` plus the decode-then-render path in
//! `maple-cli`. The scene-linear fp16 RGBA FFI paths
//! (`render_scene_linear_*` and `apply_scene_linear_chain`) hand off to
//! Apple CoreImage / Web GPU view transforms that do their own AgX +
//! sRGB encode — porting the Look into those GPU view transforms is a
//! follow-up.
//!
//! ## Look variants
//!
//! - [`Look::Neutral`] — identity (no transform). Strict scene-referred
//!   output. Bit-identical to the pre-#371 canonical AgX + sRGB encode +
//!   quantize_u8 output.
//! - [`Look::Default`] — the empirical LUT. Default for new users.
//!
//! ## Architectural ceiling and follow-up
//!
//! The 1D LUT captures the MEAN shift across fixtures but cannot resolve
//! within-scene per-pixel scatter (spread 125-160 sRGB units at a single
//! input value in some fixtures). That's a 3D-LUT / context-aware /
//! local-tone problem — tracked as follow-up #389.

#[path = "look_lut.rs"]
mod lut;

// Re-export the raw LUT byte arrays so out-of-crate consumers (raw-ffi,
// raw-wasm) can seed a GPU 1D LUT texture without duplicating the data.
// The `lut` module itself stays private — the API surface widens by three
// `pub` constants, not by a public submodule path.
pub use lut::{LUT_B, LUT_G, LUT_R};

/// User-selectable display Look applied as an f32 LUT in sRGB-encoded space.
///
/// See module-level docs for the placement rationale and scope.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Look {
    /// Identity — pure scene-referred output. Bit-identical to the
    /// pre-#371 canonical pipeline (no LUT applied).
    Neutral,
    /// Empirical LUT derived from 14 (Maple, ACR) training fixtures.
    /// Closes ~65% of the bias-to-ACR gap (3x MAE reduction on training,
    /// 2x on held-out). The new-user default.
    Default,
}

impl Default for Look {
    fn default() -> Self {
        Self::Default
    }
}

/// Map the C-ABI / WASM `look_mode: u8` byte (the wire representation hosts
/// pass over FFI) into a `Look`. Stable mapping:
///
/// - `0` → [`Look::Neutral`] (identity, scene-referred)
/// - anything else → [`Look::Default`] (empirical LUT)
///
/// The "anything else" branch is deliberate: hosts that have not yet
/// learned about future variants still get the safe default, and the FFI
/// `maple_compute_look_lut` entry rejects unknown bytes separately so the
/// caller can surface the error.
impl From<u8> for Look {
    fn from(v: u8) -> Self {
        match v {
            0 => Look::Neutral,
            _ => Look::Default,
        }
    }
}

/// Apply the selected Look to a packed f32 RGB buffer in sRGB-encoded space.
///
/// Values must be in `[0, 1]`. Out-of-range values are clamped at index
/// lookup. Linear interpolation between adjacent LUT entries preserves
/// smooth gradients and prevents the histogram gaps that caused the
/// pre-#519 banding bug.
///
/// Buffer layout: row-major, 3 lanes/pixel `[R, G, B, R, G, B, ...]`.
/// `Look::Neutral` short-circuits — no work, no allocations,
/// bit-identical to the input.
pub fn apply(rgb: &mut [f32], look: Look) {
    match look {
        Look::Neutral => {}
        Look::Default => {
            for chunk in rgb.chunks_exact_mut(3) {
                chunk[0] = sample(&lut::LUT_R, chunk[0]);
                chunk[1] = sample(&lut::LUT_G, chunk[1]);
                chunk[2] = sample(&lut::LUT_B, chunk[2]);
            }
        }
    }
}

#[inline(always)]
fn sample(lut: &[u8; 256], v: f32) -> f32 {
    let idx = v.clamp(0.0, 1.0) * 255.0;
    let lo = idx.floor() as usize;
    let hi = (lo + 1).min(255);
    let t = idx - lo as f32;
    let lo_v = lut[lo] as f32 / 255.0;
    let hi_v = lut[hi] as f32 / 255.0;
    lo_v + (hi_v - lo_v) * t
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_look_is_default_variant() {
        assert_eq!(Look::default(), Look::Default);
    }

    #[test]
    fn from_u8_maps_zero_to_neutral() {
        assert_eq!(Look::from(0u8), Look::Neutral);
    }

    #[test]
    fn from_u8_maps_one_to_default() {
        assert_eq!(Look::from(1u8), Look::Default);
    }

    #[test]
    fn from_u8_maps_unknown_to_default() {
        // Hosts ignorant of future variants get the safe default; the FFI
        // entry handles unknown bytes as an explicit error separately.
        assert_eq!(Look::from(2u8), Look::Default);
        assert_eq!(Look::from(99u8), Look::Default);
        assert_eq!(Look::from(255u8), Look::Default);
    }

    #[test]
    fn neutral_is_bit_identical_to_input() {
        let mut buf = vec![0.0f32; 3 * 64];
        for (i, v) in buf.iter_mut().enumerate() {
            *v = ((i % 256) as f32) / 255.0;
        }
        let original = buf.clone();
        apply(&mut buf, Look::Neutral);
        assert_eq!(buf, original, "Neutral must be a bit-identical no-op");
    }

    #[test]
    fn default_lut_changes_buffer_for_non_default_input() {
        // Mid-gray sweep — the LUT is non-identity at most input values.
        let mut buf: Vec<f32> = (0u8..=255)
            .flat_map(|v| {
                let f = v as f32 / 255.0;
                [f, f, f]
            })
            .collect();
        let original = buf.clone();
        apply(&mut buf, Look::Default);
        assert_ne!(
            buf, original,
            "Default LUT must transform a non-trivial buffer"
        );
    }

    #[test]
    fn default_lut_per_channel_independent() {
        // R, G, B at the same input value should map to (potentially)
        // different outputs because each channel has its own LUT.
        let mid = 128.0f32 / 255.0;
        let mut buf = vec![mid, mid, mid];
        apply(&mut buf, Look::Default);
        let r = buf[0];
        let g = buf[1];
        let b = buf[2];
        assert!(
            (r - g).abs() > 1e-6 || (g - b).abs() > 1e-6,
            "Per-channel LUTs collapsed to identical output: ({r}, {g}, {b})"
        );
    }

    #[test]
    fn lut_arrays_are_monotone_nondecreasing() {
        // Empirical sanity: a tone-mapping LUT should be monotone — a
        // brighter input maps to an output at least as bright. If a future
        // re-derivation produces a non-monotone LUT, surface that here
        // before it ships.
        for (name, arr) in [
            ("LUT_R", &lut::LUT_R[..]),
            ("LUT_G", &lut::LUT_G[..]),
            ("LUT_B", &lut::LUT_B[..]),
        ] {
            for i in 1..arr.len() {
                assert!(
                    arr[i] >= arr[i - 1],
                    "{name} non-monotone at index {i}: {} -> {}",
                    arr[i - 1],
                    arr[i],
                );
            }
        }
    }

    #[test]
    fn lut_endpoints_are_plausible() {
        // Sanity guards on the derived LUT — the empirical data should
        // map black->black-ish and white->white-ish (the LUT doesn't
        // invert tone). Loose bounds; the derived ceiling at 255 is 250
        // (R) / 252 (G) / 255 (B). The derived floor at 0 is ~7 / ~7 /
        // ~19 (the empirical lift in deep shadows).
        assert!(lut::LUT_R[0] < 50, "R[0] = {}", lut::LUT_R[0]);
        assert!(lut::LUT_G[0] < 50, "G[0] = {}", lut::LUT_G[0]);
        assert!(lut::LUT_B[0] < 50, "B[0] = {}", lut::LUT_B[0]);
        assert!(lut::LUT_R[255] > 200, "R[255] = {}", lut::LUT_R[255]);
        assert!(lut::LUT_G[255] > 200, "G[255] = {}", lut::LUT_G[255]);
        assert!(lut::LUT_B[255] > 200, "B[255] = {}", lut::LUT_B[255]);
    }

    #[test]
    fn buffer_with_partial_pixel_is_safe() {
        // `chunks_exact_mut(3)` skips any trailing lanes that don't fill a
        // full pixel — the function must not panic on a length-mismatched
        // buffer (defensive: real callers always pass `3 * w * h`).
        let mut buf = vec![10.0f32 / 255.0, 20.0 / 255.0, 30.0 / 255.0, 40.0 / 255.0];
        let stray_original = buf[3];
        apply(&mut buf, Look::Default);
        // Stray lane at index 3 is left untouched.
        assert_eq!(buf[3], stray_original);
    }

    #[test]
    fn sample_at_half_step_averages_neighbors() {
        // Linear LUT: lut[i] = i. Sampling at 100.5/255 should land
        // exactly between lut[100]/255 and lut[101]/255 — i.e. 100.5/255.
        let mut lut = [0u8; 256];
        for (i, slot) in lut.iter_mut().enumerate() {
            *slot = i as u8;
        }
        let v = sample(&lut, 100.5 / 255.0);
        let expected = 100.5 / 255.0;
        assert!(
            (v - expected).abs() < 1e-4,
            "sample at half-step: got {v}, expected {expected}"
        );
    }

    #[test]
    fn default_lut_no_histogram_gaps_on_linear_ramp() {
        // 4096-step linear ramp — finer than 256 so the pre-#519
        // `u8 → u8` LUT would have collapsed runs of inputs into the
        // same output bin, leaving u8 indices empty (visible banding
        // signature). With f32 linear interpolation, the LUT output
        // sweeps continuously through every reachable u8 bin in the
        // interior of its range.
        let ramp: Vec<f32> = (0..4096).map(|i| i as f32 / 4095.0).collect();
        let mut rgb: Vec<f32> = ramp.iter().flat_map(|&v| [v, v, v]).collect();
        apply(&mut rgb, Look::Default);
        let mut hist = [0u32; 256];
        for chunk in rgb.chunks_exact(3) {
            let q = (chunk[0].clamp(0.0, 1.0) * 255.0).round() as u8;
            hist[q as usize] += 1;
        }
        // Interior of the curve's reachable range. The empirical LUT
        // lifts shadows (`LUT_R[0]` ~ 7) and ceils highlights
        // (`LUT_R[255]` ~ 250), so we skip the first few bins and the
        // tail — those are correctly empty by construction.
        for i in 25..240 {
            assert!(
                hist[i] > 0,
                "histogram gap at {i} (banding bug returned) — hist={:?}",
                &hist[i.saturating_sub(2)..(i + 3).min(256)]
            );
        }
    }

    #[test]
    fn default_lut_endpoints_match_table_entries() {
        // The f32 sampler at exactly 0 / 1 must return the LUT's first /
        // last entry verbatim — the linear interpolation should not
        // bias the endpoints.
        let mut buf = vec![0.0f32, 0.0, 0.0];
        apply(&mut buf, Look::Default);
        assert!((buf[0] - lut::LUT_R[0] as f32 / 255.0).abs() < 1e-6);
        assert!((buf[1] - lut::LUT_G[0] as f32 / 255.0).abs() < 1e-6);
        assert!((buf[2] - lut::LUT_B[0] as f32 / 255.0).abs() < 1e-6);

        let mut buf = vec![1.0f32, 1.0, 1.0];
        apply(&mut buf, Look::Default);
        assert!((buf[0] - lut::LUT_R[255] as f32 / 255.0).abs() < 1e-6);
        assert!((buf[1] - lut::LUT_G[255] as f32 / 255.0).abs() < 1e-6);
        assert!((buf[2] - lut::LUT_B[255] as f32 / 255.0).abs() < 1e-6);
    }
}
