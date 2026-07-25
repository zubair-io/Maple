//! `WbMethod` — the user white-balance method, plus the #1729 anchoring
//! semantics its doc comment pins.
//!
//! Extracted from `mod.rs` to keep that file under the 600-LOC hard budget
//! (#772), the same split already applied to `AutoExposureMode`,
//! `HotPixelSuppressionMode`, `BlackWhiteMode` and `Crop`. Moved verbatim —
//! re-exported as `adjustment::WbMethod`.

/// User white-balance method (ticket #431).
///
/// Both methods consume the same `(temperature, tint)` UI pair; they
/// differ only in the math applied to the working buffer:
///
/// - [`WbMethod::Cat16`] (default since #431): proper chromatic
///   adaptation. The buffer is transformed Rec.2020 → XYZ → LMS via the
///   CAT16 cone matrix (Li et al. 2017), scaled per-cone by
///   `LMS(D65) / LMS(source)`, then transformed back. Neutrals stay
///   neutral across the slider range and the +/-1000K asymmetry the
///   diagonal-gain path exhibits collapses to ~1.0. Matches Darktable's
///   `iop/channelmixerrgb.c` default. Tint sign follows the
///   reference-renderer convention: tint+ = magenta image, tint- = green.
/// - [`WbMethod::DiagonalRec2020`]: legacy von-Kries approximation —
///   per-channel diagonal gains in linear Rec.2020 derived from
///   D65/source. Kept for parity A/B comparison; introduces hue error
///   at extreme WB. Tint sign was inverted vs the reference renderer
///   (tint+ = green) — preserved as-is to keep pre-#431 outputs
///   bit-identical when this mode is selected explicitly.
///
/// **Anchoring (#1729).** ACR's semantics for `crs:WhiteBalance="Custom"` with
/// only one of `crs:Temperature` / `crs:Tint` set: the absent component
/// stays at the image's as-shot value (the camera's AsShotNeutral-derived
/// CCT / tint), NOT at the slider's neutral default (6500 K / 0). The
/// `temperature_seen` / `tint_seen` flags below signal which components were
/// explicitly written in the XMP sidecar so the develop pipeline can
/// substitute the as-shot value for absent ones. Both flags default to
/// `false`; the XMP parser sets them on parse; the `AdjustmentModel::default()`
/// (no sidecar) path keeps them false so the develop pipeline leaves WB at
/// the caller-supplied as-shot values in that case too.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WbMethod {
    /// CAT16 cone-space chromatic adaptation (default).
    Cat16,
    /// Legacy diagonal per-channel gains in linear Rec.2020.
    DiagonalRec2020,
}

impl Default for WbMethod {
    fn default() -> Self {
        Self::Cat16
    }
}
