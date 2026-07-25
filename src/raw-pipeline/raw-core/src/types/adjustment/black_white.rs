//! `BlackWhiteMode` — the black-and-white conversion toggle (#276).
//!
//! Extracted from `mod.rs` to keep that file under the 600-LOC hard budget,
//! the same split as `auto_exposure.rs`. Re-exported as
//! `adjustment::BlackWhiteMode`.

/// Black-and-white conversion mode (ticket #276).
///
/// `On` routes the 8-band Oklab stage into its monochrome path: the eight
/// `gray_mixer_*` sliders become per-hue-band luminance weights that drive
/// the `L` plane, and chroma is forced to zero for **every** pixel — the
/// "saturation forced to 0" half of the ticket. The 24 HSL hue/sat/lum
/// sliders are inert while `On` (both front-ends hide the Hue/Saturation
/// panel), so the mode is a clean either/or rather than a stack.
///
/// Serialized as ACR's `crs:ConvertToGrayscale` (`"True"` / `"False"`), so
/// sidecars interchange with Lightroom for the toggle as well as for the
/// `crs:GrayMixer*` weights.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BlackWhiteMode {
    /// Colour render — the 8-band stage runs its HSL hue/sat/lum path.
    Off,
    /// Monochrome render — the gray mixer drives `L`, chroma is zeroed.
    On,
}

impl Default for BlackWhiteMode {
    fn default() -> Self {
        Self::Off
    }
}
