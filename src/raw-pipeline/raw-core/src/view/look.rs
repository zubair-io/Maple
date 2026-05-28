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
    /// Legacy "Neutral" — migrated to `Profile::Neutral` on XMP read.
    Neutral,
    /// Legacy "Default" — migrated to `Profile::Auto` on XMP read.
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
/// No-op post-#538 (Auto Profile Phase 1, T7).
///
/// Auto Profile in `view::auto_profile` is now the per-image view-shaping
/// stage; `Profile::Neutral` runs strict AgX. The empirical `Look::Default`
/// LUT no longer shapes pixels. The function and the `Look` enum stay only
/// for XMP back-compat — legacy sidecars that carry `papp:Look="Default"`
/// migrate to `papp:Profile="Auto"` in the XMP parser (#536 T5). The
/// `LUT_R/G/B` constants remain `pub` because out-of-crate consumers
/// (raw-ffi, raw-wasm) still read them to seed GPU 1D-LUT textures on the
/// platform view-transform path.
pub fn apply(_rgb: &mut [f32], _look: Look) {
    // intentionally empty — see view::auto_profile for the new path.
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
    fn apply_is_no_op_for_both_variants() {
        // Post-#538 (T7): Auto Profile (`view::auto_profile`) owns the
        // view transform. `look::apply` is intentionally a no-op for
        // every variant — the function and enum stay only for XMP
        // back-compat (legacy `papp:Look` migrates to `papp:Profile`).
        let original = [0.1_f32, 0.4, 0.7];
        let mut buf = original;
        super::apply(&mut buf, super::Look::Neutral);
        assert_eq!(buf, original);
        super::apply(&mut buf, super::Look::Default);
        assert_eq!(buf, original, "Look::Default no longer shapes pixels post-T7");
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
}
