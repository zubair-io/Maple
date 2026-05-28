//! Auto Profile — per-image tone curve fit from the embedded JPEG preview.
//!
//! Spec: docs/superpowers/specs/2026-05-26-auto-profile-and-auto-setting-design.md
//!
//! Submodules:
//! - [`curve`]: `ProfileCurve` data type + per-channel CDF curve helpers.
//! - [`preview`]: embedded-JPEG extraction + Adobe RGB detection.
//! - [`apply`]: apply path (compresses input, evaluates the curve, applies
//!   matrix + Oklab corrections to a packed RGB buffer in place).
//! - [`matrix`]: constrained 3×3 LSQ for the per-image cross-channel
//!   correction matrix.
//! - [`fit`]: fit path (builds CDF curves from source/JPEG distributions,
//!   fits matrix + Oklab offsets, returns a [`curve::ProfileCurve`]).

pub mod apply;
pub mod curve;
pub mod fit;
pub mod matrix;
pub mod preview;

pub use apply::{apply_curve, compress_input};
pub use curve::{eval_channel, fit_channel_curve, ChannelCurve, ProfileCurve, IDENTITY_MATRIX};
pub use fit::{fit_curve_from_bytes, fit_curve_from_raw};
pub use preview::JpegColorSpace;

#[cfg(test)]
mod tests;
