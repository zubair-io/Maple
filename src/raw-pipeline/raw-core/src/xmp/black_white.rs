//! Black & white mix (#276) XMP attributes — parse + emit.
//!
//! Split out of `xmp/mod.rs` to keep that file under the 600-LOC hard
//! budget, the same `+HSL` split the Swift serializer uses. ACR/Lightroom-
//! compatible `crs:` keys throughout, so a monochrome conversion
//! interchanges with Lightroom: the boolean `crs:ConvertToGrayscale`
//! toggle plus `crs:GrayMixerRed` … `crs:GrayMixerMagenta` in the same
//! band order as the HSL block.

use super::{Error, Result};
use crate::types::adjustment::{AdjustmentModel, BlackWhiteMode};

/// Apply one B&W attribute to `m`. Returns `None` when `key` is not a B&W
/// key, so the caller can fall through to the rest of its match.
///
/// `number` is the caller's strict numeric parser (the one that also
/// rejects non-finite values, #1943) — passed in rather than re-derived so
/// the mixer weights get exactly the same validation as every other slider.
pub(super) fn set_field(
    key: &str,
    value: &str,
    number: impl Fn() -> Result<f32>,
    m: &mut AdjustmentModel,
) -> Option<Result<()>> {
    // Numeric weights first — the common case, and they all share a parser.
    let slot: Option<&mut f32> = match key {
        "crs:GrayMixerRed" => Some(&mut m.gray_mixer_red),
        "crs:GrayMixerOrange" => Some(&mut m.gray_mixer_orange),
        "crs:GrayMixerYellow" => Some(&mut m.gray_mixer_yellow),
        "crs:GrayMixerGreen" => Some(&mut m.gray_mixer_green),
        "crs:GrayMixerAqua" => Some(&mut m.gray_mixer_aqua),
        "crs:GrayMixerBlue" => Some(&mut m.gray_mixer_blue),
        "crs:GrayMixerPurple" => Some(&mut m.gray_mixer_purple),
        "crs:GrayMixerMagenta" => Some(&mut m.gray_mixer_magenta),
        _ => None,
    };
    if let Some(slot) = slot {
        return Some(number().map(|parsed| *slot = parsed));
    }

    if key != "crs:ConvertToGrayscale" {
        return None;
    }
    // An unrecognized boolean spelling is an error rather than a silent
    // `Off`: a sidecar that says something we don't understand about
    // monochrome must not be rendered in colour.
    Some(match value {
        "true" | "True" | "TRUE" | "1" => {
            m.black_white = BlackWhiteMode::On;
            Ok(())
        }
        "false" | "False" | "FALSE" | "0" => {
            m.black_white = BlackWhiteMode::Off;
            Ok(())
        }
        other => Err(Error::Xmp(format!("unknown ConvertToGrayscale: {}", other))),
    })
}

/// The B&W attribute fragment for a non-default model, or the empty string.
///
/// Unlike the 24 HSL sliders — which raw-core's seed serializer has never
/// emitted, leaving the Swift/TS writers as the only full sidecar writers —
/// the B&W group is written here. `black_white` is a *mode*, not a
/// magnitude: dropping it on a raw-core write would silently re-colour a
/// monochrome render, the same class of data loss as the parametric-curve
/// gap in #365. The eight weights follow the toggle so a mono sidecar
/// survives whole.
pub(super) fn serialize(model: &AdjustmentModel) -> String {
    let mut out = String::new();
    if model.black_white != BlackWhiteMode::default() {
        out.push_str(r#" crs:ConvertToGrayscale="True""#);
    }
    for (key, value) in [
        ("crs:GrayMixerRed", model.gray_mixer_red),
        ("crs:GrayMixerOrange", model.gray_mixer_orange),
        ("crs:GrayMixerYellow", model.gray_mixer_yellow),
        ("crs:GrayMixerGreen", model.gray_mixer_green),
        ("crs:GrayMixerAqua", model.gray_mixer_aqua),
        ("crs:GrayMixerBlue", model.gray_mixer_blue),
        ("crs:GrayMixerPurple", model.gray_mixer_purple),
        ("crs:GrayMixerMagenta", model.gray_mixer_magenta),
    ] {
        if value.is_finite() && value != 0.0 {
            out.push_str(&format!(r#" {key}="{value}""#));
        }
    }
    out
}
