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
    AdjustmentModel, AutoExposureMode, Crop, HighlightRecoveryMode, HotPixelSuppressionMode, Look,
    Profile, ToneCurveMode, WbMethod,
};

/// Parse a `crs:`-style XMP sidecar. Unknown fields are ignored; known fields that
/// fail to parse numerically surface as an error.
///
/// Crop fields (`crs:CropTop/Left/Bottom/Right/Angle`) are gated by
/// `crs:HasCrop`: when the marker is `"False"` or absent the parser
/// ignores any `crs:Crop*` values and leaves the identity default.
/// `crs:CropAngle` is independent of `HasCrop` (a pure straighten can be
/// serialized without the other four crop edges — spec § 01 invariant 3).
/// The parser does two passes per element so attribute order is irrelevant.
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
                // Auto Profile (#536): the new `papp:Profile` attribute
                // wins over the legacy `papp:Look` migration when both
                // appear on the same element, regardless of document
                // order. Scoped per element so a later Description's
                // `papp:Look` is not silently ignored by an earlier
                // Description's `papp:Profile`. Same precedence-by-flag
                // pattern as `sigma_seen` above.
                let mut profile_seen = false;
                // Crop gating (#277): first pass discovers crs:HasCrop.
                // Missing or "False" → skip crs:Crop{Top,Left,Bottom,Right}
                // on this element. CropAngle is always parsed when present.
                let mut has_crop = false;
                for attr_result in e.attributes() {
                    let attr = attr_result.map_err(|e| Error::Xmp(e.to_string()))?;
                    let key = std::str::from_utf8(attr.key.as_ref())
                        .map_err(|e| Error::Xmp(e.to_string()))?;
                    if key == "crs:HasCrop" {
                        let value = attr
                            .unescape_value()
                            .map_err(|e| Error::Xmp(e.to_string()))?;
                        has_crop = matches!(value.as_ref(), "True" | "true");
                    }
                }
                for attr_result in e.attributes() {
                    let attr = attr_result.map_err(|e| Error::Xmp(e.to_string()))?;
                    let key = std::str::from_utf8(attr.key.as_ref())
                        .map_err(|e| Error::Xmp(e.to_string()))?;
                    let value = attr
                        .unescape_value()
                        .map_err(|e| Error::Xmp(e.to_string()))?;
                    set_field(
                        &mut model,
                        key,
                        &value,
                        &mut sigma_seen,
                        &mut profile_seen,
                        has_crop,
                    )?;
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
    profile_seen: &mut bool,
    has_crop: bool,
) -> Result<()> {
    let v = || {
        value.parse::<f32>().map_err(|e| {
            Error::Xmp(format!(
                "field {} has non-numeric value {}: {}",
                key, value, e
            ))
        })
    };
    match key {
        "crs:Temperature" => m.temperature = v()?,
        "crs:Tint" => m.tint = v()?,
        "crs:Exposure2012" => m.exposure = v()?,
        // Brightness midtone-band gain (#1102, tone/zoom design § 4.1).
        // Maple-proprietary `papp:` key — deliberately NOT `crs:Brightness`,
        // which is ACR process-version-2010 (default +50, removed in PV2012)
        // with different semantics; reusing it would corrupt Lightroom
        // interop. Absent attribute → default 0 (stage no-op).
        "papp:Brightness" => m.brightness = v()?,
        "crs:Contrast2012" => m.contrast = v()?,
        "crs:Highlights2012" => m.highlights = v()?,
        "crs:Shadows2012" => m.shadows = v()?,
        "crs:Whites2012" => m.whites = v()?,
        "crs:Blacks2012" => m.blacks = v()?,
        // Parametric tone-curve region sliders (PV2012 four-region model;
        // prerequisite for #368). These map onto the four parametric region
        // scalars consumed by `build_parametric_knots` in
        // `stages::tone_curves`. ACR's parametric split-point keys
        // (ParametricShadowSplit/MidtoneSplit/HighlightSplit, defaults
        // 25/50/75) are NOT mapped: the model has no split-point fields —
        // `build_parametric_knots` uses fixed 0.25/0.5/0.75 knots — so there
        // is nowhere to store them. Wiring user-adjustable split points is a
        // follow-up (tracked under #368).
        "crs:ParametricHighlights" => m.parametric_highlights = v()?,
        "crs:ParametricLights" => m.parametric_lights = v()?,
        "crs:ParametricDarks" => m.parametric_darks = v()?,
        "crs:ParametricShadows" => m.parametric_shadows = v()?,
        "crs:Vibrance" => m.vibrance = v()?,
        "crs:Saturation" => m.saturation = v()?,
        "crs:Clarity2012" => m.clarity = v()?,
        "crs:Texture" => m.texture = v()?,
        "crs:Sharpness" => m.sharpen_amount = v()?,
        "crs:SharpenRadius" => m.sharpen_radius = v()?,
        "crs:SharpenDetail" => m.sharpen_detail = v()?,
        "crs:SharpenEdgeMasking" => m.sharpen_masking = v()?,
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
        "crs:LuminanceSmoothing" => m.nr_luminance = v()?,
        "crs:ColorNoiseReduction" => m.nr_color = v()?,
        // Decode-time chroma pre-filter (#1104, tone/zoom design § 3.1).
        // Maple-proprietary `papp:` key — there is no ACR equivalent (ACR's
        // ColorNoiseReduction maps onto the late-chain `nr_color` NLM
        // above; this one runs inside the decode product). Absent attribute
        // → default 0 (stage is a bit-identical skip).
        "papp:ChromaPrefilter" => m.chroma_prefilter = v()?,
        // BM3D deep denoise (#1105, tone/zoom design § 3.2). Maple-
        // proprietary `papp:` key; input-referred decode-product stage.
        // Absent attribute → default 0 (bit-identical skip).
        "papp:DeepDenoise" => m.deep_denoise = v()?,
        "crs:Dehaze" => m.dehaze = v()?,
        // S5 effects fields (ticket #643). Lightroom-compatible `crs:` keys
        // so sidecars interchange with Lightroom for these tools. Pipeline
        // math is a follow-up; the parser just stores the user's values so
        // they round-trip across sessions. `grain_roughness` is mapped to
        // LR's `crs:GrainFrequency` (Maple's naming follows the S5 spec).
        "crs:PostCropVignetteAmount" => m.vignette_amount = v()?,
        "crs:PostCropVignetteFeather" => m.vignette_feather = v()?,
        "crs:GrainAmount" => m.grain_amount = v()?,
        "crs:GrainSize" => m.grain_size = v()?,
        "crs:GrainFrequency" => m.grain_roughness = v()?,
        "crs:SplitToningShadowHue" => m.split_tone_shadow_hue = v()?,
        "crs:SplitToningShadowSaturation" => m.split_tone_shadow_saturation = v()?,
        "crs:SplitToningHighlightHue" => m.split_tone_highlight_hue = v()?,
        "crs:SplitToningHighlightSaturation" => m.split_tone_highlight_saturation = v()?,
        "crs:SplitToningBalance" => m.split_tone_balance = v()?,
        // HSL 8-band (#1112, tone/zoom design § 10.4). ACR/Lightroom-compatible
        // `crs:` keys for direct sidecar interchange. Band order: Red, Orange,
        // Yellow, Green, Aqua, Blue, Purple, Magenta.
        "crs:HueAdjustmentRed" => m.hue_adjustment_red = v()?,
        "crs:HueAdjustmentOrange" => m.hue_adjustment_orange = v()?,
        "crs:HueAdjustmentYellow" => m.hue_adjustment_yellow = v()?,
        "crs:HueAdjustmentGreen" => m.hue_adjustment_green = v()?,
        "crs:HueAdjustmentAqua" => m.hue_adjustment_aqua = v()?,
        "crs:HueAdjustmentBlue" => m.hue_adjustment_blue = v()?,
        "crs:HueAdjustmentPurple" => m.hue_adjustment_purple = v()?,
        "crs:HueAdjustmentMagenta" => m.hue_adjustment_magenta = v()?,
        "crs:SaturationAdjustmentRed" => m.saturation_adjustment_red = v()?,
        "crs:SaturationAdjustmentOrange" => m.saturation_adjustment_orange = v()?,
        "crs:SaturationAdjustmentYellow" => m.saturation_adjustment_yellow = v()?,
        "crs:SaturationAdjustmentGreen" => m.saturation_adjustment_green = v()?,
        "crs:SaturationAdjustmentAqua" => m.saturation_adjustment_aqua = v()?,
        "crs:SaturationAdjustmentBlue" => m.saturation_adjustment_blue = v()?,
        "crs:SaturationAdjustmentPurple" => m.saturation_adjustment_purple = v()?,
        "crs:SaturationAdjustmentMagenta" => m.saturation_adjustment_magenta = v()?,
        "crs:LuminanceAdjustmentRed" => m.luminance_adjustment_red = v()?,
        "crs:LuminanceAdjustmentOrange" => m.luminance_adjustment_orange = v()?,
        "crs:LuminanceAdjustmentYellow" => m.luminance_adjustment_yellow = v()?,
        "crs:LuminanceAdjustmentGreen" => m.luminance_adjustment_green = v()?,
        "crs:LuminanceAdjustmentAqua" => m.luminance_adjustment_aqua = v()?,
        "crs:LuminanceAdjustmentBlue" => m.luminance_adjustment_blue = v()?,
        "crs:LuminanceAdjustmentPurple" => m.luminance_adjustment_purple = v()?,
        "crs:LuminanceAdjustmentMagenta" => m.luminance_adjustment_magenta = v()?,
        "crs:WhiteBalance" => {
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
            m.local_adjustments = crate::types::local_adjustment::decode_local_adjustments(value)
                .map_err(|e| Error::Xmp(format!("LocalAdjustments: {e}")))?;
        }
        // Baked AI removals (#1486). Compact-JSON array of removal metadata
        // (region + patch_ref + bake snapshot); patch pixels live out-of-band in
        // `.maple/inpaint/`. Tolerant reader — unknown element kinds skip, only a
        // corrupt removal errors.
        "papp:InpaintRemovals" => {
            m.inpaint_removals = crate::types::inpaint::decode_removals(value)
                .map_err(|e| Error::Xmp(format!("InpaintRemovals: {e}")))?;
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
                other => {
                    return Err(Error::Xmp(format!(
                        "unknown HighlightRecoveryMode: {}",
                        other
                    )))
                }
            };
        }
        // DisplayLookCurve (ticket #371; retired in #443 — Wave-3 closing
        // step of #416). The field is a no-op at the pipeline level
        // post-#443; this branch is kept so pre-#443 sidecars carrying
        // `papp:Look` parse cleanly into the model. Absent attribute ->
        // default (`Look::Default`).
        //
        // Auto Profile (#536): `papp:Look` ALSO migrates into the new
        // `papp:Profile` field — `Default`/`Auto` → `Profile::Auto`,
        // `Neutral` → `Profile::Neutral`. Migration is gated on
        // `!*profile_seen` so a `papp:Profile` attribute on the same
        // element always wins, regardless of document order.
        "papp:Look" => {
            m.look = match value {
                "neutral" | "Neutral" => Look::Neutral,
                "default" | "Default" => Look::Default,
                other => return Err(Error::Xmp(format!("unknown Look: {}", other))),
            };
            if !*profile_seen {
                if value.eq_ignore_ascii_case("Default") || value.eq_ignore_ascii_case("Auto") {
                    m.profile = Profile::Auto;
                } else if value.eq_ignore_ascii_case("Neutral") {
                    m.profile = Profile::Neutral;
                }
                // Unknown legacy values — already rejected by the Look match
                // above, so the migration arm is unreachable for them.
            }
        }
        // Render-shaping profile (Auto Profile Phase 1, #536). New
        // canonical attribute that replaces `papp:Look` migration above.
        // Absent attribute → default (`Profile::Auto`). Setting
        // `profile_seen` blocks the legacy migration from clobbering this
        // value if `papp:Look` appears later in the same attribute set.
        "papp:Profile" => {
            *profile_seen = true;
            m.profile = match value {
                v if v.eq_ignore_ascii_case("Auto") => Profile::Auto,
                v if v.eq_ignore_ascii_case("Neutral") => Profile::Neutral,
                other => return Err(Error::Xmp(format!("unknown Profile: {}", other))),
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
                other => return Err(Error::Xmp(format!("unknown WbMethod: {}", other))),
            };
        }
        // Per-image auto-exposure mode (ticket #429). Absent attribute ->
        // default (`On`) — scene mid-gray anchored to 0.18 before AgX.
        // Existing sidecars produced before #429 don't carry
        // `papp:AutoExposure`; they pick up the new default, which is the
        // point of the PR — every camera lands at the same AgX position
        // unless the user opts out per-image with `papp:AutoExposure="Off"`.
        "papp:AutoExposure" => {
            m.auto_exposure = match value {
                "on" | "On" => AutoExposureMode::On,
                "off" | "Off" => AutoExposureMode::Off,
                other => return Err(Error::Xmp(format!("unknown AutoExposure: {}", other))),
            };
        }
        // Hot/dead-pixel suppression (#1106). Absent attribute -> default
        // (`Off` — bit-identical decode). Pre-demosaic defect replacement;
        // users opt in per-image.
        "papp:HotPixelSuppression" => {
            m.hot_pixel_suppression = match value {
                "on" | "On" => HotPixelSuppressionMode::On,
                "off" | "Off" => HotPixelSuppressionMode::Off,
                other => {
                    return Err(Error::Xmp(format!(
                        "unknown HotPixelSuppression: {}",
                        other
                    )))
                }
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
                other => return Err(Error::Xmp(format!("unknown ToneCurveMode: {}", other))),
            };
        }
        // Crop / straighten — spec § 01 / § 3.12 (ticket #277).
        // crs:Crop{Top,Left,Bottom,Right} are gated by crs:HasCrop
        // (false/absent → ignore). crs:CropAngle is always parsed — it
        // can appear without the rect for a pure straighten (spec § 01
        // invariant 3). crs:HasCrop and crs:CropConstrainToWarp are
        // consumed / accepted but not stored on the model.
        "crs:CropTop" if has_crop => m.crop.top = v()?,
        "crs:CropLeft" if has_crop => m.crop.left = v()?,
        "crs:CropBottom" if has_crop => m.crop.bottom = v()?,
        "crs:CropRight" if has_crop => m.crop.right = v()?,
        "crs:CropAngle" => m.crop.angle = v()?,
        "crs:HasCrop" => {}             // consumed in the pre-pass
        "crs:CropConstrainToWarp" => {} // ACR compat — no Maple semantics
        _ => {}                         // Slices 1-2-3-4 ignore everything else.
    }
    Ok(())
}

/// Minimal XMP-attribute serializer — emits only the attributes that
/// differ from `AdjustmentModel::default()`. Returned string is the
/// attribute fragment (leading space + `key="value"` pairs), suitable for
/// splicing into an `rdf:Description` open tag.
///
/// This is intentionally a seed for Auto Profile Phase 1 (#536) — full
/// XMP sidecar writing lives in the Swift and TypeScript layers per
/// `docs/architecture.md`. Only the Maple-proprietary `papp:` keys with no
/// `crs:` home are emitted here (`papp:Profile`, `papp:Brightness`,
/// `papp:ChromaPrefilter`, `papp:HotPixelSuppression`, `papp:DeepDenoise`);
/// the legacy `papp:Look` is deliberately NOT serialized — newly-written
/// sidecars carry the new attribute name only, and old sidecars still
/// round-trip via the `papp:Look` migration in [`set_field`].
pub fn serialize(model: &AdjustmentModel) -> String {
    let mut out = String::new();
    if model.profile != Profile::default() {
        let v = match model.profile {
            Profile::Auto => "Auto",
            Profile::Neutral => "Neutral",
        };
        out.push_str(&format!(r#" papp:Profile="{v}""#));
    }
    // Brightness (#1102) — emitted only when non-default (0), matching the
    // Swift/TS writers' omit-on-default convention.
    if model.brightness != 0.0 {
        out.push_str(&format!(r#" papp:Brightness="{}""#, model.brightness));
    }
    // Chroma pre-filter (#1104) — emitted only when non-default (0),
    // matching the Swift/TS writers' omit-on-default convention.
    if model.chroma_prefilter != 0.0 {
        out.push_str(&format!(
            r#" papp:ChromaPrefilter="{}""#,
            model.chroma_prefilter
        ));
    }
    // Hot/dead-pixel suppression (#1106) — emitted only when non-default
    // (`Off`), same convention.
    if model.hot_pixel_suppression != HotPixelSuppressionMode::default() {
        out.push_str(r#" papp:HotPixelSuppression="On""#);
    }
    // BM3D deep denoise (#1105) — emitted only when non-default (0).
    if model.deep_denoise != 0.0 {
        out.push_str(&format!(r#" papp:DeepDenoise="{}""#, model.deep_denoise));
    }
    // Crop / straighten (#277) — emitted only when non-identity. The rect
    // attributes (`crs:HasCrop` + four edges) are emitted only when the rect
    // itself differs from full-frame. `crs:CropAngle` is independent — it is
    // emitted iff `|angle| >= 0.01°` (pure straighten without a rect crop is
    // valid). Identity crop (all defaults) writes nothing, matching the spec §
    // 01 invariant 3 "omit the whole group" rule. Float values use 6-decimal
    // format to match Swift/TS output.
    if !model.crop.is_identity() {
        let c = &model.crop;
        let rect_non_identity = c.top != 0.0 || c.left != 0.0 || c.bottom != 1.0 || c.right != 1.0;
        if rect_non_identity {
            out.push_str(r#" crs:HasCrop="True""#);
            out.push_str(&format!(r#" crs:CropTop="{:.6}""#, c.top));
            out.push_str(&format!(r#" crs:CropLeft="{:.6}""#, c.left));
            out.push_str(&format!(r#" crs:CropBottom="{:.6}""#, c.bottom));
            out.push_str(&format!(r#" crs:CropRight="{:.6}""#, c.right));
        }
        if c.angle.abs() >= 0.01 {
            out.push_str(&format!(r#" crs:CropAngle="{:.6}""#, c.angle));
        }
    }
    out
}

/// Map a `crs:WhiteBalance` preset name to (temperature, tint).
/// Returns None for "As Shot", "Auto", "Custom", or unrecognized values —
/// the caller should leave AdjustmentModel defaults in those cases.
fn wb_preset(name: &str) -> Option<(f32, f32)> {
    match name {
        "Daylight" => Some((5500.0, 10.0)),
        "Cloudy" => Some((6500.0, 10.0)),
        "Shade" => Some((7500.0, 10.0)),
        "Tungsten" => Some((2850.0, 0.0)),
        "Fluorescent" => Some((3800.0, 21.0)),
        "Flash" => Some((5500.0, 0.0)),
        _ => None,
    }
}

#[cfg(test)]
mod tests;
#[cfg(test)]
mod tests_metadata;
#[cfg(test)]
mod tests_modes;
