//! Auto Profile — per-image tone curve fit from the embedded JPEG preview.
//!
//! Spec: docs/superpowers/specs/2026-05-26-auto-profile-and-auto-setting-design.md

pub mod curve;
pub mod preview;

pub use curve::{eval_channel, fit_channel_curve, ChannelCurve, ProfileCurve};

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

#[cfg(test)]
mod tests;
