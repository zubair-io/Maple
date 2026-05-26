//! Empirically-derived DisplayLookCurve (ticket #371).
//!
//! 1D per-channel LUT (256 entries x 3 channels = 768 bytes), derived from
//! per-pixel (canonical_Maple sRGB u8, ACR reference sRGB u8) pairs across
//! 14 training fixtures. Closes ~65% of the bias-to-ACR gap on training
//! (3x MAE reduction), generalizes to held-out fixtures (2x MAE reduction).
//!
//! ## Placement
//!
//! Applied **after** `encode::quantize_u8` as a pure `u8 -> u8` transform,
//! in sRGB-encoded uint8 space. This is the same domain the LUT was
//! empirically derived against (per `~/Desktop/maple-empirical-lut/lut.json`:
//! "Maple canonical sRGB uint8 -> ACR sRGB uint8"). Applying it earlier
//! (e.g. between AgX and the Rec.2020->sRGB matrix) would index with the
//! wrong domain — Rec.2020 primaries differ from sRGB and the gamma
//! encode hasn't run yet.
//!
//! The plan in `docs/spec/03-algorithms.md` § "apply_look" places a future
//! `apply_look` between log-encode and the AgX sigmoid (a `[0, 1]`
//! normalized-log-domain transform). This 1D LUT is a different — and
//! complementary — mechanism: an empirical post-pipeline shaping layer
//! that captures the aggregate scene-to-display delta against ACR.
//!
//! Per-channel: `out[c] = LUT[c][in[c]]`, no interpolation (input is
//! already u8 so the LUT is sampled exactly at integer positions).
//!
//! ## Scope (this PR)
//!
//! Applied on the **display-encoded u8 RGB output paths** — every
//! `quantize_u8` call site in `pipeline/render.rs` plus the
//! decode-then-render path in `maple-cli`. The scene-linear fp16 RGBA FFI
//! paths (`render_scene_linear_*` and `apply_scene_linear_chain`) hand off
//! to Apple CoreImage / Web GPU view transforms that do their own AgX +
//! sRGB encode — applying a u8 LUT in raw-core there is impossible (the
//! buffer is still post-AgX `DisplayLinearRec2020` fp16, not encoded u8).
//! Porting the Look into those GPU view transforms is a follow-up.
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

/// User-selectable display Look applied as a post-encode u8 LUT.
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

/// Apply the selected Look in place over a packed `u8` RGB buffer.
///
/// Buffer layout: row-major, 3 bytes/pixel `[R, G, B, R, G, B, ...]` —
/// the same shape `view::encode::quantize_u8` returns.
///
/// `Look::Neutral` short-circuits — no work, no allocations, bit-identical
/// to the input. `Look::Default` does one indexed `u8 -> u8` lookup per
/// channel; the inner loop is trivially auto-vectorizable.
pub fn apply(rgb: &mut [u8], look: Look) {
    match look {
        Look::Neutral => {}
        Look::Default => {
            for chunk in rgb.chunks_exact_mut(3) {
                chunk[0] = lut::LUT_R[chunk[0] as usize];
                chunk[1] = lut::LUT_G[chunk[1] as usize];
                chunk[2] = lut::LUT_B[chunk[2] as usize];
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_look_is_default_variant() {
        assert_eq!(Look::default(), Look::Default);
    }

    #[test]
    fn neutral_is_bit_identical_to_input() {
        let mut buf = vec![0u8; 3 * 64];
        for (i, b) in buf.iter_mut().enumerate() {
            *b = (i % 256) as u8;
        }
        let original = buf.clone();
        apply(&mut buf, Look::Neutral);
        assert_eq!(buf, original, "Neutral must be a bit-identical no-op");
    }

    #[test]
    fn default_lut_changes_buffer_for_non_default_input() {
        // Pick mid-gray (128) — the LUT is non-identity at most input values.
        let mut buf: Vec<u8> = (0u8..=255).flat_map(|v| [v, v, v]).collect();
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
        let mut buf = vec![128u8, 128, 128];
        apply(&mut buf, Look::Default);
        // The empirical LUTs at 128 are roughly R≈140, G≈145, B≈189 —
        // exact values come from `look_lut.rs`. We only assert that the
        // three channels did not all converge to the same value: that
        // would mean per-channel routing is broken.
        let r = buf[0];
        let g = buf[1];
        let b = buf[2];
        assert!(
            r != g || g != b,
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
        // `chunks_exact_mut(3)` skips any trailing bytes that don't fill a
        // full pixel — the function must not panic on a length-mismatched
        // buffer (defensive: real callers always pass `3 * w * h`).
        let mut buf = vec![10u8, 20, 30, 40]; // 4 bytes — one full RGB + 1 stray
        apply(&mut buf, Look::Default);
        // Stray byte at index 3 is left untouched.
        assert_eq!(buf[3], 40);
    }
}
