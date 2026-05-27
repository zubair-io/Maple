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
/// Maple's intermediate linear Rec.2020 RGB buffer.
///
/// `source_rgb` is the caller's interleaved RGB f32 buffer in linear
/// Rec.2020 — i.e. the pipeline state just before the view transform —
/// laid out as `[r, g, b, r, g, b, ...]`. The fitted curves map this
/// distribution onto the JPEG preview's distribution (also in linear
/// Rec.2020 after sRGB decode + primary conversion).
///
/// Returns `None` if:
/// - JPEG extraction fails (file missing, format unsupported, decoder stub)
/// - Preview is too small (< 256 px on either edge)
/// - Preview's histogram is degenerate (>99% of pixels in one of 64 bins)
///
/// Callers fall back to AgX-Neutral on `None`.
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

    let target_rec2020 = jpeg_to_linear_rec2020(&preview_rgb);

    if is_degenerate_histogram(&target_rec2020) {
        return None;
    }

    let src_r: Vec<f32> = source_rgb.iter().step_by(3).copied().collect();
    let src_g: Vec<f32> = source_rgb.iter().skip(1).step_by(3).copied().collect();
    let src_b: Vec<f32> = source_rgb.iter().skip(2).step_by(3).copied().collect();
    let tgt_r: Vec<f32> = target_rec2020.iter().step_by(3).copied().collect();
    let tgt_g: Vec<f32> = target_rec2020.iter().skip(1).step_by(3).copied().collect();
    let tgt_b: Vec<f32> = target_rec2020.iter().skip(2).step_by(3).copied().collect();

    // Reserved for future spatial-aware fitting (e.g. region-weighted CDFs).
    let _ = (source_w, source_h);

    Some(ProfileCurve {
        r: curve::fit_channel_curve(&src_r, &tgt_r),
        g: curve::fit_channel_curve(&src_g, &tgt_g),
        b: curve::fit_channel_curve(&src_b, &tgt_b),
    })
}

/// Convert an sRGB 8-bit JPEG buffer to interleaved linear Rec.2020 f32 RGB.
///
/// Pipeline: inverse sRGB EOTF per channel → BT.709 (sRGB linear) → BT.2020
/// RGB (D65) via the standard 3×3 (CIE-D65 chromatic adaptation already baked
/// into the matrix coefficients).
fn jpeg_to_linear_rec2020(jpeg: &image::RgbImage) -> Vec<f32> {
    // BT.709 (sRGB linear) → BT.2020 RGB (D65), standard matrix:
    const SRGB_TO_REC2020: [[f32; 3]; 3] = [
        [0.6274039, 0.3292830, 0.0433131],
        [0.0690973, 0.9195404, 0.0113623],
        [0.0163914, 0.0880133, 0.8955953],
    ];

    let raw = jpeg.as_raw();
    let mut out = Vec::with_capacity(raw.len());
    for chunk in raw.chunks_exact(3) {
        let r_lin = srgb_decode(chunk[0] as f32 / 255.0);
        let g_lin = srgb_decode(chunk[1] as f32 / 255.0);
        let b_lin = srgb_decode(chunk[2] as f32 / 255.0);

        let r = SRGB_TO_REC2020[0][0] * r_lin
            + SRGB_TO_REC2020[0][1] * g_lin
            + SRGB_TO_REC2020[0][2] * b_lin;
        let g = SRGB_TO_REC2020[1][0] * r_lin
            + SRGB_TO_REC2020[1][1] * g_lin
            + SRGB_TO_REC2020[1][2] * b_lin;
        let b = SRGB_TO_REC2020[2][0] * r_lin
            + SRGB_TO_REC2020[2][1] * g_lin
            + SRGB_TO_REC2020[2][2] * b_lin;

        out.push(r);
        out.push(g);
        out.push(b);
    }
    out
}

/// Inverse sRGB EOTF — display-encoded sRGB to linear-light. IEC 61966-2-1.
///
/// A private mirror of `color::hsm::srgb_to_linear_one` to keep the
/// `auto_profile` module independent of color-module internals. Identical
/// math — the duplication is intentional until a shared crate-level helper
/// is introduced.
#[inline]
fn srgb_decode(v: f32) -> f32 {
    if v <= 0.04045 {
        v / 12.92
    } else {
        ((v + 0.055) / 1.055).powf(2.4)
    }
}

/// Reject preview JPEGs whose linear-Rec.2020 distribution is concentrated
/// in a single 64-bin bucket (>99% of pixels). Such images carry no useful
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
