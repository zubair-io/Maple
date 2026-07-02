//! Stage 2 of fit-acr: hue/chroma field from sweep patches.
//!
//! For each unclipped sweep patch:
//!   1. Apply the fitted tonescale to predict display-linear RGB.
//!   2. Convert both prediction and measurement to Oklab LCh.
//!   3. Compute Δh (hue twist in degrees) and s = C_measured / C_predicted.
//!
//! Residuals are scattered onto a [HUE_BINS × CHROMA_BINS × LUMA_BINS]
//! lattice by weighted-average (weight = 1 / distance² to nearest bin centre
//! — here simplified to nearest-bin assignment with a final 2-pass
//! neighbour-smoothing sweep for continuity).

use super::model::{HueChromaField, Tonescale, CHROMA_BINS, FIELD_N, HUE_BINS, LUMA_BINS};
use crate::color::oklab::{oklab_to_srgb_linear, rec2020_to_oklab};

/// A sweep-patch observation for the field fit.
pub struct SweepSample {
    /// Scene-linear Rec.2020 RGB (from spec).
    pub scene_rec2020: [f32; 3],
    /// Display-linear sRGB (decoded from the 8-bit ACR PNG via srgb_gamma_inv).
    pub display_srgb: [f32; 3],
}

/// Fit the hue/chroma residual field from unclipped sweep samples.
///
/// Returns `(field, patches_used, patches_clipped)`.
pub fn fit_field(
    samples: &[SweepSample],
    ts: &Tonescale,
) -> (HueChromaField, usize, usize) {
    use crate::color::matrices::M_REC2020_TO_SRGB;
    let m_srgb_to_rec2020 = M_REC2020_TO_SRGB
        .inverse()
        .expect("M_REC2020_TO_SRGB invertible");

    let mut dh_sum = vec![0.0f64; FIELD_N];
    let mut ss_sum = vec![0.0f64; FIELD_N];
    let mut counts = vec![0u32; FIELD_N];
    let mut patches_clipped = 0usize;
    let mut patches_used = 0usize;

    for s in samples {
        // Luminance-preserving tonescale prediction.
        let l_scene = 0.2627 * s.scene_rec2020[0]
            + 0.6780 * s.scene_rec2020[1]
            + 0.0593 * s.scene_rec2020[2];
        if l_scene <= 0.0 {
            patches_clipped += 1;
            continue;
        }
        let l_display_pred = super::model::tonescale_apply(ts, l_scene);
        let scale = l_display_pred / l_scene;
        let pred_rec2020 = [
            s.scene_rec2020[0] * scale,
            s.scene_rec2020[1] * scale,
            s.scene_rec2020[2] * scale,
        ];

        // Convert prediction to Oklab LCh.
        let lab_pred = rec2020_to_oklab(pred_rec2020);
        let c_pred = (lab_pred[1] * lab_pred[1] + lab_pred[2] * lab_pred[2]).sqrt();
        if c_pred < 1e-4 {
            patches_clipped += 1;
            continue; // neutral — no chroma signal
        }
        let h_pred = lab_pred[2].atan2(lab_pred[1]).to_degrees();

        // Measured: display sRGB → Rec.2020 → Oklab.
        let meas_rec2020 = m_srgb_to_rec2020.mul_vec(s.display_srgb);
        let lab_meas = rec2020_to_oklab(meas_rec2020);
        let c_meas = (lab_meas[1] * lab_meas[1] + lab_meas[2] * lab_meas[2]).sqrt();
        let h_meas = if c_meas > 1e-6 {
            lab_meas[2].atan2(lab_meas[1]).to_degrees()
        } else {
            h_pred
        };

        // Residuals.
        let dh = angle_diff_deg(h_meas, h_pred);
        let sat_scale = if c_pred > 1e-6 { c_meas / c_pred } else { 1.0 };

        // Lattice coordinates (nearest-bin).
        let hue_norm = h_pred.rem_euclid(360.0) / 360.0;
        let hi = (hue_norm * HUE_BINS as f32).round() as usize % HUE_BINS;
        let chroma_frac = (c_pred / 0.30).clamp(0.0, 1.0);
        let ci = ((chroma_frac * (CHROMA_BINS - 1) as f32).round() as usize).min(CHROMA_BINS - 1);
        let luma_frac = lab_pred[0].clamp(0.0, 1.0);
        let li = ((luma_frac * (LUMA_BINS - 1) as f32).round() as usize).min(LUMA_BINS - 1);

        let idx = li * CHROMA_BINS * HUE_BINS + ci * HUE_BINS + hi;
        dh_sum[idx] += dh as f64;
        ss_sum[idx] += sat_scale as f64;
        counts[idx] += 1;
        patches_used += 1;
        let _ = (oklab_to_srgb_linear, m_srgb_to_rec2020); // suppress warnings
    }

    // Convert sums to means; fill empty cells with 0 / 1 defaults.
    let mut dh_field = vec![0.0f32; FIELD_N];
    let mut ss_field = vec![1.0f32; FIELD_N];
    for i in 0..FIELD_N {
        if counts[i] > 0 {
            dh_field[i] = (dh_sum[i] / counts[i] as f64) as f32;
            ss_field[i] = (ss_sum[i] / counts[i] as f64) as f32;
        }
    }

    // Two passes of neighbour smoothing.
    smooth_field(&mut dh_field);
    smooth_field(&mut dh_field);
    smooth_field(&mut ss_field);
    smooth_field(&mut ss_field);

    let field = HueChromaField {
        hue_bins: HUE_BINS,
        chroma_bins: CHROMA_BINS,
        luma_bins: LUMA_BINS,
        delta_h_deg: dh_field,
        sat_scale: ss_field,
    };
    (field, patches_used, patches_clipped)
}

/// Angular difference h_meas − h_pred in degrees, wrapped to (−180, +180].
fn angle_diff_deg(meas: f32, pred: f32) -> f32 {
    let d = meas - pred;
    // Wrap to (-180, 180].
    if d > 180.0 { d - 360.0 } else if d <= -180.0 { d + 360.0 } else { d }
}

/// One pass of 6-face neighbour averaging in the [luma][chroma][hue] lattice.
/// Hue wraps circularly; chroma and luma clamp at the borders.
fn smooth_field(data: &mut Vec<f32>) {
    let n = data.len();
    let orig = data.clone();
    for li in 0..LUMA_BINS {
        for ci in 0..CHROMA_BINS {
            for hi in 0..HUE_BINS {
                let idx = li * CHROMA_BINS * HUE_BINS + ci * HUE_BINS + hi;
                let v = orig[idx];
                // 6 neighbours: ±hue (circular), ±chroma (clamp), ±luma (clamp).
                let hi_m = (hi + HUE_BINS - 1) % HUE_BINS;
                let hi_p = (hi + 1) % HUE_BINS;
                let ci_m = ci.saturating_sub(1);
                let ci_p = (ci + 1).min(CHROMA_BINS - 1);
                let li_m = li.saturating_sub(1);
                let li_p = (li + 1).min(LUMA_BINS - 1);
                let nb_hue = (orig[li * CHROMA_BINS * HUE_BINS + ci * HUE_BINS + hi_m]
                    + orig[li * CHROMA_BINS * HUE_BINS + ci * HUE_BINS + hi_p]) / 2.0;
                let nb_chr = (orig[li * CHROMA_BINS * HUE_BINS + ci_m * HUE_BINS + hi]
                    + orig[li * CHROMA_BINS * HUE_BINS + ci_p * HUE_BINS + hi]) / 2.0;
                let nb_lum = (orig[li_m * CHROMA_BINS * HUE_BINS + ci * HUE_BINS + hi]
                    + orig[li_p * CHROMA_BINS * HUE_BINS + ci * HUE_BINS + hi]) / 2.0;
                // Blend: 50% self + 50% average of neighbours.
                data[idx] = 0.5 * v + (nb_hue + nb_chr + nb_lum) / 6.0;
            }
        }
    }
    // Ensure field length invariant.
    debug_assert_eq!(data.len(), n);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn angle_diff_wraps_correctly() {
        assert!((angle_diff_deg(10.0, 350.0) - 20.0).abs() < 0.1, "wrap +");
        assert!((angle_diff_deg(350.0, 10.0) + 20.0).abs() < 0.1, "wrap -");
        assert!((angle_diff_deg(45.0, 15.0) - 30.0).abs() < 0.1, "no wrap");
    }

    #[test]
    fn smooth_field_preserves_length() {
        let mut data = vec![1.0f32; FIELD_N];
        smooth_field(&mut data);
        assert_eq!(data.len(), FIELD_N);
    }

    #[test]
    fn smooth_field_uniform_stays_uniform() {
        let mut data = vec![3.5f32; FIELD_N];
        smooth_field(&mut data);
        for (i, &v) in data.iter().enumerate() {
            assert!((v - 3.5).abs() < 1e-4, "smoothed uniform value changed at {i}");
        }
    }
}
