use crate::{
    color::dcp,
    demosaic, linearize,
    error::Result,
    image::{apply_orientation, RawImage},
    stages::{
        clarity, dehaze, highlight_recovery, noise_reduction, saturation,
        scene_tone_controls, sharpen, texture, vibrance, white_balance,
    },
    view::{agx, encode},
    xmp::AdjustmentModel,
};

/// Per spec § 02 filter chain, slice-1 through slice-5 subset:
/// * Highlight reconstruction (§ 3.3a), SceneToneControls (§ 3.6 steps 1-5),
///   Vibrance + Saturation (§ 3.7, Oklab), Clarity + Texture (§ 3.8),
///   Dehaze (§ 3.9), Richardson-Lucy sharpen (§ 3.10, 3-iter, Gaussian PSF),
///   simplified NR (§ 3.11, L-blur + chroma-blur in Oklab).
/// * Crop (§ 3.12) skipped — no slice-5 fixture exercises it; lands with
///   canonical XMP in slice 7.
/// * Tone curves (§ 3.6 steps 6-7, § 3.6b DisplayReferredCurve) deferred to slice 7.
/// * AgX is the Sobotka power-curve approximation (slice-6 retightens).
pub fn render_from_raw(raw: &RawImage, model: &AdjustmentModel) -> Result<(u32, u32, Vec<u8>)> {
    let mosaic = linearize::sensor_linearize(raw);
    #[cfg(feature = "high-quality-demosaic")]
    let mut camera_rgb = demosaic::hamilton_adams(&mosaic, raw.cfa);
    #[cfg(not(feature = "high-quality-demosaic"))]
    let mut camera_rgb = demosaic::bilinear(&mosaic, raw.cfa);

    // White-balance pre-gain (DNG § 6.2, "Camera Profile Chromatic Adaptation";
    // and DNG 1.4 § 5.1 pipeline step "AsShotNeutral → balanced camera RGB").
    // Multiply each channel by 1/AsShotNeutral so a neutral scene patch reads
    // (1, 1, 1) in the balanced camera-RGB frame before the ColorMatrix
    // inversion sees it. Every spec-conformant DNG processor does this
    // (Adobe DCP reference, RawTherapee, Darktable, libraw) — leaving it out
    // produces a systematic ~0.4-0.6 EV underexposure that scales with the
    // magnitude of AsShotNeutral's non-unity components.
    let asn = raw.as_shot_neutral;
    let g = [1.0 / asn[0].max(1e-6), 1.0 / asn[1].max(1e-6), 1.0 / asn[2].max(1e-6)];
    for p in &mut camera_rgb.pixels {
        p[0] *= g[0];
        p[1] *= g[1];
        p[2] *= g[2];
    }

    // DNG § C.1.2: BaselineExposure is applied as a gain in a scene-linear
    // color space prior to the color-space transform. Mathematically
    // commutative with the linear CM that follows, so we apply in the
    // camera-native space for clarity — one multiply per channel.
    if raw.baseline_exposure.abs() > 1e-4 {
        let be_gain = raw.baseline_exposure.exp2();
        for p in &mut camera_rgb.pixels {
            p[0] *= be_gain;
            p[1] *= be_gain;
            p[2] *= be_gain;
        }
    }
    highlight_recovery::apply(&mut camera_rgb, model.highlight_recovery);
    let profile = dcp::profile_for(raw)?;
    let mut scene = dcp::apply(&camera_rgb, &profile)?;
    white_balance::apply(&mut scene, model.temperature, model.tint);
    scene_tone_controls::apply(&mut scene, model);
    vibrance::apply(&mut scene, model.vibrance);
    saturation::apply(&mut scene, model.saturation);
    clarity::apply(&mut scene, model.clarity);
    texture::apply(&mut scene, model.texture);
    dehaze::apply(&mut scene, model.dehaze);
    sharpen::apply(&mut scene, model.sharpen_amount, model.sharpen_radius, model.sharpen_detail, model.sharpen_masking);
    noise_reduction::apply_luminance(&mut scene, model.nr_luminance);
    noise_reduction::apply_color(&mut scene, model.nr_color);
    agx::apply(&mut scene, model.contrast);
    encode::rec2020_to_srgb(&mut scene);
    let bytes = encode::quantize_u8(&mut scene);
    // Apply EXIF orientation last — rotating/flipping sRGB u8 is cheap and
    // keeps every upstream stage indifferent to sensor-vs-display framing.
    Ok(apply_orientation(&bytes, scene.width, scene.height, raw.orientation))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Shell helper for tests only — reads from disk then runs the pure
    /// pipeline. The core no longer exposes a path-based entrypoint.
    fn render_path(path: &std::path::Path, model: &AdjustmentModel) -> Result<(u32, u32, Vec<u8>)> {
        let bytes = std::fs::read(path).map_err(|e| crate::error::Error::Io {
            path: path.to_path_buf(), source: e,
        })?;
        let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
        let raw = crate::decode::decode_bytes(&bytes, ext)?;
        render_from_raw(&raw, model)
    }

    #[test]
    fn render_test_0002_baseline_produces_plausible_png_bytes() {
        let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../test-fixtures/raws/test_0002.dng");
        if !path.exists() { return; }
        let model = AdjustmentModel::default();
        let (w, h, bytes) = render_path(&path, &model).expect("render baseline");
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
        let (_, _, baseline) = render_path(&path, &model_baseline).unwrap();
        let (_, _, bright) = render_path(&path, &model_bright).unwrap();
        let mean_baseline: u64 = baseline.iter().map(|&b| b as u64).sum::<u64>() / baseline.len() as u64;
        let mean_bright: u64 = bright.iter().map(|&b| b as u64).sum::<u64>() / bright.len() as u64;
        assert!(mean_bright > mean_baseline,
            "+4EV ({}) should exceed baseline ({})", mean_bright, mean_baseline);
    }
}
