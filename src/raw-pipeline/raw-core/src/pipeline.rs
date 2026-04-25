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
///
/// Note: any value of `MAPLE_PROFILE` enables logging (`is_some()`
/// gates on existence, not value). `MAPLE_PROFILE=0` and `MAPLE_PROFILE=`
/// both turn it on. `unset MAPLE_PROFILE` is the only way to disable.
#[inline]
pub fn stage<T>(name: &'static str, f: impl FnOnce() -> T) -> T {
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

/// Run the entire development chain through `nr_color` and return the
/// developed `Image` in `ColorSpace::SceneLinearRec2020`. Shared by both
/// the legacy display-encoded entry (`render_from_raw_with_quality`) and
/// the scene-linear FFI entry (`render_scene_linear_from_raw_with_quality`)
/// so the two paths can never drift.
///
/// Stages: linearize, demosaic, baseline_exposure, highlight_recovery,
/// dcp::profile_for + dcp::apply (camera RGB → SceneLinearRec2020),
/// white_balance, scene_tone_controls, vibrance, saturation, clarity,
/// texture, dehaze, sharpen, nr_luminance, nr_color.
pub fn develop_scene_linear_from_raw_with_quality(
    raw: &RawImage,
    model: &AdjustmentModel,
    quality: RenderQuality,
) -> Result<crate::image::Image> {
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
    Ok(scene)
}

pub fn render_from_raw_with_quality(
    raw: &RawImage,
    model: &AdjustmentModel,
    quality: RenderQuality,
) -> Result<(u32, u32, Vec<u8>)> {
    let mut scene = develop_scene_linear_from_raw_with_quality(raw, model, quality)?;
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

/// Apply EXIF orientation to a packed `[f32; 4]` RGBA buffer (treated as
/// straight alpha — alpha lane is always 1.0 here, but we copy it through
/// for symmetry with the future development chain).
///
/// Mirrors `apply_orientation` from `image.rs:159-193`, just in fp32 RGBA
/// instead of u8 RGB. We reproduce the per-orientation source mapping
/// instead of going through u8 because the new path never quantizes.
fn apply_orientation_f32_rgba(
    rgba: &[f32], w: u32, h: u32, orient: crate::image::ExifOrientation,
) -> (u32, u32, Vec<f32>) {
    use crate::image::ExifOrientation;
    let (sw, sh) = (w as usize, h as usize);
    debug_assert_eq!(rgba.len(), sw * sh * 4, "RGBA f32 buffer size mismatch");
    if orient == ExifOrientation::Normal {
        return (w, h, rgba.to_vec());
    }
    let (new_w, new_h) = if orient.swaps_wh() { (h, w) } else { (w, h) };
    let (dw, dh) = (new_w as usize, new_h as usize);
    let mut out = vec![0.0f32; dw * dh * 4];
    for yp in 0..dh {
        for xp in 0..dw {
            let (sx, sy) = match orient {
                ExifOrientation::Normal          => (xp, yp),
                ExifOrientation::HorizontalFlip  => (sw - 1 - xp, yp),
                ExifOrientation::Rotate180       => (sw - 1 - xp, sh - 1 - yp),
                ExifOrientation::VerticalFlip    => (xp, sh - 1 - yp),
                ExifOrientation::Transpose       => (yp, xp),
                ExifOrientation::Rotate90        => (yp, sh - 1 - xp),
                ExifOrientation::Transverse      => (sw - 1 - yp, sh - 1 - xp),
                ExifOrientation::Rotate270       => (sw - 1 - yp, xp),
            };
            let si = (sy * sw + sx) * 4;
            let di = (yp * dw + xp) * 4;
            out[di]     = rgba[si];
            out[di + 1] = rgba[si + 1];
            out[di + 2] = rgba[si + 2];
            out[di + 3] = rgba[si + 3];
        }
    }
    (new_w, new_h, out)
}

/// IEEE 754 binary16 encode of a `f32`. Matches the format CIImage.RGBAh
/// expects on the Apple side. Pure scalar — fp16 storage is u16 lanes.
///
/// This implementation isolates the float32 mantissa (bits 0..22) and
/// stored exponent (bits 23..30) **separately** before re-packing into
/// fp16. A naive `(bits >> 13) & 0x3fff` masks 14 bits including 4 bits
/// from the float32 stored exponent, which then leak into the fp16
/// mantissa via `mant >> 4` and produce ~31% positive bias on common
/// values like 1.5 (read back as ~1.97). Spike 1.1 caught this on the
/// Apple side; the same math lives here so the FFI handoff is correct.
/// See `SceneLinearPipelineTests.swift` for the cross-check.
fn f32_to_f16_bits(x: f32) -> u16 {
    let bits = x.to_bits();
    let sign: u16 = ((bits >> 16) & 0x8000) as u16;
    let stored_exp: i32 = ((bits >> 23) & 0xff) as i32;
    let mant_bits: u32 = bits & 0x007fffff;            // 23-bit float32 mantissa
    if stored_exp == 0xff {
        // Inf / NaN — preserve NaN-ness via a non-zero mantissa flag.
        return sign | 0x7c00 | (if mant_bits != 0 { 0x0001 } else { 0 });
    }
    let unbiased_exp = stored_exp - 127;
    let fp16_exp = unbiased_exp + 15;
    if fp16_exp >= 31 {
        return sign | 0x7c00; // overflow → inf
    }
    if fp16_exp <= 0 {
        // Subnormal / underflow.
        if fp16_exp < -10 { return sign; }
        // Add the implicit 1 and shift right to align in fp16 space.
        // fp16 subnormal precision = 10 bits below 2^-14.
        let mant_with_implicit = mant_bits | 0x00800000;
        let shift = (14 - unbiased_exp) as u32;
        // Round-to-nearest-even on the shifted-out bits.
        let shifted = mant_with_implicit >> (shift - 10 - 1); // keep 1 guard bit
        let rounded = (shifted + 1) >> 1;                      // round half-up
        return sign | ((rounded & 0x03ff) as u16);
    }
    // Normal range. Extract top 10 mantissa bits, with round-to-nearest
    // on the next bit.
    let top10 = (mant_bits >> 13) & 0x03ff;
    let round_bit = (mant_bits >> 12) & 0x1;
    let sticky_bits = mant_bits & 0x0fff;
    let mut fp16_mant = top10;
    // Round half to nearest-even.
    if round_bit != 0 && (sticky_bits != 0 || (fp16_mant & 0x1) != 0) {
        fp16_mant += 1;
        if fp16_mant > 0x3ff {
            // Mantissa overflow on round — bump exponent, mantissa goes to 0.
            let bumped_exp = fp16_exp + 1;
            if bumped_exp >= 31 {
                return sign | 0x7c00;
            }
            return sign | ((bumped_exp as u16) << 10);
        }
    }
    sign | ((fp16_exp as u16) << 10) | (fp16_mant as u16)
}

/// Scene-linear render entry. Runs the same development chain as
/// `render_from_raw_with_quality` (via the shared
/// `develop_scene_linear_from_raw_with_quality` helper — Step 2.4a)
/// but stops after `nr_color` and packs to fp16 RGBA without the view
/// transform tail. Output is packed Rec.2020 fp16 RGBA (8 bytes/pixel),
/// straight alpha = 1.0, row-major. Returned `Vec<u16>` is the fp16 bit
/// pattern; the FFI hands the underlying bytes to the caller via
/// `bytemuck::cast_slice`.
///
/// Plan 1 (FFI split) — the Apple side imports this buffer as a CIImage
/// tagged extendedLinearITUR_2020 and runs Lanczos prescale + AgX kernel
/// + sRGB encode in CoreImage. See
/// docs/superpowers/plans/2026-04-24-ffi-split-plan-1.md.
pub fn render_scene_linear_from_raw_with_quality(
    raw: &RawImage,
    model: &AdjustmentModel,
    quality: RenderQuality,
) -> Result<(u32, u32, Vec<u16>)> {
    let scene = develop_scene_linear_from_raw_with_quality(raw, model, quality)?;
    // STOP: no agx::apply, no rec2020_to_srgb, no quantize_u8.
    // Pack [f32;3] + alpha=1.0 to packed [f32;4] RGBA, then orient, then
    // convert to fp16 lanes for the FFI handoff.
    let (w0, h0) = (scene.width, scene.height);
    let rgba_f32 = stage("pack_rgba_f32", || {
        let mut v = Vec::with_capacity(scene.pixels.len() * 4);
        for p in &scene.pixels {
            v.push(p[0]);
            v.push(p[1]);
            v.push(p[2]);
            v.push(1.0);
        }
        v
    });
    let (w, h, oriented_f32) = stage("apply_orientation_rgba", || {
        apply_orientation_f32_rgba(&rgba_f32, w0, h0, raw.orientation)
    });
    let fp16: Vec<u16> = stage("pack_fp16", || {
        oriented_f32.iter().map(|&v| f32_to_f16_bits(v)).collect()
    });
    Ok((w, h, fp16))
}

/// Area-average downsample an `Image`'s f32 RGB pixel buffer to fit within
/// `max_long_edge` on its long edge while preserving the aspect ratio.
/// **Never upscales** (ticket 06 § Product Requirements 1) — if the source
/// long edge is already <= `max_long_edge`, returns the image unmodified.
///
/// Same algorithm as `api::downsample_to_rgba` but in f32 RGB: integer
/// source-row spans are averaged into each destination pixel, no
/// premultiplied-alpha or gamma considerations because the buffer is
/// straight scene-linear with no alpha channel. A higher-quality Lanczos
/// or Mitchell variant lands as a follow-up (ticket 06 Milestone 3).
///
/// Mutates `image` in place; updates `image.width` and `image.height` to
/// the new dimensions.
pub fn downsample_image_area(image: &mut crate::image::Image, max_long_edge: u32) {
    let (sw, sh) = (image.width, image.height);
    let long_edge = sw.max(sh);
    if long_edge <= max_long_edge { return; }
    let (dw, dh) = if sw >= sh {
        let scale = max_long_edge as f64 / sw as f64;
        (max_long_edge, ((sh as f64 * scale).round() as u32).max(1))
    } else {
        let scale = max_long_edge as f64 / sh as f64;
        (((sw as f64 * scale).round() as u32).max(1), max_long_edge)
    };
    let sw_u = sw as usize;
    let mut out: Vec<[f32; 3]> = Vec::with_capacity((dw as usize) * (dh as usize));
    for y in 0..dh {
        let y0 = ((y as u64) * (sh as u64) / (dh as u64)) as usize;
        let y1 = (((y + 1) as u64) * (sh as u64) / (dh as u64)).max((y0 + 1) as u64) as usize;
        let y1 = y1.min(sh as usize);
        for x in 0..dw {
            let x0 = ((x as u64) * (sw as u64) / (dw as u64)) as usize;
            let x1 = (((x + 1) as u64) * (sw as u64) / (dw as u64)).max((x0 + 1) as u64) as usize;
            let x1 = x1.min(sw as usize);
            let (mut sr, mut sg, mut sb, mut n) = (0.0f32, 0.0f32, 0.0f32, 0u32);
            for sy in y0..y1 {
                for sx in x0..x1 {
                    let p = image.pixels[sy * sw_u + sx];
                    sr += p[0]; sg += p[1]; sb += p[2]; n += 1;
                }
            }
            let nf = n.max(1) as f32;
            out.push([sr / nf, sg / nf, sb / nf]);
        }
    }
    image.pixels = out;
    image.width = dw;
    image.height = dh;
}

/// Sized scene-linear render entry. Same shared development chain as
/// `render_scene_linear_from_raw_with_quality`, then downsample to fit
/// within `max_long_edge` (single scalar — see Plan 1 v2 Task 8 API
/// decision: long-edge simplifies WASM parity and aspect math is local
/// to the renderer; per ticket 06 § Open Questions). Never upscales.
///
/// Plan 1 v2 (FFI split + viewport-sized) — the Apple side imports this
/// buffer at the target dimensions and runs Lanczos prescale + AgX kernel
/// + sRGB encode in CoreImage.
pub fn render_scene_linear_sized_from_raw_with_quality(
    raw: &RawImage,
    model: &AdjustmentModel,
    quality: RenderQuality,
    max_long_edge: u32,
) -> Result<(u32, u32, Vec<u16>)> {
    let mut scene = develop_scene_linear_from_raw_with_quality(raw, model, quality)?;
    stage("downsample_area_f32", || downsample_image_area(&mut scene, max_long_edge));
    let (w0, h0) = (scene.width, scene.height);
    let rgba_f32 = stage("pack_rgba_f32_sized", || {
        let mut v = Vec::with_capacity(scene.pixels.len() * 4);
        for p in &scene.pixels {
            v.push(p[0]);
            v.push(p[1]);
            v.push(p[2]);
            v.push(1.0);
        }
        v
    });
    let (w, h, oriented_f32) = stage("apply_orientation_rgba_sized", || {
        apply_orientation_f32_rgba(&rgba_f32, w0, h0, raw.orientation)
    });
    let fp16: Vec<u16> = stage("pack_fp16_sized", || {
        oriented_f32.iter().map(|&v| f32_to_f16_bits(v)).collect()
    });
    Ok((w, h, fp16))
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

    /// New scene-linear FFI entry. Returns Rec.2020 fp16 RGBA, half-res for
    /// Preview, full for Full. Verify: the buffer is 8 bytes/pixel (4 ×
    /// fp16), alpha is 1.0 everywhere, and the buffer is non-zero.
    #[test]
    fn render_scene_linear_test_0002_preview_returns_rec2020_fp16_rgba() {
        let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../test-fixtures/raws/test_0002.dng");
        if !path.exists() { return; }
        let bytes = std::fs::read(&path).expect("read raw");
        let raw = crate::decode::decode_bytes(&bytes, "dng").expect("decode");
        let model = AdjustmentModel::default();
        let (w, h, fp16_rgba) = render_scene_linear_from_raw_with_quality(
            &raw, &model, RenderQuality::Preview
        ).expect("scene-linear preview render");
        // Each pixel = 4 channels × 2 bytes = 8 bytes; the Vec is u16 (fp16
        // bit pattern), so length = 4 × w × h.
        assert_eq!(fp16_rgba.len() as u32, 4 * w * h,
            "expected 4 × w × h fp16 lanes, got {} for {}×{}",
            fp16_rgba.len(), w, h);
        // Alpha (every 4th lane) must be the fp16 pattern of 1.0 (0x3c00).
        let mut alpha_ok = 0usize;
        for chunk in fp16_rgba.chunks_exact(4) {
            if chunk[3] == 0x3c00 { alpha_ok += 1; }
        }
        assert_eq!(alpha_ok, (w * h) as usize,
            "expected {} alpha=1.0 lanes, got {}", w * h, alpha_ok);
        // Buffer is not all zeros.
        let nonzero = fp16_rgba.iter().filter(|&&v| v != 0 && v != 0x3c00).count();
        assert!(nonzero > (fp16_rgba.len() / 10),
            "buffer mostly zero: {} non-zero/non-alpha lanes", nonzero);
    }

    /// Sized scene-linear FFI entry: caps the long edge at a viewport
    /// budget. Verify: the returned buffer's long edge equals the cap
    /// (or stays at the source dimension if the source is smaller — no
    /// upscale per ticket 06 § Product Requirements 1), and the alpha
    /// lane is 1.0 everywhere.
    #[test]
    fn render_scene_linear_sized_test_0002_caps_long_edge_at_1500() {
        let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../test-fixtures/raws/test_0002.dng");
        if !path.exists() { return; }
        let bytes = std::fs::read(&path).expect("read raw");
        let raw = crate::decode::decode_bytes(&bytes, "dng").expect("decode");
        let model = AdjustmentModel::default();
        let max_long_edge: u32 = 1500;
        let (w, h, fp16_rgba) = render_scene_linear_sized_from_raw_with_quality(
            &raw, &model, RenderQuality::Preview, max_long_edge,
        ).expect("scene-linear sized preview render");
        // Cap respected on the long edge.
        assert!(w.max(h) <= max_long_edge,
            "long edge exceeded cap: {}x{} > {}", w, h, max_long_edge);
        // Buffer length matches.
        assert_eq!(fp16_rgba.len() as u32, 4 * w * h);
        // Alpha = 1.0 everywhere.
        for chunk in fp16_rgba.chunks_exact(4) {
            assert_eq!(chunk[3], 0x3c00, "alpha != 1.0 in sized buffer");
        }
    }

    // Sanity tests for f32_to_f16_bits — guards against the bit-isolation
    // bug Spike 1.1 caught on the Apple side. `0x3c00` is the fp16 bit
    // pattern of 1.0; `0x4000` is 2.0; `0x3e00` is 1.5; `0x0000` is 0.0.
    #[test]
    fn f32_to_f16_bits_zero_one_half_two() {
        assert_eq!(f32_to_f16_bits(0.0), 0x0000);
        assert_eq!(f32_to_f16_bits(1.0), 0x3c00);
        assert_eq!(f32_to_f16_bits(2.0), 0x4000);
        assert_eq!(f32_to_f16_bits(1.5), 0x3e00);
    }

    /// Round-trip 1.5 through fp16 and back. The buggy form would return
    /// ~1.97 for 1.5; the correct isolation returns 1.5 exactly (1.5 is
    /// representable in fp16).
    #[test]
    fn f32_to_f16_bits_one_point_five_round_trips_exact() {
        let bits = f32_to_f16_bits(1.5);
        // Decode fp16 -> f32 manually.
        let sign = ((bits & 0x8000) as u32) << 16;
        let exp = ((bits & 0x7c00) >> 10) as u32;
        let mant = (bits & 0x03ff) as u32;
        let f = if exp == 0 && mant == 0 {
            f32::from_bits(sign)
        } else if exp == 0x1f {
            f32::from_bits(sign | 0x7f800000 | (mant << 13))
        } else {
            // Normal: rebias exponent and shift mantissa.
            let f32_exp = (exp + 127 - 15) << 23;
            f32::from_bits(sign | f32_exp | (mant << 13))
        };
        assert!((f - 1.5).abs() < 1e-6,
            "1.5 round-trip: got {} (fp16 bits 0x{:04x})", f, bits);
    }
}
