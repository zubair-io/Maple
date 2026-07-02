//! Display-space fit path (#550).
//!
//! Fits in **f32 sRGB-encoded display space** (post-AgX → `rec2020_to_srgb`
//! → `srgb_gamma_encode`) — the same domain the empirical Look LUT (#519)
//! samples in. AgX runs unconditionally; the fitted per-channel curve layers
//! ON TOP of it as a tone residual toward the camera JPEG, not a view-
//! transform replacement.
//!
//! ## Fit objective: per-band mean bias, fitted directly (the metric)
//!
//! The T8 gate (`src/scripts/auto_profile_diff.py`) measures **per-luma-band
//! mean bias**: it spatially pairs the rendered candidate against the embedded
//! JPEG, bins every pixel by the JPEG's Rec.709 luma into 5 bands, and for
//! each band × channel requires `mean(candidate) − mean(jpeg)` within ±0.05.
//!
//! An earlier revision fitted a per-channel **CDF / histogram match** — it
//! minimised *distributional* distance, a different objective from the gate's
//! *per-band mean bias*. A CDF match can (and did) freely INCREASE per-band
//! mean bias: it regressed the gate (6/9 → 3/12). The fix is to fit the
//! gate's own objective directly.
//!
//! This module owns the I/O + geometry; [`super::solve`] owns the math:
//! 1. Orient BOTH the source buffer and the embedded JPEG into DISPLAY frame
//!    (both are sensor-frame at the fit stage; the render pipeline applies
//!    orientation AFTER this stage, and `extract-preview` now orients the
//!    preview too) so source pixel `(x, y)` pairs with JPEG pixel `(x, y)` the
//!    same way the gate pairs the final display render against the preview.
//! 2. Aspect-crop, then build the EXACT eval-then-box per-channel design
//!    matrices (`solve::build_design_matrices`) and per-band targets
//!    (`solve::band_targets`).
//! 3. Solve the Chebyshev (minimax) monotone curve per channel
//!    (`solve::solve_minimax_monotone`).
//!
//! Consequences of the display-space domain:
//! - The JPEG target is already sRGB-encoded, decoded via `byte / 255.0` —
//!   no inverse OETF, no Rec.2020 primary conversion.
//! - `compress_input` is inert (both ends bounded to `[0, 1]`).
//! - The cross-channel matrix and Oklab corrections are dropped: AgX owns
//!   chroma + cross-channel coupling now, and the Oklab corrections require
//!   LINEAR Rec.2020 — they are INVALID on gamma-encoded sRGB-primary data.
//!   The curve carries only a per-channel tone residual.
//!
//! Spec: docs/superpowers/specs/2026-05-26-auto-profile-and-auto-setting-design.md

use std::borrow::Cow;
use std::path::Path;

use image::DynamicImage;

use crate::color::matrices::bradford_adapt;
use crate::color::oklab::srgb_linear_to_oklab;
use crate::image::ExifOrientation;
use crate::math::Matrix3;

use super::curve::ProfileCurve;
use super::preview;
use super::solve::{self, LUMA_BANDS};

/// Fit a [`ProfileCurve`] from a RAW file's embedded JPEG preview against
/// Maple's post-AgX, sRGB-gamma-encoded display buffer.
///
/// `source_rgb` is the caller's interleaved RGB f32 buffer in **f32
/// sRGB-encoded display space** — the pipeline state immediately after
/// `srgb_gamma_encode` (= [`crate::image::ColorSpace::DisplayEncodedSrgb`]),
/// laid out as `[r, g, b, r, g, b, ...]` with values nominally in `[0, 1]`.
///
/// Returns `None` when extraction fails, the preview is < 256 px on either
/// edge, or its histogram is degenerate (>99% of pixels in one of 64 bins).
/// Callers fall back to identity (= AgX-Neutral output) on `None`.
pub fn fit_curve_from_raw_display<P: AsRef<Path>>(
    raw_path: P,
    source_rgb: &[f32],
    source_w: usize,
    source_h: usize,
    orientation: ExifOrientation,
) -> Option<ProfileCurve> {
    let p = preview::extract_for_fit(raw_path.as_ref())?;
    fit_curve_from_preview_display(
        p.image,
        p.color_space,
        source_rgb,
        source_w,
        source_h,
        orientation,
    )
}

/// Bytes-based mirror of [`fit_curve_from_raw_display`] for the WASM render
/// entry. Uses [`preview::extract_preview_from_bytes`] (no exiftool fallback).
///
/// `ext` is the file extension (e.g. `"dng"`) used as a rawler format hint.
pub fn fit_curve_from_bytes_display(
    raw_bytes: &[u8],
    ext: &str,
    source_rgb: &[f32],
    source_w: usize,
    source_h: usize,
    orientation: ExifOrientation,
) -> Option<ProfileCurve> {
    let p = preview::extract_for_fit_from_bytes(raw_bytes, ext)?;
    fit_curve_from_preview_display(
        p.image,
        p.color_space,
        source_rgb,
        source_w,
        source_h,
        orientation,
    )
}

/// Fit from an ALREADY-extracted preview (#1085 — extract once, thread the
/// decoded preview + detected color space through every fit; the path/bytes
/// wrappers above stay as the extract-and-fit conveniences for tests).
/// `preview` is the SENSOR-oriented embedded JPEG; this fn rotates it (and
/// the source buffer) into the display frame itself.
pub fn fit_curve_from_preview_display(
    preview: DynamicImage,
    cs: preview::JpegColorSpace,
    sensor_rgb: &[f32],
    sensor_w: usize,
    sensor_h: usize,
    orientation: ExifOrientation,
) -> Option<ProfileCurve> {
    // CRITICAL — orientation alignment. Both the embedded JPEG and the source
    // buffer (`scene.pixels` at the auto_profile stage, which runs BEFORE
    // `apply_orientation` in the render pipeline) are SENSOR-oriented here. The
    // gate diffs Maple's final render (DISPLAY) against the display-oriented
    // preview (`extract-preview` rotates it). So rotate BOTH into display
    // orientation before pairing; without this, any rotated/flipped fixture
    // pairs scrambled pixels, the per-band correlation goes flat, and the
    // monotone fit collapses to identity (the test_0013 Rotate90 symptom).
    let preview = preview::orient_preview_to_display(preview, orientation);
    let preview_rgb = preview.to_rgb8();
    let target_w_px = preview_rgb.width() as usize;
    let target_h_px = preview_rgb.height() as usize;
    if target_w_px < 256 || target_h_px < 256 {
        return None;
    }

    // JPEG → f32 sRGB-encoded [0, 1]. The preview is already sRGB-encoded
    // (8-bit display data); the curve fit lives in the same domain as the
    // source after `srgb_gamma_encode`, so the only transform needed is
    // `byte / 255.0` per lane — no inverse OETF, no primary conversion.
    let mut target: Vec<f32> = preview_rgb
        .as_raw()
        .iter()
        .map(|&b| b as f32 / 255.0)
        .collect();

    if cs == preview::JpegColorSpace::AdobeRgb {
        for chunk in target.chunks_exact_mut(3) {
            let srgb = preview::decode_jpeg_pixel_to_srgb([chunk[0], chunk[1], chunk[2]], cs);
            chunk[0] = srgb[0];
            chunk[1] = srgb[1];
            chunk[2] = srgb[2];
        }
    }

    if is_degenerate_histogram(&target) {
        return None;
    }

    // `Normal` (the common case, e.g. the 100MP test_0000) borrows the source
    // buffer without a 1.2 GB clone; rotated/flipped fixtures allocate the
    // re-oriented copy. The fit is a cold-path (cached after the first tick),
    // but the Normal clone was pure waste against the no-render-loop-alloc rule.
    let (source_w, source_h, mut oriented) =
        orient_rgb_f32_to_display(sensor_rgb, sensor_w, sensor_h, orientation);
    let source_rgb: &[f32] = &oriented;

    // Match aspect by centre-cropping the wider axis of whichever buffer is
    // wider. Embedded JPEGs are sensor-aligned on every verified fixture, so
    // both buffers share a coordinate frame after the crop removes the
    // letterbox/pillarbox framing difference.
    let target_aspect = target_w_px as f64 / target_h_px as f64;
    let source_aspect = source_w as f64 / source_h as f64;
    let (crop_x_start, crop_x_end, crop_y_start, crop_y_end) =
        if (source_aspect - target_aspect).abs() < 0.01 {
            (0, source_w, 0, source_h)
        } else if source_aspect > target_aspect {
            let new_w = (source_h as f64 * target_aspect).round() as usize;
            let crop_x = (source_w - new_w) / 2;
            (crop_x, crop_x + new_w, 0, source_h)
        } else {
            let new_h = (source_w as f64 / target_aspect).round() as usize;
            let crop_y = (source_h - new_h) / 2;
            (0, source_w, crop_y, crop_y + new_h)
        };
    let crop_w = crop_x_end - crop_x_start;
    let crop_h = crop_y_end - crop_y_start;
    if crop_w == 0 || crop_h == 0 {
        return None;
    }

    let n = target.len() / 3;
    if n == 0 {
        return None;
    }

    // Bin each JPEG pixel by its luma into the gate's 5 bands, and record the
    // footprint size of every JPEG pixel (the count of full-res source pixels
    // that downscale into it). Footprints differ by ±1px under a non-integer
    // ratio; the gate weights each JPEG pixel EQUALLY, so each source pixel's
    // contribution is divided by ITS footprint size (in `solve`), not by a raw
    // source-pixel count — which would footprint-weight the band mean.
    let mut band_of = vec![usize::MAX; n];
    let mut band_counts = [0usize; LUMA_BANDS.len()];
    let border_w = (target_w_px as f64 * 0.1).round() as usize;
    let border_h = (target_h_px as f64 * 0.1).round() as usize;
    for oy in 0..target_h_px {
        let is_border_y = oy < border_h || oy >= target_h_px - border_h;
        let row_offset = oy * target_w_px;
        for ox in 0..target_w_px {
            let j = row_offset + ox;
            if is_border_y || ox < border_w || ox >= target_w_px - border_w {
                continue;
            }
            let luma =
                0.2126 * target[j * 3] + 0.7152 * target[j * 3 + 1] + 0.0722 * target[j * 3 + 2];
            if let Some(b) = solve::band_index(luma) {
                band_of[j] = b;
                band_counts[b] += 1;
            }
        }
    }
    let footprint = solve::footprint_sizes(crop_w, crop_h, target_w_px, target_h_px);

    // Estimate chromatic adaptation matrix adapt_srgb:
    let adapt_srgb = estimate_chromatic_adaptation(
        source_rgb,
        source_w,
        crop_x_start,
        crop_y_start,
        crop_w,
        crop_h,
        &target,
        target_w_px,
        target_h_px,
    );

    // Solve for the parameters of the base curve that maps the scene-linear HDR range to the SDR target range.
    let mut sum_x = [0.0f64; 3];
    let mut sum_y = [0.0f64; 3];
    let mut sum_xy = [0.0f64; 3];
    let mut sum_y2 = [0.0f64; 3];

    for oy in 0..target_h_px {
        let sy0 = (oy * crop_h) / target_h_px;
        let mut sy1 = ((oy + 1) * crop_h) / target_h_px;
        if sy1 <= sy0 {
            sy1 = sy0 + 1;
        }
        let jrow = oy * target_w_px;
        for ox in 0..target_w_px {
            let j = jrow + ox;
            let b = band_of[j];
            if b == usize::MAX {
                continue;
            }
            let sx0 = (ox * crop_w) / target_w_px;
            let mut sx1 = ((ox + 1) * crop_w) / target_w_px;
            if sx1 <= sx0 {
                sx1 = sx0 + 1;
            }

            let t_r = srgb_gamma_decode(target[j * 3]);
            let t_g = srgb_gamma_decode(target[j * 3 + 1]);
            let t_b = srgb_gamma_decode(target[j * 3 + 2]);

            // Skip dark or clipped target pixels to avoid division issues/noise
            if t_r < 0.001 || t_g < 0.001 || t_b < 0.001 {
                continue;
            }
            if t_r > 0.98 || t_g > 0.98 || t_b > 0.98 {
                continue;
            }

            // Average source pixels in the footprint
            let mut fp_sum_r = 0.0;
            let mut fp_sum_g = 0.0;
            let mut fp_sum_b = 0.0;
            let mut fp_count = 0;

            for sy in sy0..sy1 {
                let srow = (crop_y_start + sy) * source_w + crop_x_start;
                for sx in sx0..sx1 {
                    let idx = (srow + sx) * 3;
                    fp_sum_r += srgb_gamma_decode(source_rgb[idx]);
                    fp_sum_g += srgb_gamma_decode(source_rgb[idx + 1]);
                    fp_sum_b += srgb_gamma_decode(source_rgb[idx + 2]);
                    fp_count += 1;
                }
            }

            if fp_count > 0 {
                let fp_count_f = fp_count as f32;
                let s_r = (fp_sum_r / fp_count_f) as f64;
                let s_g = (fp_sum_g / fp_count_f) as f64;
                let s_b = (fp_sum_b / fp_count_f) as f64;

                let t_r_f = t_r as f64;
                let t_g_f = t_g as f64;
                let t_b_f = t_b as f64;

                sum_x[0] += s_r;
                sum_y[0] += t_r_f;
                sum_xy[0] += s_r * t_r_f * (1.0 - t_r_f);
                sum_y2[0] += t_r_f * t_r_f;
                sum_x[1] += s_g;
                sum_y[1] += t_g_f;
                sum_xy[1] += s_g * t_g_f * (1.0 - t_g_f);
                sum_y2[1] += t_g_f * t_g_f;
                sum_x[2] += s_b;
                sum_y[2] += t_b_f;
                sum_xy[2] += s_b * t_b_f * (1.0 - t_b_f);
                sum_y2[2] += t_b_f * t_b_f;
            }
        }
    }

    let mut sig = [1.0f32; 3];
    for c in 0..3 {
        if sum_y2[c] > 1e-5 {
            let val = (sum_xy[c] / sum_y2[c]) as f32;
            sig[c] = val.clamp(0.1, 10.0);
        }
    }

    let sig_r = sig[0];
    let sig_g = sig[1];
    let sig_b = sig[2];

    // Apply the base curve to oriented source pixels in-place
    let oriented_mut = oriented.to_mut();
    for chunk in oriented_mut.chunks_exact_mut(3) {
        let r_lin = srgb_gamma_decode(chunk[0]);
        let g_lin = srgb_gamma_decode(chunk[1]);
        let b_lin = srgb_gamma_decode(chunk[2]);

        chunk[0] = crate::view::encode::srgb_gamma(r_lin / (r_lin + sig_r));
        chunk[1] = crate::view::encode::srgb_gamma(g_lin / (g_lin + sig_g));
        chunk[2] = crate::view::encode::srgb_gamma(b_lin / (b_lin + sig_b));
    }
    let source_rgb: &[f32] = oriented_mut;

    // Build the EXACT eval-then-box per-channel design matrices. The gate
    // computes `candidate_j = (1/|F_j|) Σ_{p∈F_j} eval(curve, src_p)`, then the
    // band mean `B_b = (1/N_b) Σ_{j∈b} candidate_j`. Since `eval` is piecewise-
    // linear, `B_b` is LINEAR in the anchor outputs: `B_b = Σ_a M[b][a]·out[a]`.
    // box-then-eval is the WRONG model — at the ~0.05 margins the Jensen gap is
    // decisive (measured ~0.015 on test_0000).
    let design = solve::build_design_matrices(
        source_rgb,
        source_w,
        crop_x_start,
        crop_y_start,
        crop_w,
        crop_h,
        target_w_px,
        target_h_px,
        &band_of,
        &band_counts,
        &footprint,
        adapt_srgb,
    );
    let band_target = solve::band_targets(&target, &band_of, &band_counts);

    // Fit each channel independently to its own per-band mean targets via the
    // Chebyshev (minimax) monotone solve.
    let r = solve::solve_minimax_monotone(&design[0], &band_target[0], &band_counts);
    let g = solve::solve_minimax_monotone(&design[1], &band_target[1], &band_counts);
    let b = solve::solve_minimax_monotone(&design[2], &band_target[2], &band_counts);

    Some(ProfileCurve {
        r,
        g,
        b,
        // Apply the pre-fit chromatic adaptation matrix on the display path
        matrix: adapt_srgb.0,
        chroma_boost: 1.0,
        chroma_offset: [sig_g, sig_b],
        lightness_offset: sig_r,
        lightness_band_offsets: [0.0; 5],
        ab_band_offsets: [[0.0, 0.0]; 5],
    })
}

/// Orient an interleaved f32 RGB buffer from SENSOR into DISPLAY orientation,
/// reproducing `crate::image::apply_orientation`'s exact per-pixel source
/// mapping (the u8 path the render pipeline uses after the auto_profile stage).
/// Returns `(display_w, display_h, oriented_rgb)`. `Normal` borrows the input
/// (no copy of the potentially 100MP source); other orientations allocate.
pub(super) fn orient_rgb_f32_to_display(
    rgb: &[f32],
    w: usize,
    h: usize,
    orient: ExifOrientation,
) -> (usize, usize, Cow<'_, [f32]>) {
    if orient == ExifOrientation::Normal {
        return (w, h, Cow::Borrowed(rgb));
    }
    let (sw, sh) = (w, h);
    let (dw, dh) = if orient.swaps_wh() { (h, w) } else { (w, h) };
    let mut out = vec![0.0f32; dw * dh * 3];
    for yp in 0..dh {
        for xp in 0..dw {
            let (sx, sy) = match orient {
                ExifOrientation::Normal => (xp, yp),
                ExifOrientation::HorizontalFlip => (sw - 1 - xp, yp),
                ExifOrientation::Rotate180 => (sw - 1 - xp, sh - 1 - yp),
                ExifOrientation::VerticalFlip => (xp, sh - 1 - yp),
                ExifOrientation::Transpose => (yp, xp),
                ExifOrientation::Rotate90 => (yp, sh - 1 - xp),
                ExifOrientation::Transverse => (sw - 1 - yp, sh - 1 - xp),
                ExifOrientation::Rotate270 => (sw - 1 - yp, xp),
            };
            let si = (sy * sw + sx) * 3;
            let di = (yp * dw + xp) * 3;
            out[di] = rgb[si];
            out[di + 1] = rgb[si + 1];
            out[di + 2] = rgb[si + 2];
        }
    }
    (dw, dh, Cow::Owned(out))
}

/// Reject preview JPEGs whose distribution is concentrated in a single
/// 64-bin bucket (>99% of pixels) — pure-black/white or near-uniform
/// previews carry no useful per-channel curve signal.
fn is_degenerate_histogram(rgb: &[f32]) -> bool {
    if rgb.is_empty() {
        return true;
    }
    let n = rgb.len();
    let mut hist = [0_u32; 64];
    for v in rgb {
        let idx = (v.clamp(0.0, 1.0) * 63.0) as usize;
        hist[idx.min(63)] += 1;
    }
    let max_count = *hist.iter().max().unwrap();
    max_count as f32 / n as f32 > 0.99
}

#[inline]
pub fn srgb_gamma_decode(y: f32) -> f32 {
    if y <= 0.04045 {
        y / 12.92
    } else {
        ((y + 0.055) / 1.055).powf(2.4)
    }
}

pub const M_SRGB_TO_XYZ_D65: Matrix3 = Matrix3([
    [0.4124564, 0.3575761, 0.1804375],
    [0.2126729, 0.7151522, 0.0721750],
    [0.0193339, 0.1191920, 0.9503041],
]);

pub const M_XYZ_D65_TO_SRGB: Matrix3 = Matrix3([
    [3.2404542, -1.5371385, -0.4985314],
    [-0.9692660, 1.8760108, 0.0415560],
    [0.0556434, -0.2040259, 1.0572252],
]);

/// Estimate the Bradford chromatic adaptation matrix between the source display buffer
/// and the target JPEG preview based on near-neutral pixels in the cropped region.
pub fn estimate_chromatic_adaptation(
    source_rgb: &[f32],
    source_w: usize,
    crop_x0: usize,
    crop_y0: usize,
    crop_w: usize,
    crop_h: usize,
    target_rgb: &[f32],
    target_w: usize,
    target_h: usize,
) -> Matrix3 {
    let mut sum_src = [0.0f32; 3];
    let mut sum_tgt = [0.0f32; 3];
    let mut count = 0usize;

    // Sample pixels in target JPEG space
    let n = target_rgb.len() / 3;
    let step = (n / 10000).max(1); // sample up to 10k pixels

    for j in (0..n).step_by(step) {
        let ox = j % target_w;
        let oy = j / target_w;

        // Skip border pixels to avoid transition edges / letterboxes
        let border_w = (target_w as f64 * 0.1).round() as usize;
        let border_h = (target_h as f64 * 0.1).round() as usize;
        if ox < border_w || ox >= target_w - border_w || oy < border_h || oy >= target_h - border_h
        {
            continue;
        }

        let tgt_lin = [
            srgb_gamma_decode(target_rgb[j * 3]),
            srgb_gamma_decode(target_rgb[j * 3 + 1]),
            srgb_gamma_decode(target_rgb[j * 3 + 2]),
        ];
        let lab = srgb_linear_to_oklab(tgt_lin);
        let chroma = (lab[1] * lab[1] + lab[2] * lab[2]).sqrt();
        if chroma < 0.02 {
            let sy = (oy * crop_h) / target_h;
            let sx = (ox * crop_w) / target_w;
            let srow = (crop_y0 + sy) * source_w + crop_x0;
            let si = (srow + sx) * 3;
            if si + 2 >= source_rgb.len() {
                continue;
            }

            let src_lin = [
                srgb_gamma_decode(source_rgb[si]),
                srgb_gamma_decode(source_rgb[si + 1]),
                srgb_gamma_decode(source_rgb[si + 2]),
            ];

            sum_src[0] += src_lin[0];
            sum_src[1] += src_lin[1];
            sum_src[2] += src_lin[2];
            sum_tgt[0] += tgt_lin[0];
            sum_tgt[1] += tgt_lin[1];
            sum_tgt[2] += tgt_lin[2];
            count += 1;
        }
    }

    if count >= 100 {
        let count_f = count as f32;
        let mean_src = [
            (sum_src[0] / count_f).max(1e-4),
            (sum_src[1] / count_f).max(1e-4),
            (sum_src[2] / count_f).max(1e-4),
        ];
        let mean_tgt = [
            (sum_tgt[0] / count_f).max(1e-4),
            (sum_tgt[1] / count_f).max(1e-4),
            (sum_tgt[2] / count_f).max(1e-4),
        ];

        let src_xyz = M_SRGB_TO_XYZ_D65.mul_vec(mean_src);
        let tgt_xyz = M_SRGB_TO_XYZ_D65.mul_vec(mean_tgt);

        let adapt_xyz = bradford_adapt(src_xyz, tgt_xyz);
        M_XYZ_D65_TO_SRGB
            .mul_mat(&adapt_xyz)
            .mul_mat(&M_SRGB_TO_XYZ_D65)
    } else {
        Matrix3::IDENTITY
    }
}
