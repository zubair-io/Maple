use std::time::Instant;

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

/// Wraps a pipeline stage with `Instant::now()` timing, emitting one line
/// to stderr when `MAPLE_PROFILE` is set in the environment. When unset
/// the only cost is a single `Instant::now()` call and a `getenv` —
/// negligible relative to per-pixel work, so we leave it on in release
/// builds and let the env var gate the actual output.
///
/// Format: `[raw-core] <stage_name>            <elapsed>`. The width is
/// chosen so a 30-char name and a 10-char duration line up in a
/// monospace terminal — easy to eyeball "demosaic dominates" vs.
/// "every stage is 200 ms."
#[inline]
fn stage<T>(name: &'static str, f: impl FnOnce() -> T) -> T {
    let t = Instant::now();
    let r = f();
    if std::env::var_os("MAPLE_PROFILE").is_some() {
        eprintln!("[raw-core] {:<30} {:>10.2?}", name, t.elapsed());
    }
    r
}

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
    render_from_raw_with_quality(raw, model, RenderQuality::Full)
}

/// Quality knob for the interactive-vs-export split. `Preview` uses the
/// half-resolution quad demosaic — 4× fewer pixels feed every downstream
/// stage, memory peak drops from ~6 GB to ~1.5 GB on a 100 MP RAW, and a
/// cold decode lands in seconds rather than minutes. `Full` is the export
/// path — same pixel-exact output the parity harness locks down.
/// `Preview` returns the buffer at the half-res rendered dimensions —
/// callers must scale to display dimensions themselves (CIImage transform
/// on Apple, texture upload on Web).
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum RenderQuality {
    Preview,
    Full,
}

pub fn render_from_raw_with_quality(
    raw: &RawImage,
    model: &AdjustmentModel,
    quality: RenderQuality,
) -> Result<(u32, u32, Vec<u8>)> {
    let mosaic = stage("linearize", || linearize::sensor_linearize(raw));
    let mut camera_rgb = stage("demosaic", || match quality {
        RenderQuality::Preview => demosaic::half_res(&mosaic, raw.cfa),
        #[cfg(feature = "high-quality-demosaic")]
        RenderQuality::Full => demosaic::hamilton_adams(&mosaic, raw.cfa),
        #[cfg(not(feature = "high-quality-demosaic"))]
        RenderQuality::Full => demosaic::bilinear(&mosaic, raw.cfa),
    });

    // WB pre-gain (camera_rgb /= AsShotNeutral) is intentionally NOT applied
    // here despite being the DNG spec's step 4 per § 1.4.4.5. Applying it in
    // isolation (without the corresponding per-body BaselineExposure from the
    // DCP and without HSM/PLT hue correction) produced visibly worse output
    // on fixtures without those compensations:
    //   * high-ISO fixtures gained amplified chroma noise (R/B gains ~2×)
    //   * fixtures without a DCP-BE value got small per-channel hue shifts
    //     that would have been corrected by HueSatMap.
    // Reintroduce pre-gain together with per-body BaselineExposure (sourced
    // from Adobe DCPs) and HSM/PLT — see docs/spec/03-algorithms.md § 3.4
    // "HueSatMap application" (deferred). The scientific conclusion (pre-gain
    // is the DNG-conformant flow) stands; the engineering trade-off is to
    // land it as a bundle, not piecewise. Residual cost: ~0.5 EV uniform
    // underexposure on fixtures whose DNG lacks a BaselineExposure tag.

    // DNG § C.1.2: BaselineExposure is applied as a gain in a scene-linear
    // color space prior to the color-space transform. Mathematically
    // commutative with the linear CM that follows, so we apply in the
    // camera-native space for clarity — one multiply per channel.
    if raw.baseline_exposure.abs() > 1e-4 {
        stage("baseline_exposure", || {
            let be_gain = raw.baseline_exposure.exp2();
            for p in &mut camera_rgb.pixels {
                p[0] *= be_gain;
                p[1] *= be_gain;
                p[2] *= be_gain;
            }
        });
    }
    stage("highlight_recovery", || highlight_recovery::apply(&mut camera_rgb, model.highlight_recovery));
    let profile = stage("dcp::profile_for", || dcp::profile_for(raw))?;
    let mut scene = stage("dcp::apply", || dcp::apply(&camera_rgb, &profile))?;
    stage("white_balance", || white_balance::apply(&mut scene, model.temperature, model.tint));
    stage("scene_tone_controls", || scene_tone_controls::apply(&mut scene, model));
    stage("vibrance", || vibrance::apply(&mut scene, model.vibrance));
    stage("saturation", || saturation::apply(&mut scene, model.saturation));
    stage("clarity", || clarity::apply(&mut scene, model.clarity));
    stage("texture", || texture::apply(&mut scene, model.texture));
    stage("dehaze", || dehaze::apply(&mut scene, model.dehaze));
    stage("sharpen", || sharpen::apply(&mut scene, model.sharpen_amount, model.sharpen_radius, model.sharpen_detail, model.sharpen_masking));
    stage("nr_luminance", || noise_reduction::apply_luminance(&mut scene, model.nr_luminance));
    stage("nr_color", || noise_reduction::apply_color(&mut scene, model.nr_color));
    stage("agx", || agx::apply(&mut scene, model.contrast));
    stage("rec2020_to_srgb", || encode::rec2020_to_srgb(&mut scene));
    let bytes = stage("quantize_u8", || encode::quantize_u8(&mut scene));
    // Apply EXIF orientation last — rotating/flipping sRGB u8 is cheap and
    // keeps every upstream stage indifferent to sensor-vs-display framing.
    let (w, h, bytes) = stage("apply_orientation", || apply_orientation(&bytes, scene.width, scene.height, raw.orientation));
    // Both branches return the buffer at its actual rendered dimensions —
    // `Full` matches the sensor, `Preview` is half-res in both axes
    // (because of `demosaic::half_res`), and Apple/Web consumers handle
    // the resolution gap via their lazy display transform (CIImage scale
    // on Apple; texture upload on Web). Pixel-doubling here added ~300 MB
    // of FFI traffic and 4× the allocator pressure on a 100 MP RAW for no
    // extra information.
    Ok((w, h, bytes))
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
