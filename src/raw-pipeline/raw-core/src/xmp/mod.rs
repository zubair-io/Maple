//! XMP sidecar parser. The schema lives in [`crate::types`] — this module
//! is responsible only for translating `crs:`-flavoured XMP attributes into an
//! `AdjustmentModel` value.

use crate::error::{Error, Result};
use quick_xml::events::Event;
use quick_xml::reader::Reader;

// Re-export the canonical schema types so existing
// `use raw_core::xmp::{AdjustmentModel, HighlightRecoveryMode}` paths keep
// compiling. The single source of truth is `crate::types::adjustment`.
pub use crate::types::adjustment::{
    AdjustmentModel, HighlightRecoveryMode, Look, ToneCurveMode, WbMethod,
};

/// Parse a `crs:`-style XMP sidecar. Unknown fields are ignored; known fields that
/// fail to parse numerically surface as an error.
pub fn parse(xml: &str) -> Result<AdjustmentModel> {
    let mut model = AdjustmentModel::default();
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(true);

    loop {
        match reader.read_event() {
            Ok(Event::Empty(e)) | Ok(Event::Start(e)) => {
                // Track whether the new-style `papp:CaptureSharpeningSigma`
                // attribute has been written into `capture_sharpening_sigma`
                // *within this element's attribute set*. The legacy
                // `papp:CaptureSharpeningRadius` (ticket #456 / PR #452
                // semantic shift) writes into the same model field for
                // back-compat, but only when the new key is absent on the
                // same element. `attributes()` iterates in document order, so
                // we need a flag rather than positional precedence — Sigma
                // must win even if it appears second.
                //
                // Scope is per element so that precedence does not leak
                // across unrelated tags: e.g. a sidecar with two
                // `rdf:Description`s where the first carries only `Sigma`
                // and the second carries only `Radius` must still apply the
                // second `Radius` (since its own attribute set has no Sigma).
                let mut sigma_seen = false;
                for attr_result in e.attributes() {
                    let attr = attr_result.map_err(|e| Error::Xmp(e.to_string()))?;
                    let key = std::str::from_utf8(attr.key.as_ref())
                        .map_err(|e| Error::Xmp(e.to_string()))?;
                    let value = attr.unescape_value()
                        .map_err(|e| Error::Xmp(e.to_string()))?;
                    set_field(&mut model, key, &value, &mut sigma_seen)?;
                }
            }
            Ok(Event::Eof) => break,
            Err(e) => return Err(Error::Xmp(e.to_string())),
            _ => {}
        }
    }
    Ok(model)
}

fn set_field(
    m: &mut AdjustmentModel,
    key: &str,
    value: &str,
    sigma_seen: &mut bool,
) -> Result<()> {
    let v = || value.parse::<f32>().map_err(|e| Error::Xmp(format!(
        "field {} has non-numeric value {}: {}", key, value, e
    )));
    match key {
        "crs:Temperature"    => m.temperature = v()?,
        "crs:Tint"           => m.tint        = v()?,
        "crs:Exposure2012"   => m.exposure    = v()?,
        "crs:Contrast2012"   => m.contrast    = v()?,
        "crs:Highlights2012" => m.highlights  = v()?,
        "crs:Shadows2012"    => m.shadows     = v()?,
        "crs:Whites2012"     => m.whites      = v()?,
        "crs:Blacks2012"     => m.blacks      = v()?,
        "crs:Vibrance"       => m.vibrance    = v()?,
        "crs:Saturation"     => m.saturation  = v()?,
        "crs:Clarity2012"    => m.clarity     = v()?,
        "crs:Texture"        => m.texture     = v()?,
        "crs:Sharpness"            => m.sharpen_amount  = v()?,
        "crs:SharpenRadius"        => m.sharpen_radius  = v()?,
        "crs:SharpenDetail"        => m.sharpen_detail  = v()?,
        "crs:SharpenEdgeMasking"   => m.sharpen_masking = v()?,
        // Capture sharpening (Richardson-Lucy deconvolution) — Maple-proprietary,
        // distinct from the reference renderer's `crs:Sharpness` unsharp-mask
        // sliders above. Lives under the `papp:` namespace because the
        // reference renderer has no equivalent control.
        //
        // #456: PR #452 swapped the integer-radius tripled-box-blur PSF for a
        // true Gaussian parameterised by float sigma but kept the XMP key as
        // `papp:CaptureSharpeningRadius`. We rename to
        // `papp:CaptureSharpeningSigma` here and keep a read-only back-compat
        // path for the legacy key. `Sigma` always wins over `Radius` (even if
        // `Radius` appears second in document order); the legacy value is
        // not rescaled — the field's interpretation changed but no shipping
        // sidecar carries a non-zero value, so a rescale would be a guess.
        "papp:CaptureSharpeningAmount" => m.capture_sharpening_amount = v()?,
        "papp:CaptureSharpeningSigma" => {
            m.capture_sharpening_sigma = v()?;
            *sigma_seen = true;
        }
        "papp:CaptureSharpeningRadius" => {
            if !*sigma_seen {
                m.capture_sharpening_sigma = v()?;
            }
        }
        "crs:LuminanceSmoothing"   => m.nr_luminance    = v()?,
        "crs:ColorNoiseReduction"  => m.nr_color        = v()?,
        "crs:Dehaze"         => m.dehaze      = v()?,
        "crs:WhiteBalance"   => {
            if let Some((temp, tint)) = wb_preset(value) {
                m.temperature = temp;
                m.tint = tint;
            }
            // Unknown WB names ("As Shot", "Auto", "Custom") leave defaults.
        }
        // Local adjustments (ticket #280). Slice 1 wire format: compact JSON
        // in a single attribute. Long-run goal is canonical
        // `crs:GradientBasedCorrections` nested-RDF — that requires a
        // separate XMP-walker extension.
        "papp:LocalAdjustments" => {
            m.local_adjustments =
                crate::types::local_adjustment::decode_local_adjustments(value)
                    .map_err(|e| Error::Xmp(format!("LocalAdjustments: {e}")))?;
        }
        "papp:HighlightRecoveryMode" => {
            m.highlight_recovery = match value {
                "off" | "Off" => HighlightRecoveryMode::Off,
                "blend" | "Blend" => HighlightRecoveryMode::Blend,
                "luminance" | "Luminance" => HighlightRecoveryMode::Luminance,
                "chromaticadaptation" | "ChromaticAdaptation" => {
                    HighlightRecoveryMode::ChromaticAdaptation
                }
                // Ticket #471: post-DCP Oklab chroma reduction (opt-in).
                "oklabchromareduction" | "OklabChromaReduction" => {
                    HighlightRecoveryMode::OklabChromaReduction
                }
                other => return Err(Error::Xmp(format!(
                    "unknown HighlightRecoveryMode: {}", other
                ))),
            };
        }
        // DisplayLookCurve (ticket #371). Absent attribute -> default
        // (Look::Default) — the LUT applies to existing sidecars without
        // an explicit migration. Users opting out persist
        // `papp:Look="Neutral"`.
        "papp:Look" => {
            m.look = match value {
                "neutral" | "Neutral" => Look::Neutral,
                "default" | "Default" => Look::Default,
                other => return Err(Error::Xmp(format!(
                    "unknown Look: {}", other
                ))),
            };
        }
        // User white-balance method (ticket #431). Absent attribute ->
        // default (`Cat16`) — proper chromatic adaptation. Pre-#431
        // sidecars (which never carried this attribute) implicitly
        // upgrade to CAT16, which is acceptable: the tint convention
        // changes sign vs the legacy diagonal-gain path, but #431 is
        // the documented switchover; users who need the old behaviour
        // opt in via `papp:WbMethod="DiagonalRec2020"`.
        "papp:WbMethod" => {
            m.wb_method = match value {
                "cat16" | "Cat16" | "CAT16" => WbMethod::Cat16,
                "diagonalrec2020" | "DiagonalRec2020" => WbMethod::DiagonalRec2020,
                other => return Err(Error::Xmp(format!(
                    "unknown WbMethod: {}", other
                ))),
            };
        }
        // Tone-curve application mode (ticket #436). Absent attribute ->
        // default (`PerChannel`) — pre-#436 behavior. Existing sidecars
        // round-trip unchanged. Users opt into ratio/hue-preservation via
        // `papp:ToneCurveMode="RatioPreserving"`.
        "papp:ToneCurveMode" => {
            m.tone_curve_mode = match value {
                "perchannel" | "PerChannel" => ToneCurveMode::PerChannel,
                "ratiopreserving" | "RatioPreserving" => ToneCurveMode::RatioPreserving,
                other => return Err(Error::Xmp(format!(
                    "unknown ToneCurveMode: {}", other
                ))),
            };
        }
        _ => {}, // Slices 1-2-3-4 ignore everything else.
    }
    Ok(())
}

/// Map a `crs:WhiteBalance` preset name to (temperature, tint).
/// Returns None for "As Shot", "Auto", "Custom", or unrecognized values —
/// the caller should leave AdjustmentModel defaults in those cases.
fn wb_preset(name: &str) -> Option<(f32, f32)> {
    match name {
        "Daylight"     => Some((5500.0,  10.0)),
        "Cloudy"       => Some((6500.0,  10.0)),
        "Shade"        => Some((7500.0,  10.0)),
        "Tungsten"     => Some((2850.0,   0.0)),
        "Fluorescent"  => Some((3800.0,  21.0)),
        "Flash"        => Some((5500.0,   0.0)),
        _              => None,
    }
}

#[cfg(test)]
mod tests;
#[cfg(test)]
mod tests_modes;
