//! Auto Profile — per-image tone curve fit from the embedded JPEG preview.
//!
//! Spec: docs/superpowers/specs/2026-05-26-auto-profile-and-auto-setting-design.md
//!
//! Submodules:
//! - [`curve`]: `ProfileCurve` data type + per-channel CDF curve helpers.
//! - [`preview`]: embedded-JPEG extraction + Adobe RGB detection.
//! - [`apply`]: apply path (evaluates the per-channel curve into a packed
//!   RGB buffer in place; the matrix + Oklab correction branches short-
//!   circuit when the curve carries identity/zero values, which the #550
//!   display-space fit always produces — AgX owns chroma + cross-channel
//!   coupling now).
//! - [`fit_display`]: fit path (#550) — builds CDF curves from source/JPEG
//!   distributions in f32 sRGB-encoded display space (post-AgX), returns a
//!   per-channel-only [`curve::ProfileCurve`]. AgX runs unconditionally and
//!   the curve layers on top as a tone residual (vs the retired scene-linear
//!   fit that replaced AgX and carried a matrix + Oklab corrections).
//! - [`cache`]: bounded LRU keyed on `(raw_identity, mtime)` / bytes-hash
//!   that short-circuits the fit on second-and-after slider ticks.

pub mod apply;
pub mod cache;
pub mod curve;
pub mod fit_display;
pub mod preview;

pub use apply::{apply_curve, compress_input};
pub use curve::{eval_channel, fit_channel_curve, ChannelCurve, ProfileCurve, IDENTITY_MATRIX};
pub use fit_display::{fit_curve_from_bytes_display, fit_curve_from_raw_display};
pub use preview::JpegColorSpace;

#[cfg(test)]
mod tests;
