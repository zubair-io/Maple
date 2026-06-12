//! `HotPixelSuppressionMode` enum — split out of `adjustment/mod.rs` to
//! stay under the 600-LOC hard budget (#1181).

/// Hot/dead-pixel suppression mode (#1106, tone/zoom design spec § 10.6).
///
/// Pre-demosaic, raw-domain: each CFA site is compared against its
/// same-color neighbors; outliers (`v > k·max + τ` hot, `v < k'·min`
/// dead/stuck-low) are replaced with the same-color neighborhood median.
/// Runs inside the decode product — zero per-tick cost, and exactly
/// identity on the synthetic grey card by construction (a uniform field
/// can never trip either predicate).
///
/// Default is `Off` (bit-identical skip) until a § 3.1-style harness
/// sweep shows enabling is free on clean fixtures. Users opt in per-image
/// via `papp:HotPixelSuppression="On"`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HotPixelSuppressionMode {
    /// Skip the stage entirely (default) — bit-identical decode.
    Off,
    /// Detect and median-replace hot/dead CFA sites before demosaic.
    On,
}

impl Default for HotPixelSuppressionMode {
    fn default() -> Self {
        Self::Off
    }
}
