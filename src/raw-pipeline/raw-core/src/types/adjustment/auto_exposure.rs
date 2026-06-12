//! `AutoExposureMode` — per-image auto-exposure toggle.
//!
//! Extracted from `mod.rs` to keep that file under the 600-LOC hard budget
//! (#772). Re-exported as `adjustment::AutoExposureMode`.

/// Per-image auto-exposure mode (ticket #429).
///
/// AgX expects the scene to land at mid-gray 0.18 by default. Without a
/// real anchor, different cameras / scenes land at different points on
/// the AgX sigmoid → inconsistent brightness across bodies. The
/// `auto_exposure` stage measures the scene's mid-tone (geometric mean of
/// luma in the middle 50% percentile band) and applies a scalar gain that
/// pushes it to 0.18 BEFORE AgX. User exposure (`AdjustmentModel::exposure`,
/// applied in `stages::scene_tone_controls`) stacks additively in EV on
/// top: `final_gain = scene_anchor_gain * 2^user_ev`.
///
/// Default is `On`. Users can opt out per-image via
/// `papp:AutoExposure="Off"` in the XMP sidecar — useful for strict
/// scene-referred output where the absolute scene-linear value matters
/// (e.g. matching a reference renderer's exposure exactly).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AutoExposureMode {
    /// Skip scene anchoring — pixels enter AgX at their raw post-DCP scale.
    Off,
    /// Anchor scene mid-gray to 0.18 before AgX (default).
    On,
}

impl Default for AutoExposureMode {
    fn default() -> Self {
        Self::On
    }
}
