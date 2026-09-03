//! Tests for [`super`] — the neutral sampler (#2434). The end-to-end cases
//! decode a synthetic DNG that carries a real dual-illuminant calibration
//! (`SyntheticGreyDng::with_hasselblad_dcp`), so the sample goes through the
//! same decode → probe → slider-frame path a real RAW does.

use super::*;
use crate::color::dcp;
use crate::test_support::synth_dng::SyntheticGreyDng;

fn grey_raw(linear_value: f32) -> RawImage {
    let dng = SyntheticGreyDng {
        linear_value,
        ..SyntheticGreyDng::default()
    }
    .with_hasselblad_dcp();
    crate::decode::decode_bytes(&dng.write_to_bytes(), "dng").expect("decode synthetic dng")
}

/// A neutral surface under the camera's own light samples to the camera's
/// own reading — the sampler and the as-shot estimate agree on what
/// "neutral" means, so a fresh As Shot image sampled anywhere stays put.
#[test]
fn neutral_field_samples_to_the_camera_reading_anywhere_in_the_frame() {
    let raw = grey_raw(0.18);
    let want = dcp::estimate_as_shot_cct_tint(&raw).unwrap();
    for (nx, ny) in [(0.5, 0.5), (0.0, 0.0), (1.0, 1.0), (0.13, 0.87)] {
        let s = sample_white_balance(&raw, &AdjustmentModel::default(), nx, ny).unwrap();
        assert!(
            (s.temperature - want.0).abs() < 10.0 && (s.tint - want.1).abs() < 0.5,
            "({nx}, {ny}): sampled {s:?}, camera reads {want:?}"
        );
        assert_eq!(s.algorithm_version, WB_ALGORITHM_VERSION);
    }
}

/// Same decoded pixels, same pipeline version → the same pair, bit for bit
/// (the ticket's "stable for the same decoded pixels" acceptance).
#[test]
fn sampling_is_deterministic() {
    let raw = grey_raw(0.18);
    let a = sample_white_balance(&raw, &AdjustmentModel::default(), 0.4, 0.6).unwrap();
    let b = sample_white_balance(&raw, &AdjustmentModel::default(), 0.4, 0.6).unwrap();
    assert_eq!(a, b);
}

#[test]
fn a_point_outside_the_image_is_rejected() {
    let raw = grey_raw(0.18);
    for (nx, ny) in [(-0.01, 0.5), (1.01, 0.5), (0.5, -0.2), (0.5, 1.5)] {
        assert_eq!(
            sample_white_balance(&raw, &AdjustmentModel::default(), nx, ny),
            Err(WbSampleError::OutsideImage),
            "({nx}, {ny})"
        );
    }
}

/// A surface at the sensor ceiling has the clip's hue, not the light's —
/// the sampler says so instead of committing a magenta white balance.
#[test]
fn a_clipped_surface_is_rejected() {
    let raw = grey_raw(1.0);
    assert_eq!(
        sample_white_balance(&raw, &AdjustmentModel::default(), 0.5, 0.5),
        Err(WbSampleError::Clipped)
    );
}

#[test]
fn a_crushed_surface_is_rejected() {
    let raw = grey_raw(0.0005);
    assert_eq!(
        sample_white_balance(&raw, &AdjustmentModel::default(), 0.5, 0.5),
        Err(WbSampleError::TooDark)
    );
}

/// The judgement on a hand-built probe: a strongly coloured surface whose
/// solve leaves the slider domain is reported, not clamped into it.
#[test]
fn an_implausible_neutral_is_out_of_domain() {
    let raw = grey_raw(0.18);
    let probe_model = crate::stages::auto_adjustments::probe_model(&AdjustmentModel::default());
    let space = ProbeSpace::resolve(&raw, &probe_model);
    let mut probe = Image::new(16, 16, ColorSpace::SceneLinearRec2020);
    for px in &mut probe.pixels {
        *px = [0.02, 0.3, 0.05]; // deep green: no light on the locus renders this neutral
    }
    assert_eq!(
        sample_from_probe(&probe, &space, 0.5, 0.5),
        Err(WbSampleError::OutOfDomain)
    );
}

/// The window is clipped to the image at the corners rather than indexing
/// past the raster, and still averages what is there.
#[test]
fn the_neighbourhood_clips_to_the_frame() {
    let mut probe = Image::new(4, 4, ColorSpace::SceneLinearRec2020);
    for (i, px) in probe.pixels.iter_mut().enumerate() {
        let v = 0.1 + 0.01 * i as f32;
        *px = [v, v, v];
    }
    let corner = neighbourhood_mean(&probe, 0.0, 0.0).unwrap();
    let centre = neighbourhood_mean(&probe, 0.5, 0.5).unwrap();
    assert!(
        corner[1] < centre[1],
        "corner {corner:?} vs centre {centre:?}"
    );
    assert_eq!(
        neighbourhood_mean(&Image::new(0, 0, ColorSpace::SceneLinearRec2020), 0.5, 0.5),
        None
    );
}
