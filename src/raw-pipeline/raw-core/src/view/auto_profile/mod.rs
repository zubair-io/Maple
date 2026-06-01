//! Auto Profile — per-image tone curve fit from the embedded JPEG preview.
//!
//! Spec: docs/superpowers/specs/2026-05-26-auto-profile-and-auto-setting-design.md

pub mod curve;
pub mod preview;

pub use curve::{eval_channel, fit_channel_curve, ChannelCurve, ProfileCurve};

use std::path::Path;

/// Apply a per-channel `ProfileCurve` to a packed RGB f32 buffer in place.
///
/// Buffer layout: row-major `[R, G, B, R, G, B, ...]`. Each channel is
/// independently mapped through its `ChannelCurve` via linear interpolation
/// (see `curve::eval_channel`). Out-of-range inputs are clamped to `[0, 1]`.
pub fn apply_curve(rgb: &mut [f32], curve: &ProfileCurve) {
    for chunk in rgb.chunks_exact_mut(3) {
        chunk[0] = curve::eval_channel(&curve.r, chunk[0]);
        chunk[1] = curve::eval_channel(&curve.g, chunk[1]);
        chunk[2] = curve::eval_channel(&curve.b, chunk[2]);
    }
}

/// Fit a [`ProfileCurve`] from a RAW file's embedded JPEG preview against
/// Maple's post-AgX, post-gamut, post-gamma-encode display buffer.
///
/// `source_rgb` is the caller's interleaved RGB f32 buffer in **f32
/// sRGB-encoded display space** — i.e. the pipeline state immediately
/// before `dither_and_quantize`, which is the same domain L2.5 (#527)
/// moved the empirical Look LUT into. Laid out as
/// `[r, g, b, r, g, b, ...]` with values nominally in `[0, 1]`.
///
/// The fitted curves map this distribution onto the JPEG preview's
/// distribution (also in f32 sRGB-encoded display space — the JPEG is
/// already sRGB-encoded, we just divide by 255 to land in `[0, 1]`).
///
/// Both source and target live in the same domain by construction, so
/// the fit is a delta from AgX-Neutral toward the camera JPEG, not a
/// wholesale view-transform replacement. This is the pipeline-shape fix
/// for #550 — pre-#550 the curve fit happened in linear Rec.2020 and
/// REPLACED AgX, which (a) threw away AgX's hue-restoring sigmoid and
/// (b) double-counted exposure normalisation (auto_exposure + JPEG
/// curve fit).
///
/// Returns `None` if:
/// - JPEG extraction fails (file missing, format unsupported, decoder stub)
/// - Preview is too small (< 256 px on either edge)
/// - Preview's histogram is degenerate (>99% of pixels in one of 64 bins)
///
/// Callers fall back to identity (= AgX-Neutral output) on `None`.
pub fn fit_curve_from_raw<P: AsRef<Path>>(
    raw_path: P,
    source_rgb: &[f32],
    source_w: usize,
    source_h: usize,
) -> Option<ProfileCurve> {
    let preview = preview::extract_preview(raw_path)?;
    let preview_rgb = preview.to_rgb8();
    if preview_rgb.width() < 256 || preview_rgb.height() < 256 {
        return None;
    }

    let target_srgb = jpeg_to_f32_srgb(&preview_rgb);

    if is_degenerate_histogram(&target_srgb) {
        return None;
    }

    let src_r: Vec<f32> = source_rgb.iter().step_by(3).copied().collect();
    let src_g: Vec<f32> = source_rgb.iter().skip(1).step_by(3).copied().collect();
    let src_b: Vec<f32> = source_rgb.iter().skip(2).step_by(3).copied().collect();
    let tgt_r: Vec<f32> = target_srgb.iter().step_by(3).copied().collect();
    let tgt_g: Vec<f32> = target_srgb.iter().skip(1).step_by(3).copied().collect();
    let tgt_b: Vec<f32> = target_srgb.iter().skip(2).step_by(3).copied().collect();

    // Reserved for future spatial-aware fitting (e.g. region-weighted CDFs).
    let _ = (source_w, source_h);

    Some(ProfileCurve {
        r: curve::fit_channel_curve(&src_r, &tgt_r),
        g: curve::fit_channel_curve(&src_g, &tgt_g),
        b: curve::fit_channel_curve(&src_b, &tgt_b),
    })
}

/// Convert an sRGB 8-bit JPEG buffer to interleaved f32 sRGB-encoded RGB
/// in `[0, 1]`. Identity transform — just `byte / 255.0` per lane.
///
/// Per #550 the curve fit lives in f32 sRGB-encoded display space (same
/// domain L2.5 moved the Look LUT into), so the JPEG — which is already
/// sRGB-encoded by definition — needs no inverse OETF and no Rec.2020
/// matrix. Maple's source buffer is in the same domain by construction
/// (post-AgX → rec2020_to_srgb → srgb_gamma_encode), making the fit a
/// like-for-like distribution match.
fn jpeg_to_f32_srgb(jpeg: &image::RgbImage) -> Vec<f32> {
    jpeg.as_raw().iter().map(|&b| b as f32 / 255.0).collect()
}

/// Reject preview JPEGs whose distribution is concentrated in a single
/// 64-bin bucket (>99% of pixels). Such images carry no useful
/// per-channel curve signal — pure-black, pure-white, or near-uniform
/// previews.
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

#[cfg(test)]
mod tests;
