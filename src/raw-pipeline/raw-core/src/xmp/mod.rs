//! XMP sidecar parser. The schema lives in [`crate::types`] — this module
//! is responsible only for translating `crs:`-flavoured XMP attributes into an
//! `AdjustmentModel` value.

use crate::error::{Error, Result};
use quick_xml::events::{BytesStart, Event};
use quick_xml::reader::Reader;

mod fields;
mod tone_curves;
pub use tone_curves::serialize_tone_curves;
use fields::set_field;
use tone_curves::CurveWalker;

// Re-export the canonical schema types so existing
// `use raw_core::xmp::{AdjustmentModel, HighlightRecoveryMode}` paths keep
// compiling. The single source of truth is `crate::types::adjustment`.
pub use crate::types::adjustment::{
    AdjustmentModel, AutoExposureMode, Crop, HighlightRecoveryMode, HotPixelSuppressionMode,
    LensProfileEnable, Look, Profile, ToneCurveMode, WbMethod, WbScaleVersion,
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

    // WB scale versioning (#1780) — document-level state. `papp_seen`
    // records whether ANY element carries the Maple `papp:` namespace
    // (declaration or attribute); every Maple writer declares it
    // unconditionally, so its presence identifies a Maple-authored sidecar.
    // The prefix (not a URI) is the discriminator because the three Maple
    // writers historically bound `papp` to different URIs, while all three
    // parsers key attribute lookups on the `papp:` prefix. An explicit
    // `papp:WbScaleVersion` stamp always wins; a Maple-authored document
    // without one that carries an explicit `crs:Temperature`/`crs:Tint`
    // predates the versioning (pre-#1756 scale, V1); everything else — a
    // document with no `papp:` namespace at all (ACR/Lightroom-authored,
    // always expressed in ACR's own slider scale) or one with no authored
    // WB (nothing to convert; scale-agnostic) — is V5 (#1894).
    let mut papp_seen = false;
    let mut stamp: Option<WbScaleVersion> = None;
    // Point tone curves (#365) are the one part of the schema that is not a
    // flat attribute — they are nested `rdf:Seq` / `rdf:li` content under the
    // four `papp:SceneLinearToneCurve*` parents. The walker owns that subtree;
    // everything outside it still goes through the attribute path below.
    let mut curves = CurveWalker::default();

    loop {
        match reader.read_event() {
            Ok(Event::Start(e)) => {
                let name = element_name(&e)?.to_string();
                // Inside a tone-curve subtree there are no Maple attributes to
                // read, so the attribute walk is skipped entirely.
                if !curves.start(&name) {
                    apply_attributes(&e, &mut model, &mut papp_seen, &mut stamp)?;
                }
            }
            Ok(Event::Empty(e)) => {
                apply_attributes(&e, &mut model, &mut papp_seen, &mut stamp)?;
            }
            Ok(Event::Text(t)) => {
                let text = t.unescape().map_err(|e| Error::Xmp(e.to_string()))?;
                curves.text(&text);
            }
            Ok(Event::End(e)) => {
                let name = std::str::from_utf8(e.name().as_ref())
                    .map_err(|e| Error::Xmp(e.to_string()))?
                    .to_string();
                curves.end(&name, &mut model);
            }
            Ok(Event::Eof) => break,
            Err(e) => return Err(Error::Xmp(e.to_string())),
            _ => {}
        }
    }
    let unstamped_is_v1 = papp_seen && (model.temperature_seen || model.tint_seen);
    // Unstamped, non-Maple (or WB-less) documents are V5 (#1894): an
    // ACR/Lightroom-authored crs:Tint is expressed in ACR's own convention,
    // which IS the Robertson mapping V5 evaluates on — ACR derives its
    // displayed temperature/tint pair from exactly this table — so it
    // passes through unconverted. (These parsed as V4 between #1893 and
    // #1894, when the direction and magnitude were matched but the
    // evaluation locus was still the legacy Hernández-Andrés curve rather
    // than Robertson; the V4 tag now exists solely to preserve the look of
    // any dev-window V4 sidecar via `authored_pair_to_v5`'s joint
    // chromaticity round-trip, the same role V2/V3 play for their scales.)
    model.wb_scale_version = stamp.unwrap_or(if unstamped_is_v1 {
        WbScaleVersion::V1
    } else {
        WbScaleVersion::V5
    });
    Ok(model)
}

/// The element's qualified name (`papp:SceneLinearToneCurve`, `rdf:li`, …).
fn element_name<'a>(e: &'a BytesStart<'a>) -> Result<&'a str> {
    std::str::from_utf8(e.name().into_inner()).map_err(|e| Error::Xmp(e.to_string()))
}

/// Apply one element's attribute set to `model`. Lifted out of [`parse`]'s
/// loop in #365 so the loop body could grow the nested-element arms without
/// pushing this file past its size budget; the body is unchanged.
///
/// `papp_seen` and `stamp` are document-level WB-scale state (#1780) that
/// accumulates across every element; the sigma / profile / crop precedence
/// flags below are deliberately element-scoped.
fn apply_attributes(
    e: &BytesStart<'_>,
    model: &mut AdjustmentModel,
    papp_seen: &mut bool,
    stamp: &mut Option<WbScaleVersion>,
) -> Result<()> {
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
        let key = std::str::from_utf8(attr.key.as_ref()).map_err(|e| Error::Xmp(e.to_string()))?;
        if key == "crs:HasCrop" {
            let value = attr
                .unescape_value()
                .map_err(|e| Error::Xmp(e.to_string()))?;
            has_crop = matches!(value.as_ref(), "True" | "true");
        }
    }
    for attr_result in e.attributes() {
        let attr = attr_result.map_err(|e| Error::Xmp(e.to_string()))?;
        let key = std::str::from_utf8(attr.key.as_ref()).map_err(|e| Error::Xmp(e.to_string()))?;
        let value = attr
            .unescape_value()
            .map_err(|e| Error::Xmp(e.to_string()))?;
        if key == "xmlns:papp" || key.starts_with("papp:") {
            *papp_seen = true;
        }
        if key == "papp:WbScaleVersion" {
            *stamp = Some(match value.as_ref() {
                "1" => WbScaleVersion::V1,
                "2" => WbScaleVersion::V2,
                "3" => WbScaleVersion::V3,
                "4" => WbScaleVersion::V4,
                "5" => WbScaleVersion::V5,
                other => return Err(Error::Xmp(format!("unknown WbScaleVersion: {}", other))),
            });
        }
        set_field(
            model,
            key,
            &value,
            &mut sigma_seen,
            &mut profile_seen,
            has_crop,
        )?;
    }
    Ok(())
}

/// Minimal XMP-attribute serializer — emits only the attributes that
/// differ from `AdjustmentModel::default()`. Returned string is the
/// attribute fragment (leading space + `key="value"` pairs), suitable for
/// splicing into an `rdf:Description` open tag.
///
/// The point tone curves are NOT attributes and therefore not part of this
/// fragment — they are nested children, emitted by
/// [`serialize_tone_curves`] (#365).
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
            Profile::AcrMatch => "AcrMatch",
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
    // Parametric tone-curve region sliders (#365) — Lightroom-compatible
    // PV2012 `crs:` keys, emitted only when non-default (0) to mirror the
    // Swift/TS writers. Both the omit test and the emitted value go through
    // the canonical 2-decimal wire codec: gating on the raw value would emit
    // float-noise (0.004 → `="0.004"`) that Swift/TS round away, churning
    // otherwise-identical sidecars. Non-finite values are not representable
    // in sidecars (canonical-format § Number formatting) and are skipped.
    // The parse half lives in `set_field` above.
    for (key, value) in [
        ("crs:ParametricHighlights", model.parametric_highlights),
        ("crs:ParametricLights", model.parametric_lights),
        ("crs:ParametricDarks", model.parametric_darks),
        ("crs:ParametricShadows", model.parametric_shadows),
    ] {
        let rounded = (value * 100.0).round() / 100.0;
        if rounded.is_finite() && rounded != 0.0 {
            out.push_str(&format!(r#" {key}="{rounded}""#));
        }
    }
    // Black & white mix (#276) — see the sibling module for why this group
    // is emitted here when the HSL sliders are not.
    out.push_str(&black_white::serialize(model));
    // DNG-embedded lens corrections (#376) — ACR-compatible `crs:` keys,
    // emitted only when non-default so a sidecar that never touched the
    // lens panel stays byte-identical. `crs:LensProfileEnable` uses ACR's
    // "1"/"0" spelling; the three scales are whole-percent values, matching
    // the integer format ACR writes.
    if model.lens_profile_enable != LensProfileEnable::default() {
        out.push_str(r#" crs:LensProfileEnable="0""#);
    }
    for (key, value) in [
        (
            "crs:LensProfileDistortionScale",
            model.lens_correction_distortion,
        ),
        (
            "crs:LensProfileChromaticAberrationScale",
            model.lens_correction_ca,
        ),
        (
            "crs:LensProfileVignettingScale",
            model.lens_correction_vignetting,
        ),
    ] {
        let rounded = value.round();
        if rounded.is_finite() && rounded != 100.0 {
            out.push_str(&format!(r#" {key}="{rounded}""#));
        }
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

mod black_white;

#[cfg(test)]
mod tests;
#[cfg(test)]
mod tests_effects;
#[cfg(test)]
mod tests_metadata;
#[cfg(test)]
mod tests_modes;
#[cfg(test)]
mod tests_lens;
mod tests_tone_curves;
#[cfg(test)]
mod tests_wb_scale;
