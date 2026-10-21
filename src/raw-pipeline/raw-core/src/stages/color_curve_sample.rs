//! Stage-input color-curve eyedropper sampler (#5041).
//!
//! Samples the 5×5 neighbourhood entering `stages::color_curves` (Stage 22b:
//! `SceneLinearRec2020` after white balance, exposure, tone controls, tone
//! curves, vibrance, saturation, and 8-band HSL, before clarity/dehaze/AgX/
//! color_grade). Returns the normalized curve domain coordinates `(u_h, u_c, u_l)`
//! so the UI places knots at the exact pre-AgX Oklab hue, chroma, and
//! scene-referred log-EV lightness the stage evaluates.

use crate::color::oklab::rec2020_to_oklab;
use crate::image::{ColorSpace, ExifOrientation, Image, RawImage};
use crate::pipeline::{develop_scene_linear_from_raw_with_quality, RenderQuality};
use crate::stages::color_curves::{oklab_chroma_norm, oklab_hue_norm, scene_log_luma_norm};
pub use crate::stages::mask_range_sample::RangeSampleError as ColorCurveSampleError;
use crate::stages::mask_range_sample::{RangeSampleError, CHROMA_FLOOR, L_FLOOR};
use crate::stages::white_balance_sample::neighbourhood_mean;
use crate::types::adjustment::ToneCurve;
use crate::xmp::AdjustmentModel;

/// Stage-input reading for the Oklab secondary color curves at a sampled point.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ColorCurveSample {
    /// Normalized periodic Oklab hue coordinate $u_H \in [0, 1)$ (`hue_deg / 360`).
    pub u_h: f32,
    /// Normalized Oklab chroma coordinate $u_C = \text{clamp}(C / 0.32, 0, 1)$.
    pub u_c: f32,
    /// Scene-referred log-EV lightness coordinate $u_L \in [0, 1]$.
    pub u_l: f32,
    /// Oklab hue angle in degrees $[0, 360)$.
    pub hue_deg: f32,
    /// Oklab chroma $\sqrt{a^2 + b^2}$.
    pub chroma: f32,
    /// Oklab lightness $L$.
    pub l: f32,
}

/// Sample the colour at normalised image point `(nx, ny)` in `[0, 1]²` as
/// `stages::color_curves` sees it under `model`.
pub fn sample_color_curve_input(
    raw: &RawImage,
    model: &AdjustmentModel,
    nx: f32,
    ny: f32,
) -> Result<ColorCurveSample, RangeSampleError> {
    if !((0.0..=1.0).contains(&nx) && (0.0..=1.0).contains(&ny)) {
        return Err(RangeSampleError::OutsideImage);
    }
    let probe = develop_scene_linear_from_raw_with_quality(
        raw,
        &stage_input_model(model),
        RenderQuality::Preview,
    )
    .map_err(|e| RangeSampleError::Develop(e.to_string()))?;
    sample_from_probe(&probe, nx, ny)
}

/// Map normalised display-oriented coordinates `(x, y)` back to the sensor frame.
pub fn display_point_to_sensor(orientation: ExifOrientation, x: f32, y: f32) -> (f32, f32) {
    match orientation {
        ExifOrientation::Normal => (x, y),
        ExifOrientation::HorizontalFlip => (1.0 - x, y),
        ExifOrientation::Rotate180 => (1.0 - x, 1.0 - y),
        ExifOrientation::VerticalFlip => (x, 1.0 - y),
        ExifOrientation::Transpose => (y, x),
        ExifOrientation::Rotate90 => (y, 1.0 - x),
        ExifOrientation::Transverse => (1.0 - y, 1.0 - x),
        ExifOrientation::Rotate270 => (1.0 - y, x),
    }
}

/// `model` with `color_curves` and every stage downstream of it switched off,
/// so the scene-linear develop ends with the exact buffer entering Stage 22b.
pub(crate) fn stage_input_model(model: &AdjustmentModel) -> AdjustmentModel {
    AdjustmentModel {
        color_curve_hue_vs_hue: ToneCurve::default(),
        color_curve_hue_vs_sat: ToneCurve::default(),
        color_curve_hue_vs_luma: ToneCurve::default(),
        color_curve_luma_vs_sat: ToneCurve::default(),
        color_curve_sat_vs_sat: ToneCurve::default(),
        color_curve_sat_vs_luma: ToneCurve::default(),
        clarity: 0.0,
        texture: 0.0,
        dehaze: 0.0,
        defringe_purple_amount: 0.0,
        defringe_green_amount: 0.0,
        local_adjustments: Vec::new(),
        mask_rasters: Vec::new(),
        vignette_amount: 0.0,
        sharpen_amount: 0.0,
        nr_luminance: 0.0,
        nr_color: 0.0,
        ..model.clone()
    }
}

/// Evaluate the 5×5 neighbourhood mean on an already-developed Stage 22b input probe.
pub(crate) fn sample_from_probe(
    probe: &Image,
    nx: f32,
    ny: f32,
) -> Result<ColorCurveSample, RangeSampleError> {
    if !((0.0..=1.0).contains(&nx) && (0.0..=1.0).contains(&ny)) {
        return Err(RangeSampleError::OutsideImage);
    }
    probe.assert_space(ColorSpace::SceneLinearRec2020);
    let mean = neighbourhood_mean(probe, nx, ny).ok_or(RangeSampleError::OutsideImage)?;
    let lab = rec2020_to_oklab(mean);
    let (l, a, b) = (lab[0], lab[1], lab[2]);
    let chroma = (a * a + b * b).sqrt();
    if !(l.is_finite() && chroma.is_finite()) {
        return Err(RangeSampleError::Develop("non-finite sample".into()));
    }
    if l < L_FLOOR {
        return Err(RangeSampleError::TooDark);
    }
    if chroma < CHROMA_FLOOR {
        return Err(RangeSampleError::Neutral);
    }
    let u_h = oklab_hue_norm(a, b);
    let u_c = oklab_chroma_norm(chroma);
    let u_l = scene_log_luma_norm(mean);
    Ok(ColorCurveSample {
        u_h,
        u_c,
        u_l,
        hue_deg: u_h * 360.0,
        chroma,
        l,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::color::oklab::oklab_to_rec2020;

    #[test]
    fn sample_from_probe_returns_matching_stage_coordinates() {
        let hue_deg = 250.0_f32;
        let rad = hue_deg.to_radians();
        let c = 0.16_f32;
        let px = oklab_to_rec2020([0.60, c * rad.cos(), c * rad.sin()]);
        let mut probe = Image::new(8, 8, ColorSpace::SceneLinearRec2020);
        probe.pixels = vec![px; 64];
        let sample = sample_from_probe(&probe, 0.5, 0.5).expect("coloured sample should succeed");
        assert!((sample.u_h - hue_deg / 360.0).abs() < 1e-4);
        assert!((sample.hue_deg - hue_deg).abs() < 1e-2);
        assert!((sample.u_c - 0.5).abs() < 1e-3);
        assert!(sample.u_l > 0.0 && sample.u_l < 1.0);
    }

    #[test]
    fn sample_from_probe_rejects_neutral_and_outside() {
        let gray = [0.18, 0.18, 0.18];
        let mut probe = Image::new(8, 8, ColorSpace::SceneLinearRec2020);
        probe.pixels = vec![gray; 64];
        assert_eq!(
            sample_from_probe(&probe, 0.5, 0.5),
            Err(RangeSampleError::Neutral)
        );
        assert_eq!(
            sample_from_probe(&probe, -0.1, 0.5),
            Err(RangeSampleError::OutsideImage)
        );
    }

    #[test]
    fn display_point_to_sensor_agrees_with_the_orientation_matrix_for_every_exif_tag() {
        use crate::stages::perspective::Homography;
        for tag in 1..=8 {
            let orientation = ExifOrientation::from_u16(tag);
            let to_sensor = Homography(orientation.display_to_sensor_matrix());
            for (x, y) in [(0.1_f32, 0.2_f32), (0.75, 0.3), (0.5, 0.9), (0.0, 1.0)] {
                let (sx, sy) = to_sensor.project(x * 2.0 - 1.0, y * 2.0 - 1.0).unwrap();
                let expected = ((sx + 1.0) * 0.5, (sy + 1.0) * 0.5);
                let actual = display_point_to_sensor(orientation, x, y);
                assert!(
                    (actual.0 - expected.0).abs() < 1e-5 && (actual.1 - expected.1).abs() < 1e-5,
                    "EXIF {tag}: {actual:?} != {expected:?}"
                );
            }
        }
    }
}
