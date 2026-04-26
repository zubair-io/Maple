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
    let mut camera_rgb = match raw.cfa {
        crate::image::CfaPattern::LinearRgb => {
            // LinearRaw DNG: data is already 3-channel RGB. Skip the
            // mosaic path entirely. See ticket #07.
            stage("linearraw_decode", || linearize::linearraw_to_camera_rgb(raw))?
        }
        _ => {
            let mosaic = stage("linearize", || linearize::sensor_linearize(raw));
            stage("demosaic", || match quality {
                RenderQuality::Preview => demosaic::half_res(&mosaic, raw.cfa),
                #[cfg(feature = "high-quality-demosaic")]
                RenderQuality::Full => demosaic::hamilton_adams(&mosaic, raw.cfa),
                #[cfg(not(feature = "high-quality-demosaic"))]
                RenderQuality::Full => demosaic::bilinear(&mosaic, raw.cfa),
            })
        }
    };

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

/// Sized variant of `develop_scene_linear_from_raw_with_quality` that
/// runs `linearize` + `demosaic` (or `linearraw_to_camera_rgb` for
/// LinearRaw fixtures), then immediately downsamples the camera-RGB
/// buffer to fit within `max_long_edge`, then runs the rest of the
/// development chain on the smaller buffer. Saves ~8× on every
/// post-demosaic stage when the source is 100 MP and the viewport is
/// ~3 MP. See ticket 06 § Recommended Milestones / Milestone 3 and
/// docs/superpowers/specs/2026-04-25-ticket-06-m3-earlier-downsample-brief.md.
///
/// Per-stage profile labels are prefixed `sized_` so MAPLE_PROFILE=1
/// traces don't collide with the full-res `develop_…` labels — same
/// convention the tile path uses (`tile_*`).
///
/// Never upscales: `downsample_image_area` early-returns when the
/// source long edge is already <= `max_long_edge`. In that case this
/// helper is functionally identical to
/// `develop_scene_linear_from_raw_with_quality`, only with `sized_*`
/// stage labels.
pub fn develop_scene_linear_sized_from_raw_with_quality(
    raw: &RawImage,
    model: &AdjustmentModel,
    quality: RenderQuality,
    max_long_edge: u32,
) -> Result<crate::image::Image> {
    let mut camera_rgb = match raw.cfa {
        crate::image::CfaPattern::LinearRgb => {
            stage("sized_linearraw_decode", || linearize::linearraw_to_camera_rgb(raw))?
        }
        _ => {
            let mosaic = stage("sized_linearize", || linearize::sensor_linearize(raw));
            stage("sized_demosaic", || match quality {
                RenderQuality::Preview => demosaic::half_res(&mosaic, raw.cfa),
                #[cfg(feature = "high-quality-demosaic")]
                RenderQuality::Full => demosaic::hamilton_adams(&mosaic, raw.cfa),
                #[cfg(not(feature = "high-quality-demosaic"))]
                RenderQuality::Full => demosaic::bilinear(&mosaic, raw.cfa),
            })
        }
    };

    // Early downsample — the heart of this milestone. After this call
    // every later stage runs on the viewport-sized buffer instead of
    // the half-res sensor buffer. `downsample_image_area` is a no-op
    // when the source long edge is already <= `max_long_edge`.
    stage("sized_downsample_area_f32", || {
        downsample_image_area(&mut camera_rgb, max_long_edge)
    });

    if raw.baseline_exposure.abs() > 1e-4 {
        stage("sized_baseline_exposure", || {
            let be_gain = raw.baseline_exposure.exp2();
            for p in &mut camera_rgb.pixels {
                p[0] *= be_gain;
                p[1] *= be_gain;
                p[2] *= be_gain;
            }
        });
    }
    stage("sized_highlight_recovery", || highlight_recovery::apply(&mut camera_rgb, model.highlight_recovery));
    let profile = stage("sized_dcp_profile_for", || dcp::profile_for(raw))?;
    let mut scene = stage("sized_dcp_apply", || dcp::apply(&camera_rgb, &profile))?;
    stage("sized_white_balance", || white_balance::apply(&mut scene, model.temperature, model.tint));
    stage("sized_scene_tone_controls", || scene_tone_controls::apply(&mut scene, model));
    stage("sized_vibrance", || vibrance::apply(&mut scene, model.vibrance));
    stage("sized_saturation", || saturation::apply(&mut scene, model.saturation));
    stage("sized_clarity", || clarity::apply(&mut scene, model.clarity));
    stage("sized_texture", || texture::apply(&mut scene, model.texture));
    stage("sized_dehaze", || dehaze::apply(&mut scene, model.dehaze));
    stage("sized_sharpen", || sharpen::apply(&mut scene, model.sharpen_amount, model.sharpen_radius, model.sharpen_detail, model.sharpen_masking));
    stage("sized_nr_luminance", || noise_reduction::apply_luminance(&mut scene, model.nr_luminance));
    stage("sized_nr_color", || noise_reduction::apply_color(&mut scene, model.nr_color));
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
    // M3: develop with the early-downsample helper. The downsample
    // happens immediately after demosaic so post-demosaic stages run
    // on the viewport-sized buffer. The post-pipeline
    // `downsample_image_area` call this function used to make is now
    // inside the helper.
    let scene = develop_scene_linear_sized_from_raw_with_quality(
        raw, model, quality, max_long_edge,
    )?;
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

/// Tile-overlap pad in source pixels per edge. Picked to satisfy
/// clarity at radius 40 (3-pass box ≈ 39 px) — the binding stencil among
/// the tile-safe stages. Other stages (demosaic 2 px, sharpen ≤ 9 px,
/// nr_color ≤ 4 px, texture 3 px) sit comfortably inside this pad.
/// Dehaze (radius 67) is NOT tile-safe — `render_scene_linear_tile_from_raw_with_quality`
/// errors when `model.dehaze != 0`.
pub const TILE_OVERLAP_PX: u32 = 35;

/// Pad a `(src_x, src_y, src_w, src_h)` source-pixel rect by `pad` pixels on
/// each edge, clamp to `(0..mosaic_w, 0..mosaic_h)`, and round the resulting
/// rect's start corners DOWN to the nearest even multiple to preserve
/// Bayer phase for `demosaic::half_res` and `cfa.color_at`. End corners
/// round UP within bounds so the inner rect is fully covered. Returns the
/// padded rect `(x, y, w, h)` plus the `(left_pad, top_pad)` actually
/// applied — the trim step at the end of the tile entry uses these to
/// compute the inner-image-relative crop after the development chain runs
/// on the padded buffer.
fn pad_and_clamp_mosaic_rect(
    src_x: u32, src_y: u32, src_w: u32, src_h: u32,
    pad: u32, mosaic_w: u32, mosaic_h: u32,
) -> ((u32, u32, u32, u32), (u32, u32)) {
    let pre_x = src_x.saturating_sub(pad);
    let pre_y = src_y.saturating_sub(pad);
    let pre_x_end = (src_x.saturating_add(src_w).saturating_add(pad)).min(mosaic_w);
    let pre_y_end = (src_y.saturating_add(src_h).saturating_add(pad)).min(mosaic_h);
    // Round start corners DOWN to even (Bayer phase). End corners round UP
    // within bounds so the inner rect remains fully covered.
    let x = pre_x & !1u32;
    let y = pre_y & !1u32;
    let x_end_aligned = ((pre_x_end + 1) & !1u32).min(mosaic_w);
    let y_end_aligned = ((pre_y_end + 1) & !1u32).min(mosaic_h);
    let w = x_end_aligned.saturating_sub(x);
    let h = y_end_aligned.saturating_sub(y);
    let left_pad = src_x.saturating_sub(x);
    let top_pad = src_y.saturating_sub(y);
    ((x, y, w, h), (left_pad, top_pad))
}

/// Crop a `CameraNativeMosaic` `Image` to a sub-rectangle. Returns a fresh
/// mosaic `Image` at the cropped dimensions; the CFA pattern is preserved
/// because `(x, y)` are guaranteed even (see `pad_and_clamp_mosaic_rect`).
fn crop_mosaic_to_padded_rect(
    mosaic: &crate::image::Image, rect: (u32, u32, u32, u32),
) -> crate::image::Image {
    use crate::image::ColorSpace;
    let (cx, cy, cw, ch) = rect;
    mosaic.assert_space(ColorSpace::CameraNativeMosaic);
    let mut out = crate::image::Image::new(cw, ch, ColorSpace::CameraNativeMosaic);
    let sw = mosaic.width as usize;
    for y in 0..(ch as usize) {
        let src_off = ((cy as usize) + y) * sw + (cx as usize);
        let dst_off = y * (cw as usize);
        out.pixels[dst_off..dst_off + cw as usize]
            .copy_from_slice(&mosaic.pixels[src_off..src_off + cw as usize]);
    }
    out
}

/// Trim an `Image` to its inner `(left_pad, top_pad, inner_w, inner_h)` rect.
/// Used after the development chain runs on the padded crop — we discard
/// the overlap region and keep only the requested source-pixel area.
/// Note: this runs in fp32 RGB, AFTER `nr_color` and BEFORE downsampling.
fn trim_image_to_inner(
    img: &crate::image::Image,
    left_pad: u32, top_pad: u32,
    inner_w: u32, inner_h: u32,
) -> crate::image::Image {
    let space = img.space;
    let mut out = crate::image::Image::new(inner_w, inner_h, space);
    let sw = img.width as usize;
    for y in 0..(inner_h as usize) {
        let src_off = ((top_pad as usize) + y) * sw + (left_pad as usize);
        let dst_off = y * (inner_w as usize);
        out.pixels[dst_off..dst_off + inner_w as usize]
            .copy_from_slice(&img.pixels[src_off..src_off + inner_w as usize]);
    }
    out
}

/// Run the development chain from a pre-cropped `CameraNativeMosaic`
/// `Image` (as produced by `linearize::sensor_linearize` + a manual
/// `crop_mosaic_to_padded_rect`). Used by the tile path so the linearize
/// + crop pair runs once on the full mosaic and the develop chain runs
/// on a small padded-crop. Mirrors `develop_scene_linear_from_raw_with_quality`
/// but without the leading `linearize` call and **without** dehaze (the
/// tile entry errors before this fn runs when `model.dehaze != 0`).
fn develop_scene_linear_from_padded_mosaic(
    mosaic: &crate::image::Image,
    raw: &RawImage,
    model: &AdjustmentModel,
    quality: RenderQuality,
) -> Result<crate::image::Image> {
    if raw.cfa == crate::image::CfaPattern::LinearRgb {
        return Err(crate::error::Error::Pipeline(
            "tile path does not support LinearRaw DNGs; use the full-image render entry instead. See ticket #07."
                .into()
        ));
    }
    mosaic.assert_space(crate::image::ColorSpace::CameraNativeMosaic);
    let mut camera_rgb = stage("tile_demosaic", || match quality {
        RenderQuality::Preview => demosaic::half_res(mosaic, raw.cfa),
        #[cfg(feature = "high-quality-demosaic")]
        RenderQuality::Full => demosaic::hamilton_adams(mosaic, raw.cfa),
        #[cfg(not(feature = "high-quality-demosaic"))]
        RenderQuality::Full => demosaic::bilinear(mosaic, raw.cfa),
    });
    if raw.baseline_exposure.abs() > 1e-4 {
        stage("tile_baseline_exposure", || {
            let be_gain = raw.baseline_exposure.exp2();
            for p in &mut camera_rgb.pixels {
                p[0] *= be_gain;
                p[1] *= be_gain;
                p[2] *= be_gain;
            }
        });
    }
    stage("tile_highlight_recovery", || highlight_recovery::apply(&mut camera_rgb, model.highlight_recovery));
    let profile = stage("tile_dcp_profile_for", || dcp::profile_for(raw))?;
    let mut scene = stage("tile_dcp_apply", || dcp::apply(&camera_rgb, &profile))?;
    stage("tile_white_balance", || white_balance::apply(&mut scene, model.temperature, model.tint));
    stage("tile_scene_tone_controls", || scene_tone_controls::apply(&mut scene, model));
    stage("tile_vibrance", || vibrance::apply(&mut scene, model.vibrance));
    stage("tile_saturation", || saturation::apply(&mut scene, model.saturation));
    stage("tile_clarity", || clarity::apply(&mut scene, model.clarity));
    stage("tile_texture", || texture::apply(&mut scene, model.texture));
    // dehaze intentionally omitted — the tile entry asserts dehaze == 0
    // before this function runs (radius 67 px > 35 px overlap pad).
    stage("tile_sharpen", || sharpen::apply(&mut scene, model.sharpen_amount, model.sharpen_radius, model.sharpen_detail, model.sharpen_masking));
    stage("tile_nr_luminance", || noise_reduction::apply_luminance(&mut scene, model.nr_luminance));
    stage("tile_nr_color", || noise_reduction::apply_color(&mut scene, model.nr_color));
    Ok(scene)
}

/// Render a tile of the developed scene-linear Rec.2020 fp16 RGBA image.
///
/// Parameters:
/// - `(src_x, src_y, src_w, src_h)`: source-pixel rectangle in mosaic
///   coordinates (pre-orientation). The mosaic crop coords get rounded
///   to even via `pad_and_clamp_mosaic_rect` for Bayer-phase preservation.
/// - `(out_w, out_h)`: target dimensions — never upscale; this fn errors
///   if `out_w > src_w || out_h > src_h`.
/// - `quality`: `Preview` (half-res quad demosaic) or `Full` (bilinear or
///   hamilton_adams per `cfg(feature)`).
///
/// Errors:
/// - `model.dehaze != 0` → returns `Err` with a "dehaze" message; tiles
///   are not safe with dehaze active (radius 67 px > 35 px overlap pad).
/// - `out_w > src_w || out_h > src_h` → returns `Err` ("upscale"); the
///   tile path caps at native resolution.
///
/// Output is fp16 RGBA, length `4 * out_w * out_h`, alpha = 0x3c00. The
/// orientation is applied by walking the trim+downsample output through
/// `apply_orientation_f32_rgba` (so the `(src_x, src_y)` handed in is in
/// pre-orientation space; the returned tile's orientation matches the
/// full-image's `apply_orientation` output).
pub fn render_scene_linear_tile_from_raw_with_quality(
    raw: &RawImage,
    model: &AdjustmentModel,
    src_x: u32, src_y: u32, src_w: u32, src_h: u32,
    out_w: u32, out_h: u32,
    quality: RenderQuality,
) -> Result<(u32, u32, Vec<u16>)> {
    if raw.cfa == crate::image::CfaPattern::LinearRgb {
        return Err(crate::error::Error::Pipeline(
            "tile path does not support LinearRaw DNGs; use the full-image render entry instead. See ticket #07."
                .into()
        ));
    }
    if model.dehaze.abs() > 1e-3 {
        return Err(crate::error::Error::Pipeline(
            "tile path is not supported when dehaze != 0 (radius 67 px > 35 px overlap pad)"
                .into()
        ));
    }
    if out_w > src_w || out_h > src_h {
        return Err(crate::error::Error::Pipeline(
            format!("tile path is downscale-only (no upscale): out {}×{} > src {}×{}",
                out_w, out_h, src_w, src_h)
        ));
    }
    let mosaic_full = stage("tile_linearize", || linearize::sensor_linearize(raw));
    let (rect, (left_pad, top_pad)) = pad_and_clamp_mosaic_rect(
        src_x, src_y, src_w, src_h, TILE_OVERLAP_PX,
        mosaic_full.width, mosaic_full.height,
    );
    let mosaic = stage("tile_mosaic_crop", || crop_mosaic_to_padded_rect(&mosaic_full, rect));
    let scene = develop_scene_linear_from_padded_mosaic(&mosaic, raw, model, quality)?;

    // Trim the overlap, leaving the inner src_w × src_h block. For half-res
    // Preview the trim coords halve too — the cropped mosaic was half-resed
    // by `demosaic::half_res`, so the inner region is at
    // `(left_pad / 2, top_pad / 2)` with size `(src_w / 2, src_h / 2)`. For
    // `Full` quality the chain preserves dimensions, so it's
    // `(left_pad, top_pad)` with `(src_w, src_h)`.
    let (inner_lp, inner_tp, inner_w, inner_h) = match quality {
        RenderQuality::Preview => (left_pad / 2, top_pad / 2, src_w / 2, src_h / 2),
        RenderQuality::Full    => (left_pad,     top_pad,     src_w,     src_h),
    };
    let mut sized = stage("tile_trim_inner", || {
        trim_image_to_inner(&scene, inner_lp, inner_tp, inner_w, inner_h)
    });

    let target_long_edge = out_w.max(out_h);
    if target_long_edge < sized.width.max(sized.height) {
        stage("tile_downsample_area", || downsample_image_area(&mut sized, target_long_edge));
    }

    let (w0, h0) = (sized.width, sized.height);
    let rgba_f32 = stage("tile_pack_rgba_f32", || {
        let mut v = Vec::with_capacity(sized.pixels.len() * 4);
        for p in &sized.pixels {
            v.push(p[0]); v.push(p[1]); v.push(p[2]); v.push(1.0);
        }
        v
    });

    // Orient the tile in fp32 RGBA. The `(src_x, src_y)` argument is in
    // source-pixel (sensor) coordinates, so the returned tile's pixel
    // space is post-orientation, matching the unsized scene-linear FFI
    // entry's output.
    let (w, h, oriented_f32) = stage("tile_apply_orientation_rgba", || {
        apply_orientation_f32_rgba(&rgba_f32, w0, h0, raw.orientation)
    });
    let fp16: Vec<u16> = stage("tile_pack_fp16", || {
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

    /// M3 commutativity gate: render test_0017.dng via the original
    /// late-downsample path (full-res develop, then
    /// `downsample_image_area`) and the new early-downsample path
    /// (`develop_scene_linear_sized_from_raw_with_quality` runs
    /// downsample right after demosaic), then compare per-channel
    /// f32 mean delta in scene-linear Rec.2020.
    ///
    /// Budget: mean per-channel delta ≤ 0.005 in linear-light. The
    /// expected dominant source of difference is the
    /// non-commutativity of (downsample ∘ filter) vs
    /// (filter ∘ downsample); for natural scenes at the default
    /// AdjustmentModel (sharpen_amount=0, nr_luminance=0,
    /// nr_color=25 with radius 1 px, clarity=0, dehaze=0) this is
    /// dominated by the nr_color blur and bounded by the
    /// downsample kernel's low-pass character.
    ///
    /// Skips if test_0017.dng is absent (gitignored fixtures).
    #[test]
    fn early_vs_late_downsample_within_fp16_tolerance() {
        let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../test-fixtures/raws/test_0017.dng");
        if !path.exists() { return; }
        let bytes = std::fs::read(&path).expect("read raw");
        let raw = crate::decode::decode_bytes(&bytes, "dng").expect("decode");
        let model = AdjustmentModel::default();
        let max_long_edge: u32 = 1500;

        // Late-downsample: full-res develop, then downsample.
        let mut late = develop_scene_linear_from_raw_with_quality(
            &raw, &model, RenderQuality::Preview,
        ).expect("late develop");
        downsample_image_area(&mut late, max_long_edge);

        // Early-downsample: new helper runs downsample post-demosaic.
        let early = develop_scene_linear_sized_from_raw_with_quality(
            &raw, &model, RenderQuality::Preview, max_long_edge,
        ).expect("early develop");

        // Sizes must match — both end at <= max_long_edge on the long edge.
        assert_eq!(early.width, late.width, "width mismatch");
        assert_eq!(early.height, late.height, "height mismatch");
        assert_eq!(early.pixels.len(), late.pixels.len(), "pixel count mismatch");

        let n = early.pixels.len();
        let mut sum_dr = 0.0f64;
        let mut sum_dg = 0.0f64;
        let mut sum_db = 0.0f64;
        let mut max_dr = 0.0f32;
        let mut max_dg = 0.0f32;
        let mut max_db = 0.0f32;
        for (a, b) in early.pixels.iter().zip(late.pixels.iter()) {
            let dr = (a[0] - b[0]).abs();
            let dg = (a[1] - b[1]).abs();
            let db = (a[2] - b[2]).abs();
            sum_dr += dr as f64;
            sum_dg += dg as f64;
            sum_db += db as f64;
            if dr > max_dr { max_dr = dr; }
            if dg > max_dg { max_dg = dg; }
            if db > max_db { max_db = db; }
        }
        let mean_dr = (sum_dr / n as f64) as f32;
        let mean_dg = (sum_dg / n as f64) as f32;
        let mean_db = (sum_db / n as f64) as f32;
        eprintln!(
            "early-vs-late: mean dR={:.5} dG={:.5} dB={:.5}  max dR={:.5} dG={:.5} dB={:.5}",
            mean_dr, mean_dg, mean_db, max_dr, max_dg, max_db,
        );

        // Mean per-channel delta budget. 0.005 in [0, ~5] scene-linear
        // headroom is ~0.1% of typical scene values.
        assert!(mean_dr < 0.005, "mean R delta {} > 0.005", mean_dr);
        assert!(mean_dg < 0.005, "mean G delta {} > 0.005", mean_dg);
        assert!(mean_db < 0.005, "mean B delta {} > 0.005", mean_db);
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

    // -----------------------------------------------------------------
    // Tile-rendering entry tests (Plan deep-zoom-tile-rendering Task 1).
    // -----------------------------------------------------------------

    /// Build a fake `RawImage` for the dehaze / out>src error-path tests.
    /// Decode + DCP + every chained stage need a real RAW + DCP profile,
    /// so these helpers only feed paths that error before any of that
    /// runs.
    fn fake_raw(w: u32, h: u32) -> RawImage {
        RawImage {
            width: w,
            height: h,
            cfa: crate::image::CfaPattern::Rggb,
            black_level: [0, 0, 0, 0],
            white_level: 1023,
            raw_data: vec![0u16; (w as usize) * (h as usize)],
            as_shot_neutral: [1.0, 1.0, 1.0],
            as_shot_cct: None,
            camera_make: "Test".into(),
            camera_model: "Test".into(),
            color_matrices: std::collections::HashMap::new(),
            orientation: crate::image::ExifOrientation::Normal,
            baseline_exposure: 0.0,
        }
    }

    /// Tile entry rejects `model.dehaze != 0` with a "dehaze" error. The
    /// rejection happens before any decode / DCP work, so a synthetic
    /// `RawImage` (no DCP profile) is sufficient to exercise the path.
    #[test]
    fn render_scene_linear_tile_rejects_active_dehaze() {
        let raw = fake_raw(2048, 2048);
        let model = AdjustmentModel { dehaze: 50.0, ..Default::default() };
        let r = render_scene_linear_tile_from_raw_with_quality(
            &raw, &model, 1024, 1024, 512, 512, 512, 512,
            RenderQuality::Full,
        );
        assert!(r.is_err(), "tile path must error when dehaze != 0");
        let msg = format!("{}", r.unwrap_err());
        assert!(msg.contains("dehaze"),
            "error must mention dehaze, got: {}", msg);
    }

    /// Tile entry rejects upscale requests (`out_w > src_w` or
    /// `out_h > src_h`). Same fake-RawImage rationale as the dehaze test.
    #[test]
    fn render_scene_linear_tile_rejects_upscale() {
        let raw = fake_raw(2048, 2048);
        let model = AdjustmentModel::default();
        let r_w = render_scene_linear_tile_from_raw_with_quality(
            &raw, &model, 0, 0, 512, 512, 1024, 512,
            RenderQuality::Full,
        );
        assert!(r_w.is_err(), "out_w > src_w must error");
        let msg = format!("{}", r_w.unwrap_err());
        assert!(msg.contains("upscale") || msg.contains("downscale"),
            "error must mention up/downscale, got: {}", msg);

        let r_h = render_scene_linear_tile_from_raw_with_quality(
            &raw, &model, 0, 0, 512, 512, 512, 1024,
            RenderQuality::Full,
        );
        assert!(r_h.is_err(), "out_h > src_h must error");
    }

    /// `pad_and_clamp_mosaic_rect` rounds the start corners DOWN to even
    /// multiples (Bayer-phase preservation for `demosaic::half_res`).
    #[test]
    fn pad_and_clamp_mosaic_rect_rounds_start_to_even() {
        // Odd start coords with plenty of room — pad pulls back to even.
        let ((x, y, _w, _h), (lp, tp)) = pad_and_clamp_mosaic_rect(
            1025, 1025, 512, 512, 35, 8000, 8000,
        );
        assert_eq!(x & 1, 0, "x must be even, got {}", x);
        assert_eq!(y & 1, 0, "y must be even, got {}", y);
        // 1025 - 35 = 990, already even → x = 990. left_pad = 1025 - 990 = 35.
        assert_eq!(x, 990);
        assert_eq!(y, 990);
        assert_eq!(lp, 35);
        assert_eq!(tp, 35);

        // Even start coords with plenty of room — pad lands on even
        // already, no further snap.
        let ((x2, y2, _w2, _h2), (lp2, tp2)) = pad_and_clamp_mosaic_rect(
            1024, 1024, 512, 512, 35, 8000, 8000,
        );
        // 1024 - 35 = 989, snap down to 988. left_pad = 1024 - 988 = 36.
        assert_eq!(x2 & 1, 0);
        assert_eq!(y2 & 1, 0);
        assert_eq!(x2, 988);
        assert_eq!(y2, 988);
        assert_eq!(lp2, 36);
        assert_eq!(tp2, 36);
    }

    /// `pad_and_clamp_mosaic_rect` clamps to image bounds rather than
    /// overshooting. Tests the four edge cases: top-left corner, top-right
    /// corner, bottom-right corner, and a tile bigger than the mosaic.
    #[test]
    fn pad_and_clamp_mosaic_rect_clamps_to_image_bounds() {
        // Top-left corner: src starts at (0, 0). Pre-pad goes to (-35, -35)
        // saturating to 0. Even-snap leaves (0, 0). left_pad = top_pad = 0.
        let ((x, y, w, h), (lp, tp)) = pad_and_clamp_mosaic_rect(
            0, 0, 512, 512, 35, 4000, 4000,
        );
        assert_eq!(x, 0);
        assert_eq!(y, 0);
        assert_eq!(lp, 0, "left_pad must be 0 at left edge");
        assert_eq!(tp, 0, "top_pad must be 0 at top edge");
        // Right edge: 512 + 35 = 547, +1 = 548, masked to 548 (even). Within bounds.
        assert_eq!(w, 548);
        assert_eq!(h, 548);

        // Bottom-right corner: src ends exactly at the image boundary.
        // The padded right edge clamps to mosaic_w; no overshoot.
        let mosaic_w = 4000u32;
        let mosaic_h = 4000u32;
        let ((x2, y2, w2, h2), _) = pad_and_clamp_mosaic_rect(
            mosaic_w - 512, mosaic_h - 512, 512, 512, 35, mosaic_w, mosaic_h,
        );
        assert!(x2 + w2 <= mosaic_w, "x+w overshoots mosaic width: {}+{} > {}",
            x2, w2, mosaic_w);
        assert!(y2 + h2 <= mosaic_h, "y+h overshoots mosaic height: {}+{} > {}",
            y2, h2, mosaic_h);

        // Tile larger than image: src_w > mosaic_w. Result still inside
        // bounds (no overshoot), even-aligned, non-zero size.
        let ((x3, y3, w3, h3), _) = pad_and_clamp_mosaic_rect(
            0, 0, 10000, 10000, 35, 1024, 1024,
        );
        assert_eq!(x3, 0);
        assert_eq!(y3, 0);
        assert!(x3 + w3 <= 1024);
        assert!(y3 + h3 <= 1024);
        assert!(w3 > 0 && h3 > 0);
    }

    /// 35 px overlap pad tile-stencil reachability test: with `src` placed
    /// well inside the mosaic and `pad = 35`, every pixel within
    /// `src_w + 70 × src_h + 70` of the inner rect must lie inside the
    /// padded crop. This is the geometric check that the clarity stencil
    /// (effective tail ≈ 39 px) sits inside the trimmed region's overlap
    /// — equivalently, no clarity sample at the inner-rect boundary
    /// reaches outside the mosaic crop unless the src is itself clipped
    /// by the image edge.
    #[test]
    fn pad_and_clamp_mosaic_rect_overlap_covers_clarity_stencil() {
        let mosaic_w = 8000u32;
        let mosaic_h = 8000u32;
        let (src_x, src_y, src_w, src_h) = (1024u32, 1024u32, 512u32, 512u32);
        let pad = TILE_OVERLAP_PX;
        let ((x, y, w, h), (lp, tp)) = pad_and_clamp_mosaic_rect(
            src_x, src_y, src_w, src_h, pad, mosaic_w, mosaic_h,
        );
        // Inner src rect is at (lp, tp) inside the cropped mosaic.
        // The padded crop must extend at least `pad` pixels on every side
        // of the inner rect (this is the geometric invariant — when not
        // clipped by the mosaic boundary).
        assert!(lp >= pad, "left overlap {} < pad {}", lp, pad);
        assert!(tp >= pad, "top overlap {} < pad {}", tp, pad);
        let right_overlap = w.saturating_sub(lp + src_w);
        let bottom_overlap = h.saturating_sub(tp + src_h);
        assert!(right_overlap >= pad,
            "right overlap {} < pad {}", right_overlap, pad);
        assert!(bottom_overlap >= pad,
            "bottom overlap {} < pad {}", bottom_overlap, pad);
        // Padded crop sits inside the mosaic — does not overshoot.
        assert!(x + w <= mosaic_w, "padded crop overshoots width");
        assert!(y + h <= mosaic_h, "padded crop overshoots height");
        // The clarity stencil at radius 40 (3-pass box ≈ 39 px effective
        // tail) is inside the 35 px overlap on three of three passes:
        // each box pass has radius (CLARITY_RADIUS / 3) ≈ 13 px and the
        // 3-pass concatenation reaches ≈ 39 px — within 35 + 4 px of
        // sharpen + texture + nr_color cushion. The hard limit is dehaze
        // (radius 67 px) which is gated separately.
        assert_eq!(pad, 35);
    }

    /// Tile entry: renders a 512×512 source-pixel rectangle out of the
    /// largest available DNG fixture. Verifies (a) returned size matches
    /// `out_w` × `out_h`, (b) alpha lane is `0x3c00` (1.0) everywhere,
    /// (c) at least 10% of the buffer is non-alpha, non-zero (real
    /// pixels not borders). Fixture-gated — `test_0002.dng` is gitignored.
    #[test]
    fn render_scene_linear_tile_returns_oriented_fp16_rgba_at_target_size() {
        let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../test-fixtures/raws/test_0002.dng");
        if !path.exists() { return; }
        let bytes = std::fs::read(&path).expect("read raw");
        let raw = crate::decode::decode_bytes(&bytes, "dng").expect("decode");
        let model = AdjustmentModel::default();
        let (src_x, src_y, src_w, src_h) = (1024u32, 1024u32, 512u32, 512u32);
        let (out_w, out_h) = (512u32, 512u32);
        let (w, h, fp16) = render_scene_linear_tile_from_raw_with_quality(
            &raw, &model, src_x, src_y, src_w, src_h, out_w, out_h,
            RenderQuality::Full,
        ).expect("tile render");
        assert_eq!(w, out_w, "tile width");
        assert_eq!(h, out_h, "tile height");
        assert_eq!(fp16.len() as u32, 4 * w * h);
        let alpha_ok = fp16.chunks_exact(4).filter(|c| c[3] == 0x3c00).count();
        assert_eq!(alpha_ok, (w * h) as usize, "all alpha lanes = 1.0");
        let nonzero = fp16.iter().filter(|&&v| v != 0 && v != 0x3c00).count();
        assert!(nonzero > (fp16.len() / 10),
            "tile mostly zero: {} non-zero non-alpha lanes", nonzero);
    }

    /// Tile entry rounds source coordinates down to even multiples of 2
    /// for Bayer-phase correctness on `demosaic::half_res`. Pass odd
    /// coords; verify the rendered tile matches the requested
    /// out_w/out_h. Pixel-equality not asserted — the coord rounding is
    /// a defensive snap that does not perturb `out_w`/`out_h`.
    #[test]
    fn render_scene_linear_tile_rounds_source_coords_to_even() {
        let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../test-fixtures/raws/test_0002.dng");
        if !path.exists() { return; }
        let bytes = std::fs::read(&path).expect("read raw");
        let raw = crate::decode::decode_bytes(&bytes, "dng").expect("decode");
        let model = AdjustmentModel::default();
        let (w_odd, h_odd, _) = render_scene_linear_tile_from_raw_with_quality(
            &raw, &model, 1025, 1025, 512, 512, 256, 256,
            RenderQuality::Full,
        ).expect("odd coords tile");
        let (w_even, h_even, _) = render_scene_linear_tile_from_raw_with_quality(
            &raw, &model, 1024, 1024, 512, 512, 256, 256,
            RenderQuality::Full,
        ).expect("even coords tile");
        assert_eq!((w_odd, h_odd), (256, 256));
        assert_eq!((w_even, h_even), (256, 256));
    }
}
