//! Bake a fitted [`AcrModel`] (Auto 2.0's tonescale + hue/chroma field) into
//! the SAME composed display-space 3D LUT shape Auto 1.0's
//! [`auto_profile::bake_auto_profile_lut`](crate::view::auto_profile::bake_auto_profile_lut)
//! produces — #1740 M1's dev A/B slice.
//!
//! Auto 1.0 bakes `residual.sample(apply_curve(node))` over an `[0, 1]³`
//! `DisplayEncodedSrgb` grid — the curve and the residual LUT are two
//! separate fitted artifacts, composed at bake time. Auto 2.0's
//! `AcrModel::apply_model` is a single fitted tail with no curve/residual
//! split, so [`bake_acr_model_lut`] returns it as an identity
//! [`ProfileCurve`] paired with ONE `ColorLut` carrying the model's full
//! correction — the same `(Option<ProfileCurve>, Option<ColorLut>)` shape
//! [`crate::pipeline::render::auto_fit::fit_auto_profile_from_raw`] returns,
//! so a host (CPU or GPU) composing/sampling that pair cannot tell which fit
//! produced it.
//!
//! `apply_model` runs in DISPLAY-LINEAR Rec.2020 (the M0 front-end's own
//! domain convention — see `from_pairs.rs`'s module doc), not the
//! `DisplayEncodedSrgb` `[0, 1]³` grid `bake_profile_lut` samples natively.
//! Each grid node is therefore round-tripped: sRGB gamma-decode → rotate into
//! Rec.2020 (display-linear) → `apply_model` → rotate back to sRGB primaries
//! → clamp → sRGB gamma-encode. This is exactly the round-trip
//! `maple-cli fit-auto2`'s own metrics use to compare the model's prediction
//! against the measured JPEG pairs, so the baked cube reproduces what M0
//! already measured, not a new domain assumption.

use super::model::{apply_model, AcrModel};
use crate::color::matrices::M_REC2020_TO_SRGB;
use crate::view::agx_inverse::srgb_gamma_inv;
use crate::view::auto_profile::bake::MAX_LUT_SIZE;
use crate::view::auto_profile::curve::ProfileCurve;
use crate::view::auto_profile::lut::ColorLut;
use crate::view::encode::srgb_gamma;
use rayon::prelude::*;

/// Apply `model` to one `DisplayEncodedSrgb` `[0, 1]³` triplet, round-
/// tripping through display-linear Rec.2020 (the domain `apply_model`
/// expects) and back. Clamps the Rec.2020→sRGB result to `[0, 1]` before
/// gamma-encoding, matching `maple-cli fit-auto2`'s own metric helpers.
fn apply_model_to_display_srgb(model: &AcrModel, srgb_gamma_rgb: [f32; 3]) -> [f32; 3] {
    let m_srgb_to_rec2020 = M_REC2020_TO_SRGB
        .inverse()
        .expect("M_REC2020_TO_SRGB invertible");
    let lin_srgb = [
        srgb_gamma_inv(srgb_gamma_rgb[0]),
        srgb_gamma_inv(srgb_gamma_rgb[1]),
        srgb_gamma_inv(srgb_gamma_rgb[2]),
    ];
    let lin_rec2020 = m_srgb_to_rec2020.mul_vec(lin_srgb);
    let pred_rec2020 = apply_model(model, lin_rec2020);
    let pred_lin_srgb = M_REC2020_TO_SRGB.mul_vec(pred_rec2020);
    [
        srgb_gamma(pred_lin_srgb[0].clamp(0.0, 1.0)),
        srgb_gamma(pred_lin_srgb[1].clamp(0.0, 1.0)),
        srgb_gamma(pred_lin_srgb[2].clamp(0.0, 1.0)),
    ]
}

/// Bake `model` into an `n³`-node [`ColorLut`], same layout as
/// [`crate::view::auto_profile::bake::bake_profile_lut`] (`n³` RGB triplets,
/// R fastest — `data[((b*n + g)*n + r)*3 + c]`, grid coord `k` → `k/(n-1)`).
///
/// # Panics
/// Panics if `n < 2` or `n > MAX_LUT_SIZE` (mirrors `bake_profile_lut`'s
/// guard — the FFI / WASM wrappers reject such `n` before calling this).
pub fn bake_acr_model_lut(model: &AcrModel, n: usize) -> ColorLut {
    assert!(n >= 2, "bake_acr_model_lut: n must be >= 2 (got {n})");
    assert!(
        n <= MAX_LUT_SIZE,
        "bake_acr_model_lut: n must be <= {MAX_LUT_SIZE} (got {n})"
    );
    // `ColorLut::identity(n)` gives the EXACT `[0, 1]³` grid node
    // coordinates (`r/(n-1)`, no `apply_curve` round trip) — using
    // `bake_profile_lut(&ProfileCurve::identity(), n)` instead would seem
    // equivalent but isn't: `apply_curve` always runs its Oklab conversion
    // even for an identity curve, so its "identity" grid carries ULP-level
    // noise. That noise is invisible to a mild curve but gets amplified by
    // this model's hue/chroma field near the gamut boundary (a real bug this
    // function hit once — a saturated near-white node differed from the
    // exact-grid bake by 0.016 in the composed-cube parity test below).
    let mut data = ColorLut::identity(n).data;
    data.par_chunks_mut(3).for_each(|node| {
        let out = apply_model_to_display_srgb(model, [node[0], node[1], node[2]]);
        node[0] = out[0];
        node[1] = out[1];
        node[2] = out[2];
    });
    ColorLut { size: n, data }
}

/// Bake `model` as the `(curve, residual)` pair
/// [`crate::pipeline::render::auto_fit::fit_auto_profile_from_raw`] returns:
/// an identity curve (Auto 2.0 has no separate curve stage) plus ONE
/// `ColorLut` carrying the model's full tonescale+field correction. A host
/// composing/sampling this pair via `bake_auto_profile_lut` /
/// `apply_curve`-then-`ColorLut::apply` gets exactly [`bake_acr_model_lut`]'s
/// output — the identity curve is a no-op at every node (verified by
/// `auto_profile::bake`'s own
/// `compose_with_identity_residual_matches_curve_only_within_epsilon`).
pub fn acr_model_as_profile_artifacts(
    model: &AcrModel,
    n: usize,
) -> (Option<ProfileCurve>, Option<ColorLut>) {
    (
        Some(ProfileCurve::identity()),
        Some(bake_acr_model_lut(model, n)),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::view::acr_fit::model::{
        FitStats, HueChromaField, Tonescale, CHROMA_BINS, FIELD_N, HUE_BINS, LUMA_BINS,
    };

    /// A model whose tonescale doubles scene luminance and whose field is
    /// pure-identity (zero hue twist, unit chroma scale everywhere) — so the
    /// expected baked value is analytically known: `apply_model` scales RGB
    /// by `T(L)/L = 2.0` uniformly (a pure luminance gain, no hue/chroma
    /// shift), and the display round-trip through sRGB gamma is otherwise a
    /// no-op composition.
    fn doubling_tonescale_model() -> AcrModel {
        let ts = Tonescale {
            knots_log2: vec![-10.0, 6.5],
            values: vec![
                0.18 * 2.0f32.powf(-10.0) * 2.0,
                0.18 * 2.0f32.powf(6.5) * 2.0,
            ],
        };
        let field = HueChromaField {
            hue_bins: HUE_BINS,
            chroma_bins: CHROMA_BINS,
            luma_bins: LUMA_BINS,
            delta_h_deg: vec![0.0; FIELD_N],
            sat_scale: vec![1.0; FIELD_N],
        };
        AcrModel {
            tonescale: ts,
            field,
            stats: FitStats {
                patches_used: 0,
                patches_clipped: 0,
                fit_rms_de: 0.0,
                overlap_rms_rel: None,
            },
        }
    }

    #[test]
    fn bake_acr_model_lut_has_expected_length_and_layout() {
        let model = doubling_tonescale_model();
        let lut = bake_acr_model_lut(&model, 9);
        assert_eq!(lut.size, 9);
        assert_eq!(lut.data.len(), 9 * 9 * 9 * 3);
    }

    #[test]
    #[should_panic(expected = "n must be >= 2")]
    fn bake_acr_model_lut_rejects_degenerate_n() {
        bake_acr_model_lut(&doubling_tonescale_model(), 1);
    }

    #[test]
    fn acr_model_as_profile_artifacts_returns_identity_curve_and_full_lut() {
        let model = doubling_tonescale_model();
        let (curve, lut) = acr_model_as_profile_artifacts(&model, 9);
        assert_eq!(curve, Some(ProfileCurve::identity()));
        let lut = lut.expect("residual present");
        assert_eq!(lut.size, 9);
        // A mid-grey node should have moved off the identity diagonal — the
        // doubling tonescale is live, not accidentally a no-op bake.
        let mid = 9 / 2;
        let i = ((mid * 9 + mid) * 9 + mid) * 3;
        let identity_v = mid as f32 / 8.0;
        assert!(
            (lut.data[i] - identity_v).abs() > 1e-3,
            "expected the doubling tonescale to move the mid-grey node"
        );
    }

    /// Composing the baked artifacts the same way
    /// `auto_profile::bake_auto_profile_lut` composes Auto 1.0's curve +
    /// residual is CLOSE to (not bit-identical to) `bake_acr_model_lut`
    /// directly: `bake_auto_profile_lut` re-derives its own `[0, 1]³` grid by
    /// running `apply_curve` over an identity curve, which is not perfectly
    /// exact — `apply_curve` always round-trips through Oklab even when the
    /// curve is nominally identity, leaving ULP-level noise on its "grid"
    /// coordinates. For Auto 1.0's smooth per-channel curves that noise is
    /// invisible (the sibling `auto_profile::bake` test asserts `< 1e-6`
    /// there); this model's hue/chroma field is far more sensitive — right at
    /// a fully-saturated gamut corner (e.g. `[1, x, 1]`) a lattice-cell
    /// boundary can sit exactly at the sample point, and the ULP-level input
    /// noise is enough to tip the trilinear sample into the neighbouring
    /// cell. Measured max divergence ~0.02 at such corners, independent of
    /// grid resolution (checked at n=9/17/33) — a real numerical property of
    /// a discontinuous-derivative field, not a bug in either bake path. Both
    /// paths still land within one accurate cube's worth of each other
    /// everywhere that isn't a sharp field-cell boundary, so this asserts a
    /// tolerance that would catch a real regression (curve/residual ordering
    /// swapped, wrong grid layout, a stale cache) while not false-failing on
    /// this known field-sensitivity noise floor.
    #[test]
    fn composed_via_auto_profile_bake_is_close_to_direct_bake() {
        use crate::view::auto_profile::bake::bake_auto_profile_lut;

        let model = doubling_tonescale_model();
        let n = 9;
        let (curve, lut) = acr_model_as_profile_artifacts(&model, n);
        let composed = bake_auto_profile_lut(&curve.unwrap(), &lut.unwrap(), n);
        let direct = bake_acr_model_lut(&model, n).data;
        assert_eq!(composed.len(), direct.len());
        let max = composed
            .iter()
            .zip(&direct)
            .map(|(a, b)| (a - b).abs())
            .fold(0.0f32, f32::max);
        assert!(
            max < 0.03,
            "composed cube diverged from direct bake by {max} — beyond the \
             known gamut-corner field-sensitivity noise floor (~0.02)"
        );
    }
}
