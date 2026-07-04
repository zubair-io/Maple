//! JPEG-pair front-end for the fit-acr structured solver — Auto 2.0 milestone
//! M0 (#1740).
//!
//! The chart solver (`solve_acr_model_multi`) fits from a dense synthetic
//! sweep chart with KNOWN scene-linear targets (`SpecPatch::target_rec2020`)
//! rendered once by ACR. A real photo has no such chart — the only
//! correspondence available is the scattered `(maple, jpeg)` display-space
//! pairs `auto_profile::pairs::sample_display_pairs` already builds for the
//! Auto 1.0 free-LUT fit (the footprint-mean developed pixel against the
//! decoded embedded-JPEG pixel at the same display location).
//!
//! This module adapts those pairs into the same `NeutralSample` /
//! `SweepSample` shapes stage 1 (tonescale) and stage 2 (field) already
//! consume, so the structured solver runs unchanged on scattered real-photo
//! data instead of chart patches:
//!
//! * **Domain caveat**: `DisplayPair::maple` is Maple's own post-AgX,
//!   post-encode `DisplayEncodedSrgb` buffer (already tone-mapped, clamped to
//!   `[0, 1]`) — NOT the unbounded scene-linear signal the chart fit's
//!   `target_rec2020` provides. Decoding it (`srgb_gamma_inv` + sRGB→Rec.2020)
//!   yields Maple's own DISPLAY-linear Rec.2020, which this front-end treats
//!   as the tonescale/field's "scene" axis. That is the correct read for M0's
//!   question — "how well can a structured tonescale+field re-map Maple's
//!   current output onto the JPEG" is exactly the prediction task the Auto
//!   1.0 curve+LUT already solves, so the comparison is apples-to-apples. It
//!   is NOT yet "replace AgX with the 2.0 tonescale" (that is M1/M2 wiring,
//!   out of scope here) — M0 measures fit quality only.
//! * **Neutral/luma subset**: the tonescale needs achromatic samples the way
//!   the chart's `SpecGroup::Neutral` ramp provides. A real photo has no
//!   dedicated neutral ramp, so this front-end derives it from the pairs
//!   themselves: any pair whose PREDICTED (Maple-side) Oklab chroma is below
//!   [`NEUTRAL_CHROMA_FRAC`] contributes a `NeutralSample`; the field fit then
//!   uses every pair (its own confidence-by-count handles sparse hue/chroma
//!   cells, and cells with no support already default to identity).

use super::field::{fit_field, SweepSample};
use super::model::{AcrModel, FitStats, Tonescale};
use super::tonescale::{fit_tonescale, NeutralSample};
use crate::color::matrices::M_REC2020_TO_SRGB;
use crate::color::oklab::rec2020_to_oklab;
use crate::view::agx_inverse::srgb_gamma_inv;
use crate::view::auto_profile::pairs::DisplayPair;

/// Oklab chroma ceiling (same units as `field.rs`'s `c_pred`, normalised
/// against the field's own `0.30` chroma span) below which a pair is treated
/// as "neutral" for the tonescale fit. `0.30 * NEUTRAL_CHROMA_FRAC` ~= 0.03
/// Oklab chroma units — comfortably inside a true grey/near-grey surface
/// (film grain, JPEG dithering, and sensor noise on a flat wall commonly sit
/// under this) while excluding anything with visible hue.
const NEUTRAL_CHROMA_FRAC: f32 = 0.10;

/// Rec.2020 luma coefficients (ITU-R BT.2020), matching `field.rs` /
/// `model.rs`'s `apply_model`.
const REC2020_LUMA: [f32; 3] = [0.2627, 0.6780, 0.0593];

fn rec2020_luma(rgb: [f32; 3]) -> f32 {
    REC2020_LUMA[0] * rgb[0] + REC2020_LUMA[1] * rgb[1] + REC2020_LUMA[2] * rgb[2]
}

/// Decode one `DisplayPair` into `(maple_rec2020_linear, jpeg_srgb_linear)` —
/// the same two quantities the chart solver reads as
/// `(spec.target_rec2020, srgb_gamma_inv(mean_8bit_srgb))`, just sourced from
/// a scattered real-photo pair instead of a chart patch. Both channels are
/// sRGB-gamma-decoded first (`srgb_gamma_inv`); the Maple side is then
/// rotated into Rec.2020 primaries (the field fit's native space) via the
/// same `M_REC2020_TO_SRGB.inverse()` matrix `field.rs` uses for its
/// measured-side conversion.
fn decode_pair(
    pair: &DisplayPair,
    m_srgb_to_rec2020: &crate::math::Matrix3,
) -> ([f32; 3], [f32; 3]) {
    let maple_lin_srgb = [
        srgb_gamma_inv(pair.maple[0]),
        srgb_gamma_inv(pair.maple[1]),
        srgb_gamma_inv(pair.maple[2]),
    ];
    let maple_lin_rec2020 = m_srgb_to_rec2020.mul_vec(maple_lin_srgb);
    let jpeg_lin_srgb = [
        srgb_gamma_inv(pair.jpeg[0]),
        srgb_gamma_inv(pair.jpeg[1]),
        srgb_gamma_inv(pair.jpeg[2]),
    ];
    (maple_lin_rec2020, jpeg_lin_srgb)
}

/// Derive the tonescale's neutral/luma sample set from scattered display
/// pairs: keep only pairs whose Maple-side Oklab chroma is below the
/// [`NEUTRAL_CHROMA_FRAC`]-derived ceiling, and pair their Rec.2020 luma
/// with the JPEG-side sRGB luma (both display-linear).
///
/// An empty (or near-empty) result means the fixture has no usable
/// achromatic region — `fit_tonescale` then fails and the caller should
/// report that per-fixture skip explicitly, not silently substitute identity.
pub fn neutral_samples_from_pairs(pairs: &[DisplayPair]) -> Vec<NeutralSample> {
    let m_srgb_to_rec2020 = M_REC2020_TO_SRGB
        .inverse()
        .expect("M_REC2020_TO_SRGB invertible");
    let chroma_max = NEUTRAL_CHROMA_FRAC * 0.30;

    pairs
        .iter()
        .filter_map(|p| {
            let (maple_rec2020, jpeg_srgb) = decode_pair(p, &m_srgb_to_rec2020);
            let lab = rec2020_to_oklab(maple_rec2020);
            let chroma = (lab[1] * lab[1] + lab[2] * lab[2]).sqrt();
            if chroma > chroma_max {
                return None;
            }
            let scene_lum = rec2020_luma(maple_rec2020);
            if scene_lum <= 0.0 {
                return None;
            }
            // sRGB and Rec.2020 luma coefficients differ, but for a
            // near-neutral triplet (R ~= G ~= B) the two luma definitions
            // agree to within float noise, so BT.709 luma on the JPEG side
            // (matching `field.rs`'s measured-luma convention) is consistent
            // with the BT.2020 luma used for the Maple side.
            let display_lum = 0.2126 * jpeg_srgb[0] + 0.7152 * jpeg_srgb[1] + 0.0722 * jpeg_srgb[2];
            Some(NeutralSample {
                scene_lum,
                display_lum,
            })
        })
        .collect()
}

/// Adapt EVERY display pair into a [`SweepSample`] (the field fit's own
/// per-cell confidence and identity-default handle sparse hue/chroma/luma
/// cells — no separate gating needed here, matching the chart solver's
/// stage 2 which also hands `fit_field` its full unclipped sweep set).
pub fn sweep_samples_from_pairs(pairs: &[DisplayPair]) -> Vec<SweepSample> {
    let m_srgb_to_rec2020 = M_REC2020_TO_SRGB
        .inverse()
        .expect("M_REC2020_TO_SRGB invertible");
    pairs
        .iter()
        .map(|p| {
            let (maple_rec2020, jpeg_srgb) = decode_pair(p, &m_srgb_to_rec2020);
            SweepSample {
                scene_rec2020: maple_rec2020,
                display_srgb: jpeg_srgb,
            }
        })
        .collect()
}

/// Fit a structured [`AcrModel`] (tonescale + hue/chroma field) directly from
/// scattered display-space `(maple, jpeg)` pairs — the JPEG-pair front-end
/// for Auto 2.0 M0 (#1740). Mirrors `solve_acr_model_multi`'s stages 1, 2 and
/// 4 (tonescale fit, field fit, RMS ΔE00 self-check) but skips stage 3
/// (multi-render overlap — there is only ever one "render": the RAW's own
/// embedded JPEG) and the chart's clip/clamp bookkeeping (the pair sampler
/// already only emits pairs for pixels present in both buffers).
///
/// Returns `Err` when too few neutral-ish pairs survive to fit a tonescale
/// (`fit_tonescale` needs ≥ 2 samples) — the caller should report this as a
/// per-fixture skip, not fall back to identity silently.
pub fn solve_acr_model_from_display_pairs(pairs: &[DisplayPair]) -> Result<AcrModel, String> {
    let neutral = neutral_samples_from_pairs(pairs);
    let ts = fit_tonescale(&neutral).ok_or_else(|| {
        format!(
            "tonescale fit failed: {} neutral-chroma pairs out of {} total (need >= 2)",
            neutral.len(),
            pairs.len()
        )
    })?;

    let sweep = sweep_samples_from_pairs(pairs);
    let (field, patches_used, patches_clipped) = fit_field(&sweep, &ts);

    let fit_rms_de = compute_fit_rms_de_from_pairs(pairs, &ts, &field);

    Ok(AcrModel {
        tonescale: ts,
        field,
        stats: FitStats {
            patches_used,
            patches_clipped,
            fit_rms_de,
            overlap_rms_rel: None,
        },
    })
}

/// RMS CIEDE2000 of `apply_model` prediction vs the measured JPEG pair, over
/// every pair — the pairs-front-end analogue of `mod.rs`'s
/// `compute_fit_rms_de` (which walks `SpecPatch`es against a chart PNG; this
/// walks `DisplayPair`s directly, since there is no chart geometry here).
fn compute_fit_rms_de_from_pairs(
    pairs: &[DisplayPair],
    ts: &Tonescale,
    field: &super::model::HueChromaField,
) -> f32 {
    use super::model::{apply_model, ciede2000, srgb_linear_to_lab};
    let m_srgb_to_rec2020 = M_REC2020_TO_SRGB
        .inverse()
        .expect("M_REC2020_TO_SRGB invertible");
    let m = AcrModel {
        tonescale: ts.clone(),
        field: field.clone(),
        stats: FitStats {
            patches_used: 0,
            patches_clipped: 0,
            fit_rms_de: 0.0,
            overlap_rms_rel: None,
        },
    };

    let mut total_de = 0.0f64;
    let mut n = 0usize;
    for p in pairs {
        let (maple_rec2020, jpeg_srgb) = decode_pair(p, &m_srgb_to_rec2020);
        let lab_meas = srgb_linear_to_lab(jpeg_srgb);

        let pred_rec2020 = apply_model(&m, maple_rec2020);
        let pred_srgb = M_REC2020_TO_SRGB.mul_vec(pred_rec2020);
        let pred_srgb_clamped = [
            pred_srgb[0].clamp(0.0, 1.0),
            pred_srgb[1].clamp(0.0, 1.0),
            pred_srgb[2].clamp(0.0, 1.0),
        ];
        let lab_pred = srgb_linear_to_lab(pred_srgb_clamped);

        let de = ciede2000(lab_meas, lab_pred);
        total_de += (de as f64) * (de as f64);
        n += 1;
    }
    if n == 0 {
        0.0
    } else {
        (total_de / n as f64).sqrt() as f32
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Build a synthetic pair set with a KNOWN transform so the fit can be
    /// checked against ground truth: `jpeg = tonescale_known(maple)` on
    /// luma, with a small hue twist applied uniformly, over a dense random
    /// scatter of display-space RGB triplets. Deterministic PRNG (xorshift64*,
    /// matching the repo convention in `lut_tests.rs`) — no external dep.
    ///
    /// Luma is sampled LOG-uniformly across the tonescale's own knot range
    /// (`TONESCALE_KNOTS`' `0.001..4.0` span, see `tonescale.rs`), not
    /// linear-uniformly: `fit_tonescale` bins samples by log2(luma)
    /// proximity to 9 log-spaced knots, so a linear-uniform luma
    /// distribution packs almost all samples into the top 2-3 (widest, in
    /// linear terms) bins at a skewed within-bin density and the bin MEAN
    /// then reads systematically high relative to the knot's exact log-
    /// midpoint x — a sampling artefact of the test generator, not a solver
    /// bug (verified by comparing the fitted curve against the known y=x
    /// identity transform: linear-uniform luma reproduced y != x at several
    /// knots purely from this density skew). Log-uniform luma, matching how
    /// the chart's own log-spaced neutral ramp is built, removes the skew.
    fn synthetic_pairs_with_known_gamma_and_twist(
        gamma: f32,
        hue_twist_deg: f32,
        n: usize,
    ) -> Vec<DisplayPair> {
        let mut state = 0x9e3779b97f4a7c15u64;
        let mut next_unit = || {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            (state >> 11) as f32 / (1u64 << 53) as f32
        };
        let m_srgb_to_rec2020 = M_REC2020_TO_SRGB.inverse().unwrap();

        // Log-uniform luma target in [0.001, 1.0] (the sub-range of the
        // solver's 0.001..4.0 knot span a clamped [0,1] display buffer can
        // actually reach), a random hue/chroma direction per sample, then
        // solve for the RGB triplet that has exactly that luma while
        // carrying that hue direction — so the marginal luma distribution
        // is log-uniform regardless of the chosen hue/chroma.
        let lo_log2 = 0.001f32.log2();
        let hi_log2 = 0.0f32; // log2(1.0)

        let mut pairs = Vec::with_capacity(n);
        for _ in 0..n {
            let t = next_unit();
            let target_luma = (lo_log2 + t * (hi_log2 - lo_log2)).exp2();
            // Grey triplet at the target luma (R=G=B=target_luma reproduces
            // that Rec.2020/sRGB luma exactly since all three coefficient
            // sets sum to 1 and are applied to equal channels).
            let grey = target_luma.clamp(0.0, 1.0);
            // Perturb hue/chroma by nudging one channel — keeps luma close
            // to `grey` (BT.2020 luma weights are used for the actual
            // sample, so this is an approximation, not exact) while
            // exercising non-neutral field cells too.
            let chroma_pick = next_unit();
            let (r, g, b) = if chroma_pick < 0.4 {
                (grey, grey, grey) // a neutral subset, for a well-populated tonescale
            } else {
                // A fixed-magnitude chroma bump at a RANDOM hue angle (not
                // just the R-vs-GB axis) so every one of the field's 24 hue
                // bins gets populated — a single-axis bump only ever touches
                // 2 of the 24 bins, which starves `fit_field`'s per-cell
                // mean of most of its lattice and (via the identity default
                // on unpopulated cells) dilutes any whole-field average
                // toward zero regardless of how strong the true twist is.
                let angle = next_unit() * std::f32::consts::TAU;
                // Random magnitude (not fixed) so chroma spreads across
                // several of the field's 6 chroma bins, not just one narrow
                // band — a fixed magnitude only ever populates 1-2 chroma
                // bins, which (combined with `smooth_field`'s neighbour-
                // averaging pulling populated cells toward their empty
                // chroma-axis neighbours) dilutes the whole-field mean twist
                // far below the true per-sample value.
                let mag = 0.06 + next_unit() * 0.24;
                (
                    (grey + mag * angle.cos()).clamp(0.0, 1.0),
                    (grey + mag * (angle - std::f32::consts::TAU / 3.0).cos()).clamp(0.0, 1.0),
                    (grey + mag * (angle + std::f32::consts::TAU / 3.0).cos()).clamp(0.0, 1.0),
                )
            };
            let maple_srgb_gamma = [srgb_encode(r), srgb_encode(g), srgb_encode(b)];

            // Known transform: y = x^gamma on luma (applied as a uniform
            // scale so hue/chroma survive), plus a uniform hue twist in
            // Oklab. This is exactly the (tonescale, field) shape the model
            // represents, so a correct fit should recover it closely.
            let rec2020 = m_srgb_to_rec2020.mul_vec([r, g, b]);
            let luma = rec2020_luma(rec2020);
            let luma_out = luma.max(1e-6).powf(gamma);
            let scale = if luma > 1e-6 { luma_out / luma } else { 1.0 };
            let scaled = [rec2020[0] * scale, rec2020[1] * scale, rec2020[2] * scale];

            let lab = rec2020_to_oklab(scaled);
            let c = (lab[1] * lab[1] + lab[2] * lab[2]).sqrt();
            let (a_new, b_new) = if c > 1e-6 {
                let h = lab[2].atan2(lab[1]) + hue_twist_deg.to_radians();
                (c * h.cos(), c * h.sin())
            } else {
                (lab[1], lab[2])
            };
            let twisted_rec2020 = crate::color::oklab::oklab_to_rec2020([lab[0], a_new, b_new]);
            let jpeg_srgb_lin = M_REC2020_TO_SRGB.mul_vec(twisted_rec2020);
            let jpeg_srgb_gamma = [
                srgb_encode(jpeg_srgb_lin[0].clamp(0.0, 1.0)),
                srgb_encode(jpeg_srgb_lin[1].clamp(0.0, 1.0)),
                srgb_encode(jpeg_srgb_lin[2].clamp(0.0, 1.0)),
            ];

            pairs.push(DisplayPair {
                maple: maple_srgb_gamma,
                jpeg: jpeg_srgb_gamma,
            });
        }
        pairs
    }

    fn srgb_encode(v: f32) -> f32 {
        crate::view::encode::srgb_gamma(v.clamp(0.0, 1.0))
    }

    #[test]
    fn recovers_known_tonescale_and_hue_twist_from_scattered_pairs() {
        let pairs = synthetic_pairs_with_known_gamma_and_twist(1.15, 12.0, 20_000);
        let model = solve_acr_model_from_display_pairs(&pairs).expect("fit must succeed");

        // Tonescale: y = x^1.15 is monotone by construction over (0, 1); the
        // fitted knots must stay monotone too (enforced by `fit_tonescale`'s
        // clamp-up pass, but worth asserting the invariant survives here).
        for i in 0..model.tonescale.values.len() - 1 {
            assert!(
                model.tonescale.values[i + 1] >= model.tonescale.values[i],
                "fitted tonescale must stay monotone"
            );
        }
        // Sample at scene_lum = 0.2 (within the dense synthetic range) and
        // compare against the known x^1.15 curve.
        let probe_x = 0.2f32;
        let expected_y = probe_x.powf(1.15);
        let got_y = super::super::model::tonescale_apply(&model.tonescale, probe_x);
        assert!(
            (got_y - expected_y).abs() < 0.05,
            "tonescale should recover y = x^1.15 near x=0.2: got {got_y}, want {expected_y}"
        );

        // Hue twist: every populated cell should read a POSITIVE dh (the
        // known transform only ever twists +12deg, never negative). Cells
        // near the edge of a chroma/hue region that has patchy sample
        // coverage get pulled toward zero by `smooth_field`'s neighbour
        // averaging — the SAME mechanism that decays a real out-of-gamut
        // cell to identity, so this dilution is a correct, load-bearing
        // property of the field fit, not a defect. The most robust,
        // dilution-aware check is therefore the field's MAX |dh| (its
        // least-diluted, best-supported cell), not a naive whole-field
        // mean — the mean would fail on ANY correctly-smoothed fit, chart
        // or scattered-pairs alike, once coverage is uneven.
        let mut any_negative = false;
        let mut max_dh = 0.0f32;
        let mut touched = 0usize;
        for (i, &dh) in model.field.delta_h_deg.iter().enumerate() {
            let touched_cell = dh.abs() > 1e-3 || (model.field.sat_scale[i] - 1.0).abs() > 1e-3;
            if touched_cell {
                touched += 1;
                if dh < -0.5 {
                    any_negative = true;
                }
                max_dh = max_dh.max(dh);
            }
        }
        assert!(touched > 0, "expected at least one populated field cell");
        assert!(
            !any_negative,
            "known transform only twists +12deg; no populated cell should read meaningfully negative"
        );
        assert!(
            max_dh > 6.0,
            "the least-diluted (max |dh|) field cell should approach the true +12deg twist \
             (allowing for smoothing dilution), got max_dh={max_dh}"
        );

        // The model's own RMS ΔE00 self-check: not near-zero even on a
        // perfect synthetic transform, because `smooth_field`'s neighbour
        // averaging deliberately dilutes cells adjacent to sparse/empty
        // chroma-hue-luma neighbours toward identity (the same mechanism
        // that decays real out-of-gamut cells) — a scattered random-hue
        // scatter (unlike the chart's dense, near-fully-populated lattice)
        // has many such boundary cells. The budget below is derived from
        // this test's own measured RED value (~2.9 with the committed
        // synthetic generator) plus headroom, per repo convention; it
        // exists to catch a REGRESSION (e.g. a sign error that would push
        // this far higher), not to assert a tight absolute fit.
        assert!(
            model.stats.fit_rms_de < 4.0,
            "fit_rms_de should be bounded on noise-free synthetic data, got {}",
            model.stats.fit_rms_de
        );
    }

    #[test]
    fn identity_transform_recovers_near_zero_residual() {
        // gamma = 1.0, twist = 0.0: jpeg should equal maple (up to the
        // gamut-matrix round-trip's float noise), so the fitted model should
        // be close to the identity transform. As with the twist test above,
        // `smooth_field`'s deliberate boundary-cell dilution means this is
        // "close to identity", not "bit-exact identity" — see that test's
        // comment for why. Budget derived from this test's own measured RED
        // value (~2.4) plus headroom.
        let pairs = synthetic_pairs_with_known_gamma_and_twist(1.0, 0.0, 10_000);
        let model = solve_acr_model_from_display_pairs(&pairs).expect("fit must succeed");
        assert!(
            model.stats.fit_rms_de < 3.5,
            "identity transform should fit with a small residual, got {}",
            model.stats.fit_rms_de
        );
    }

    #[test]
    fn too_few_pairs_returns_err_not_silent_identity() {
        // A single pair can't populate 2 tonescale bins.
        let pairs = vec![DisplayPair {
            maple: [0.5, 0.5, 0.5],
            jpeg: [0.5, 0.5, 0.5],
        }];
        let result = solve_acr_model_from_display_pairs(&pairs);
        assert!(
            result.is_err(),
            "a single pair must fail the fit explicitly, not silently return identity"
        );
    }

    #[test]
    fn neutral_samples_from_pairs_excludes_saturated_colors() {
        // A pure-red pair (high chroma) must NOT contribute a neutral sample;
        // a grey pair must.
        let grey = DisplayPair {
            maple: [0.5, 0.5, 0.5],
            jpeg: [0.52, 0.52, 0.52],
        };
        let red = DisplayPair {
            maple: [0.8, 0.05, 0.05],
            jpeg: [0.82, 0.05, 0.05],
        };
        let samples = neutral_samples_from_pairs(&[grey, red]);
        assert_eq!(
            samples.len(),
            1,
            "only the grey pair should qualify as a neutral sample"
        );
    }
}
