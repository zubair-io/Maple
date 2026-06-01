//! Display-space fit path (#550).
//!
//! Companion to [`super::fit`], which fits in scene-linear Rec.2020 and
//! replaces AgX. This module fits in **f32 sRGB-encoded display space**
//! (post-AgX → `rec2020_to_srgb` → `srgb_gamma_encode`) — the same domain
//! the empirical Look LUT (#519) samples in. AgX still runs unconditionally;
//! the fitted curve layers ON TOP of it as a per-channel tone residual
//! toward the camera JPEG, not a wholesale view-transform replacement.
//!
//! Consequences of the domain change vs `fit`:
//! - The JPEG target is already sRGB-encoded by definition, so it is decoded
//!   via `byte / 255.0` directly — no inverse OETF, no Rec.2020 primary
//!   conversion. Source and target live in the same domain by construction.
//! - `compress_input` (soft-knee for HDR scene-linear values >1.0) is inert
//!   here — both source and target are bounded to `[0, 1]` after the encode —
//!   so it is dropped.
//! - The cross-channel matrix and the Oklab chroma/lightness corrections are
//!   dropped. They were compensation for AgX being absent; with AgX always
//!   on, AgX's hue-restoring sigmoid + ratio-preserving compression own the
//!   chroma/hue base, leaving only a per-channel tone residual for the curve.
//!
//! Spec: docs/superpowers/specs/2026-05-26-auto-profile-and-auto-setting-design.md

use std::path::Path;

use image::DynamicImage;

use crate::image::ExifOrientation;

use super::curve::{self, ProfileCurve, IDENTITY_MATRIX};
use super::preview;

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
    let preview = preview::extract_preview(raw_path.as_ref())?;
    fit_curve_from_preview_display(preview, source_rgb, source_w, source_h, orientation)
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
    let preview = preview::extract_preview_from_bytes(raw_bytes, ext)?;
    fit_curve_from_preview_display(preview, source_rgb, source_w, source_h, orientation)
}

fn fit_curve_from_preview_display(
    preview: DynamicImage,
    source_rgb: &[f32],
    source_w: usize,
    source_h: usize,
    _orientation: ExifOrientation,
) -> Option<ProfileCurve> {
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
    let target: Vec<f32> = preview_rgb.as_raw().iter().map(|&b| b as f32 / 255.0).collect();

    if is_degenerate_histogram(&target) {
        return None;
    }

    // Match aspect by centre-cropping the LARGER-AR axis of whichever buffer
    // is wider, identical to `fit`. Embedded JPEGs are sensor-aligned on
    // every verified fixture, so both buffers share a coordinate frame; the
    // crop only removes the letterbox/pillarbox difference in framing.
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
    let n_pixels = crop_w * crop_h;

    // Per-channel source samples in the crop. No `compress_input`: source
    // is sRGB-encoded display data in [0, 1], so the soft-knee that `fit`
    // uses for HDR scene-linear values >1.0 would be a no-op here.
    let mut src_r = Vec::with_capacity(n_pixels);
    let mut src_g = Vec::with_capacity(n_pixels);
    let mut src_b = Vec::with_capacity(n_pixels);
    for y in crop_y_start..crop_y_end {
        let row_off = y * source_w;
        for x in crop_x_start..crop_x_end {
            let idx = (row_off + x) * 3;
            src_r.push(source_rgb[idx]);
            src_g.push(source_rgb[idx + 1]);
            src_b.push(source_rgb[idx + 2]);
        }
    }
    let mut tgt_r = Vec::with_capacity(target.len() / 3);
    let mut tgt_g = Vec::with_capacity(target.len() / 3);
    let mut tgt_b = Vec::with_capacity(target.len() / 3);
    for c in target.chunks_exact(3) {
        tgt_r.push(c[0]);
        tgt_g.push(c[1]);
        tgt_b.push(c[2]);
    }

    // Blend per-channel CDF curves with a single luminance CDF curve, same
    // α=0.2 trade `fit` uses: the luminance curve owns most of the tone
    // (smoother, less contrasty side-by-side with the JPEG), the per-channel
    // curves contribute channel-specific colour shaping at 20%.
    const BLEND_ALPHA: f32 = 0.2;
    let src_lum = luma(&src_r, &src_g, &src_b);
    let tgt_lum = luma(&tgt_r, &tgt_g, &tgt_b);
    let lum_curve = curve::fit_channel_curve(&src_lum, &tgt_lum);
    let pc_r = curve::fit_channel_curve(&src_r, &tgt_r);
    let pc_g = curve::fit_channel_curve(&src_g, &tgt_g);
    let pc_b = curve::fit_channel_curve(&src_b, &tgt_b);

    Some(ProfileCurve {
        r: blend(&pc_r, &lum_curve, BLEND_ALPHA),
        g: blend(&pc_g, &lum_curve, BLEND_ALPHA),
        b: blend(&pc_b, &lum_curve, BLEND_ALPHA),
        // AgX owns chroma/hue/cross-channel coupling now; the display-space
        // residual is a pure per-channel tone delta.
        matrix: IDENTITY_MATRIX,
        chroma_boost: 1.0,
        chroma_offset: [0.0, 0.0],
        lightness_offset: 0.0,
        lightness_band_offsets: [0.0; 5],
        ab_band_offsets: [[0.0, 0.0]; 5],
    })
}

/// Rec.709 luma of three same-length channel slices.
fn luma(r: &[f32], g: &[f32], b: &[f32]) -> Vec<f32> {
    r.iter()
        .zip(g.iter())
        .zip(b.iter())
        .map(|((&r, &g), &b)| 0.2126 * r + 0.7152 * g + 0.0722 * b)
        .collect()
}

/// Blend a per-channel curve toward a luminance curve at weight `alpha`
/// (alpha=1 → pure per-channel, alpha=0 → pure luminance), re-enforcing
/// monotone outputs after the blend.
fn blend(pc: &curve::ChannelCurve, lum: &curve::ChannelCurve, alpha: f32) -> curve::ChannelCurve {
    let mut anchors = [(0.0_f32, 0.0_f32); 32];
    for i in 0..32 {
        anchors[i].0 = pc.anchors[i].0;
        anchors[i].1 = alpha * pc.anchors[i].1 + (1.0 - alpha) * lum.anchors[i].1;
    }
    for i in 1..32 {
        if anchors[i].1 < anchors[i - 1].1 {
            anchors[i].1 = anchors[i - 1].1;
        }
    }
    curve::ChannelCurve { anchors }
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
