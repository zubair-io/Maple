//! `AutoLateralCa` — the profile-free lateral chromatic-aberration switch
//! (#3411). Split out of `adjustment/mod.rs` to stay under the 600-LOC hard
//! budget (#1181), mirroring `hot_pixel_suppression.rs`.

/// Profile-free lateral chromatic-aberration correction (#3411).
///
/// Pre-demosaic, raw-domain: the red and blue mosaic planes are matched
/// against green by a radial Lucas–Kanade displacement estimate over a
/// block grid, a low-order odd radial polynomial is fitted per channel,
/// and the two planes are resampled toward green — see
/// `stages::lateral_ca`. Nothing is measured from a lens profile, so it
/// works on the CR2 / RAF / ARW / NEF bodies the DNG `WarpRectilinear`
/// path can never reach.
///
/// Default is `Off`, matching Adobe: ACR's "Remove Chromatic Aberration"
/// checkbox ships unticked, and its `crs:AutoLateralCA` key is absent from
/// a sidecar that never touched it. `Off` is a bit-identical skip — the
/// mosaic is not read, let alone written.
///
/// The stage additionally self-skips on a RAW whose `OpcodeList3` already
/// carries per-plane `WarpRectilinear` coefficients (the vendor encoded
/// the CA itself; `RawImage::lens_correction_ca_inert()` is false there),
/// so switching this on can never double-correct.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AutoLateralCa {
    /// Skip the stage entirely (default) — bit-identical decode.
    Off,
    /// Estimate and remove lateral CA from the mosaic before demosaic.
    On,
}

impl Default for AutoLateralCa {
    fn default() -> Self {
        Self::Off
    }
}
