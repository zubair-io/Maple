//! Auto Profile — per-image tone curve fit from the embedded JPEG preview.
//!
//! Spec: docs/superpowers/specs/2026-05-26-auto-profile-and-auto-setting-design.md

pub mod curve;
pub mod preview;

pub use curve::{eval_channel, fit_channel_curve, ChannelCurve, ProfileCurve};

#[cfg(test)]
mod tests;
