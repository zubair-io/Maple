use crate::{
    color::dcp,
    demosaic, linearize,
    error::Result,
    image::RawImage,
    stages::{dehaze, exposure, white_balance},
    view::{agx, encode},
    xmp::AdjustmentModel,
};
use std::path::Path;

/// End-to-end render: decode → demosaic → DCP → WB → exposure → dehaze → AgX
/// → Rec.2020→sRGB → gamma → u8.
///
/// Per spec § 02 filter chain, with the slice-1 subset:
/// * Highlight reconstruction (§ 3.3a) skipped (default off).
/// * SceneToneControls collapses to exposure-only (§ 3.6).
/// * Vibrance/saturation/clarity/texture/sharpening/NR/crop skipped.
/// * DisplayReferredCurve (§ 3.6b) skipped (no fixture flips it on).
/// * AgX is the Sobotka power-curve approximation (slice-6 calibration target).
pub fn render_from_raw(raw: &RawImage, model: &AdjustmentModel) -> Result<(u32, u32, Vec<u8>)> {
    let mosaic = linearize::sensor_linearize(raw);
    let camera_rgb = demosaic::bilinear(&mosaic, raw.cfa);
    let profile = dcp::profile_for(raw)?;
    let mut scene = dcp::apply(&camera_rgb, &profile)?;
    white_balance::apply(&mut scene, model.temperature, model.tint);
    exposure::apply(&mut scene, model.exposure);
    dehaze::apply(&mut scene, model.dehaze);
    agx::apply(&mut scene);
    encode::rec2020_to_srgb(&mut scene);
    let bytes = encode::quantize_u8(&mut scene);
    Ok((scene.width, scene.height, bytes))
}

/// Convenience: decode a RAW from disk and run the full pipeline.
pub fn render(raw_path: &Path, model: &AdjustmentModel) -> Result<(u32, u32, Vec<u8>)> {
    let raw = crate::decode::decode(raw_path)?;
    render_from_raw(&raw, model)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn render_test_0002_baseline_produces_plausible_png_bytes() {
        let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../test-fixtures/raws/test_0002.dng");
        if !path.exists() { return; }
        let model = AdjustmentModel::default();
        let (w, h, bytes) = render(&path, &model).expect("render baseline");
        assert_eq!(bytes.len() as u32, w * h * 3);
        // Image is not all zeros and not all 255.
        let zero_ratio = bytes.iter().filter(|b| **b == 0).count() as f32 / bytes.len() as f32;
        let max_ratio  = bytes.iter().filter(|b| **b == 255).count() as f32 / bytes.len() as f32;
        assert!(zero_ratio < 0.5, "too many zeros ({:.1}%)", zero_ratio * 100.0);
        assert!(max_ratio < 0.5, "too many saturated pixels ({:.1}%)", max_ratio * 100.0);
        eprintln!("render: {}x{}, zero={:.1}%, max={:.1}%, mean={}",
            w, h, zero_ratio*100.0, max_ratio*100.0,
            bytes.iter().map(|&b| b as u64).sum::<u64>() / bytes.len() as u64);
    }

    #[test]
    fn render_test_0002_exposure_max_is_brighter_than_baseline() {
        let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../test-fixtures/raws/test_0002.dng");
        if !path.exists() { return; }
        let model_baseline = AdjustmentModel::default();
        let model_bright = AdjustmentModel { exposure: 4.0, ..Default::default() };
        let (_, _, baseline) = render(&path, &model_baseline).unwrap();
        let (_, _, bright) = render(&path, &model_bright).unwrap();
        let mean_baseline: u64 = baseline.iter().map(|&b| b as u64).sum::<u64>() / baseline.len() as u64;
        let mean_bright: u64 = bright.iter().map(|&b| b as u64).sum::<u64>() / bright.len() as u64;
        assert!(mean_bright > mean_baseline,
            "+4EV ({}) should exceed baseline ({})", mean_bright, mean_baseline);
    }
}
