//! Shared Oklab gamut compression — bisect chroma at constant lightness
//! until a triple fits inside the `[0, 1]^3` display box, while keeping
//! hue invariant by construction.
//!
//! This is the algorithm shape used by:
//!
//! * **AgX post-outset compression** (#435 / `view/agx_hue_restoration.rs`):
//!   working space is **Rec.2020**, so callers pass
//!   `rec2020_to_oklab` / `oklab_to_rec2020`. (#435 currently inlines its
//!   own copy of the bisection; it can rebase onto
//!   [`compress_to_unit_cube_oklab`] for free with no algorithm drift.)
//! * **Rec.2020 → sRGB encode** (#438 / `view/encode.rs`): the matrix
//!   leaves the working triple in **linear sRGB**, so the encode path
//!   passes `srgb_linear_to_oklab` / `oklab_to_srgb_linear`. The bisection
//!   loop and unit-box test are identical; only the two transform
//!   functions differ.
//!
//! Keeping the loop in one place is the contract: future tunings (bisection
//! count, epsilon, in-gamut fast-path) apply to every site at once.

/// Hue-preserving compression toward the `[0, 1]^3` unit cube via Oklab
/// `(a, b)` bisection at constant `L`.
///
/// * `rgb` is the input triple in **whatever working space `to_oklab` /
///   `from_oklab` operate in** (Rec.2020 for the AgX caller, sRGB-linear
///   for the encode caller). The unit-box test is performed in the same
///   working space — out-of-gamut means out-of-`[0, 1]^3` in that space.
/// * `to_oklab` and `from_oklab` are the working-space ↔ Oklab transform
///   pair. They MUST be true round-trip inverses on the neutral axis
///   (`R = G = B in → R = G = B out` within ~1e-5), otherwise the
///   in-gamut fast-path would still drift the byte value.
///
/// Returns:
/// * If `rgb` is in-gamut (with a small fp-edge epsilon), `rgb` is
///   returned **unmodified** — byte-identical to the pre-compression
///   path. The caller's `clamp(0, 1)` on the way to gamma encode handles
///   any 1-ULP wobble.
/// * Otherwise, bisects the `(a, b)` chroma scale in 24 iterations
///   (~6e-8 precision on the scale, well below 8-bit quantisation) and
///   returns the compressed triple clamped to `[0, 1]`. Hue is preserved
///   by construction (uniform `a, b` scaling at constant `L`).
#[inline]
pub fn compress_to_unit_cube_oklab<F, G>(
    rgb: [f32; 3],
    to_oklab: F,
    from_oklab: G,
) -> [f32; 3]
where
    F: Fn([f32; 3]) -> [f32; 3],
    G: Fn([f32; 3]) -> [f32; 3],
{
    if in_unit_box(rgb) {
        // Byte-identity branch: the post-matrix triple already fits, so
        // we return it untouched. The downstream caller (sRGB gamma
        // encode, or `agx_pixel`'s post-outset clamp) handles any ULP
        // wobble — we deliberately do NOT clamp here so that an already-
        // in-`[0, 1]` triple is passed through bit-for-bit.
        return rgb;
    }
    let lab = to_oklab(rgb);
    let l = lab[0];
    let a = lab[1];
    let b = lab[2];
    // Binary search for the largest scale s in [0, 1] such that
    // `from_oklab([l, s*a, s*b])` is in-gamut. 24 iterations.
    let mut lo: f32 = 0.0;
    let mut hi: f32 = 1.0;
    for _ in 0..24 {
        let mid = 0.5 * (lo + hi);
        let candidate = from_oklab([l, a * mid, b * mid]);
        if in_unit_box(candidate) {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    let out = from_oklab([l, a * lo, b * lo]);
    // Tighten with the trailing clamp — Oklab round-trips can drift a
    // few ULPs past 0 or 1 even when the bisection landed inside.
    [
        out[0].clamp(0.0, 1.0),
        out[1].clamp(0.0, 1.0),
        out[2].clamp(0.0, 1.0),
    ]
}

/// In-gamut predicate with a small fp-edge epsilon so values like
/// `1.0 + 1e-7` (fp error on the matrix multiply) don't trigger the
/// expensive compression path.
#[inline]
fn in_unit_box(rgb: [f32; 3]) -> bool {
    const EPS_HI: f32 = 1.0 + 1e-5;
    const EPS_LO: f32 = -1e-5;
    rgb[0] >= EPS_LO
        && rgb[0] <= EPS_HI
        && rgb[1] >= EPS_LO
        && rgb[1] <= EPS_HI
        && rgb[2] >= EPS_LO
        && rgb[2] <= EPS_HI
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::color::oklab::{
        oklab_to_rec2020, oklab_to_srgb_linear, rec2020_to_oklab, srgb_linear_to_oklab,
    };

    #[test]
    fn srgb_in_gamut_passes_through_byte_identical() {
        // The load-bearing invariant: in-gamut input is returned without
        // modification. The encode path relies on this so its only
        // behavioural change is on out-of-gamut input.
        let cases = [
            [0.0f32, 0.0, 0.0],
            [0.18, 0.18, 0.18],
            [0.5, 0.5, 0.5],
            [1.0, 1.0, 1.0],
            [0.9, 0.05, 0.05],
            [0.05, 0.9, 0.05],
            [0.05, 0.05, 0.9],
            [0.3, 0.7, 0.4],
        ];
        for p in cases {
            let out =
                compress_to_unit_cube_oklab(p, srgb_linear_to_oklab, oklab_to_srgb_linear);
            // Bit-identical: in-gamut path must not touch the bytes.
            assert_eq!(out[0].to_bits(), p[0].to_bits(), "R drift on {:?}", p);
            assert_eq!(out[1].to_bits(), p[1].to_bits(), "G drift on {:?}", p);
            assert_eq!(out[2].to_bits(), p[2].to_bits(), "B drift on {:?}", p);
        }
    }

    #[test]
    fn srgb_out_of_gamut_lands_in_unit_box() {
        // Saturated wide-gamut "red" projected post-matrix sits outside
        // [0, 1]^3 (negative G/B). The compressor must land it inside.
        let p = [1.4f32, -0.2, -0.1];
        let out = compress_to_unit_cube_oklab(p, srgb_linear_to_oklab, oklab_to_srgb_linear);
        for (i, c) in out.iter().enumerate() {
            assert!(
                *c >= 0.0 && *c <= 1.0,
                "channel {} out of [0, 1]: {} on input {:?}",
                i,
                c,
                p
            );
        }
    }

    #[test]
    fn srgb_out_of_gamut_preserves_hue_direction() {
        // Saturated red goes in, red dominance must remain (R > G, R > B).
        // Per-channel clipping would force the result toward magenta
        // (G stays at 0, B stays at 0, R clips to 1, hue rotates).
        let p = [1.4f32, -0.05, -0.1];
        let out = compress_to_unit_cube_oklab(p, srgb_linear_to_oklab, oklab_to_srgb_linear);
        assert!(
            out[0] > out[1] && out[0] > out[2],
            "red dominance lost: {:?}",
            out
        );
    }

    #[test]
    fn srgb_hue_angle_drift_under_2_degrees() {
        // The strict hue-preservation gate: convert input + output to
        // Oklab and confirm the (a, b) hue angle drifts < 2°. The
        // bisection scales `(a, b)` uniformly, so the angle should be
        // exact to fp precision — the 2° budget absorbs any sign-flip
        // edge cases from the matrix round-trip.
        let cases = [
            [1.4f32, -0.2, -0.1],   // red-dominant
            [-0.1, 1.3, -0.05],     // green-dominant
            [-0.05, -0.1, 1.5],     // blue-dominant
            [1.2, -0.05, 1.1],      // magenta (R+B)
        ];
        for p in cases {
            let lab_in = srgb_linear_to_oklab(p);
            let out =
                compress_to_unit_cube_oklab(p, srgb_linear_to_oklab, oklab_to_srgb_linear);
            let lab_out = srgb_linear_to_oklab(out);
            let h_in = lab_in[2].atan2(lab_in[1]).to_degrees();
            let h_out = lab_out[2].atan2(lab_out[1]).to_degrees();
            let mut diff = (h_out - h_in).abs();
            if diff > 180.0 {
                diff = 360.0 - diff;
            }
            assert!(
                diff < 2.0,
                "hue drift {}° on input {:?} (in={}°, out={}°)",
                diff,
                p,
                h_in,
                h_out
            );
        }
    }

    #[test]
    fn rec2020_caller_signature_compiles_and_runs() {
        // Smoke-test the other call site shape (Rec.2020 working space).
        // Confirms the API contract supports both AgX (#435 rebase) and
        // encode (#438) without per-call-site adapters.
        let p = [0.18f32, 0.18, 0.18];
        let out = compress_to_unit_cube_oklab(p, rec2020_to_oklab, oklab_to_rec2020);
        // In-gamut passes through.
        assert_eq!(out[0].to_bits(), p[0].to_bits());
    }
}
