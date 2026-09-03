//! Attribute-level parsing for one correction / one mask leaf. Split out of
//! `mod.rs` (#358 review round) so the document-structure walker isn't
//! competing with this file's own growth for the 570-line headroom budget —
//! same rationale as `xmp/fields.rs` being split out of `xmp/mod.rs` in #365.

use super::{Kind, MASK_WHAT_IMAGE, MASK_WHAT_LINEAR, MASK_WHAT_RADIAL};
use crate::error::{Error, Result};
use crate::types::local_adjustment::{
    BitmapRecipe, Mask, PartialAdjustments, Point2, RangeRefinement,
};
use crate::xmp::parse_xmp_bool;
use quick_xml::events::BytesStart;

fn attr_str(e: &BytesStart<'_>, key: &str) -> Result<Option<String>> {
    for attr_result in e.attributes() {
        let attr = attr_result.map_err(|err| Error::Xmp(err.to_string()))?;
        let k =
            std::str::from_utf8(attr.key.as_ref()).map_err(|err| Error::Xmp(err.to_string()))?;
        if k == key {
            let v = attr
                .unescape_value()
                .map_err(|err| Error::Xmp(err.to_string()))?;
            return Ok(Some(v.into_owned()));
        }
    }
    Ok(None)
}

fn attr_f32(e: &BytesStart<'_>, key: &str) -> Result<Option<f32>> {
    match attr_str(e, key)? {
        Some(v) => {
            let parsed: f32 = v
                .parse()
                .map_err(|err| Error::Xmp(format!("{key} has non-numeric value {v}: {err}")))?;
            if !parsed.is_finite() {
                return Err(Error::Xmp(format!("{key} has non-finite value {v}")));
            }
            Ok(Some(parsed))
        }
        None => Ok(None),
    }
}

/// Like [`attr_f32`], but a missing attribute is itself the error — for the
/// handful of geometry fields that define WHERE a recognized mask sits, a
/// silently invented `0`/`1` default would render a plausible-looking mask
/// in the wrong place with no signal anything was wrong.
fn attr_f32_required(e: &BytesStart<'_>, key: &str) -> Result<f32> {
    attr_f32(e, key)?.ok_or_else(|| Error::Xmp(format!("mask is missing required {key}")))
}

/// One correction's parsed attributes, before the mask is known.
pub(super) struct CorrectionAttrs {
    pub(super) adjustments: PartialAdjustments,
    /// The colour-range refinement (#3270), if `papp:RangeKind` is present.
    pub(super) range: Option<RangeRefinement>,
    /// `false` when `crs:CorrectionActive="False"` — the correction is a
    /// disabled pin and contributes nothing.
    pub(super) active: bool,
}

/// Parse a correction `rdf:Description`'s Local* sliders plus the
/// `crs:CorrectionActive` / `crs:CorrectionAmount` bookkeeping attributes.
/// `crs:What` is ignored — it is always `"Correction"` and carries no
/// information a fixed field list needs.
pub(super) fn parse_correction_attrs(e: &BytesStart<'_>) -> Result<CorrectionAttrs> {
    // Same case-insensitive spelling set every other boolean-like field in
    // the schema accepts (`docs/xmp-canonical-format.md` § "Enum fields and
    // parse strictness"); an absent or unrecognized value defaults to
    // active, matching Adobe's own "no explicit CorrectionActive means the
    // correction applies" convention.
    let active = attr_str(e, "crs:CorrectionActive")?
        .and_then(|v| parse_xmp_bool(&v))
        .unwrap_or(true);
    let amount = attr_f32(e, "crs:CorrectionAmount")?.unwrap_or(1.0);
    let raw = PartialAdjustments {
        exposure: attr_f32(e, "crs:LocalExposure2012")?,
        contrast: attr_f32(e, "crs:LocalContrast2012")?,
        highlights: attr_f32(e, "crs:LocalHighlights2012")?,
        shadows: attr_f32(e, "crs:LocalShadows2012")?,
        whites: attr_f32(e, "crs:LocalWhites2012")?,
        blacks: attr_f32(e, "crs:LocalBlacks2012")?,
        saturation: attr_f32(e, "crs:LocalSaturation")?,
        vibrance: attr_f32(e, "papp:LocalVibrance")?,
        temperature: attr_f32(e, "crs:LocalTemperature")?,
        tint: attr_f32(e, "crs:LocalTint")?,
        // Adobe stores LocalHue on a ±1 scale; Maple's slider is ±100 (#3269).
        // Pinned to a Lightroom-authored fixture when one exists (spec §11).
        hue: attr_f32(e, "crs:LocalHue")?.map(|v| v * 100.0),
    };
    // Amount==1 is the overwhelmingly common case (Maple's own writer always
    // emits it); skip the multiply entirely rather than reintroduce float
    // noise into values that were already clean.
    let adjustments = if (amount - 1.0).abs() <= f32::EPSILON {
        raw
    } else {
        scale_adjustments(&raw, amount)
    };
    let range = parse_range_attrs(e)?;
    Ok(CorrectionAttrs {
        adjustments,
        range,
        active,
    })
}

/// Parse the `papp:Range*` attributes (#3270, spec §5.2) off the SAME
/// `rdf:Description` the sliders live on — not a nested element, so it needs
/// no walker state. `Ok(None)` when `papp:RangeKind` is absent or an
/// unrecognized value (forward-compat with a future non-`Color` variant).
/// Missing numeric fields fall back to the skin preset's own defaults rather
/// than erroring — a range refinement is a soft "narrow the mask further"
/// knob, not a positional geometry field where a wrong default silently
/// mislocates the mask.
fn parse_range_attrs(e: &BytesStart<'_>) -> Result<Option<RangeRefinement>> {
    match attr_str(e, "papp:RangeKind")?.as_deref() {
        Some("Color") => Ok(Some(RangeRefinement::Color {
            hue_deg: attr_f32(e, "papp:RangeHue")?.unwrap_or(55.0),
            hue_half_width_deg: attr_f32(e, "papp:RangeHueWidth")?.unwrap_or(25.0),
            chroma_min: attr_f32(e, "papp:RangeChromaMin")?.unwrap_or(0.02),
            l_min: attr_f32(e, "papp:RangeLMin")?.unwrap_or(0.15),
            l_max: attr_f32(e, "papp:RangeLMax")?.unwrap_or(0.95),
            feather: attr_f32(e, "papp:RangeFeather")?.unwrap_or(0.3),
        })),
        _ => Ok(None),
    }
}

/// Scale every present field by `amount` — Adobe's own Amount slider has
/// exactly this effect on the stored per-control deltas, so this reproduces
/// it rather than inventing a separate "amount" concept in Maple's model.
fn scale_adjustments(a: &PartialAdjustments, amount: f32) -> PartialAdjustments {
    let s = |v: Option<f32>| v.map(|x| x * amount);
    PartialAdjustments {
        exposure: s(a.exposure),
        contrast: s(a.contrast),
        highlights: s(a.highlights),
        shadows: s(a.shadows),
        whites: s(a.whites),
        blacks: s(a.blacks),
        saturation: s(a.saturation),
        vibrance: s(a.vibrance),
        temperature: s(a.temperature),
        tint: s(a.tint),
        hue: s(a.hue),
    }
}

/// Parse one `crs:CorrectionMasks > rdf:Seq > rdf:li` mask descriptor.
/// `Ok(None)` = an unrecognized `crs:What` (skip, forward-compat with mask
/// kinds Maple doesn't model); `Err` = a recognized shape missing (or with a
/// corrupt) required geometry field.
pub(super) fn parse_mask_attrs(kind: Kind, e: &BytesStart<'_>) -> Result<Option<Mask>> {
    let what = attr_str(e, "crs:What")?;
    let recognized = matches!(
        (kind, what.as_deref()),
        (Kind::Linear, Some(MASK_WHAT_LINEAR))
            | (Kind::Radial, Some(MASK_WHAT_RADIAL))
            | (Kind::Group, Some(MASK_WHAT_IMAGE))
    );
    if !recognized {
        return Ok(None);
    }
    match kind {
        Kind::Linear => {
            let start = Point2::new(
                attr_f32_required(e, "crs:ZeroX")?,
                attr_f32_required(e, "crs:ZeroY")?,
            );
            let end = Point2::new(
                attr_f32_required(e, "crs:FullX")?,
                attr_f32_required(e, "crs:FullY")?,
            );
            let feather = attr_f32(e, "papp:LocalFeather")?.unwrap_or(0.5);
            Ok(Some(Mask::Linear {
                start,
                end,
                feather,
            }))
        }
        Kind::Radial => {
            let top = attr_f32_required(e, "crs:Top")?;
            let left = attr_f32_required(e, "crs:Left")?;
            let bottom = attr_f32_required(e, "crs:Bottom")?;
            let right = attr_f32_required(e, "crs:Right")?;
            let angle_deg = attr_f32(e, "crs:Angle")?.unwrap_or(0.0);
            let feather_pct = attr_f32(e, "crs:Feather")?.unwrap_or(50.0);
            let flipped = attr_str(e, "crs:Flipped")?
                .and_then(|v| parse_xmp_bool(&v))
                .unwrap_or(false);
            Ok(Some(Mask::Radial {
                center: Point2::new((left + right) / 2.0, (top + bottom) / 2.0),
                radii: Point2::new((right - left) / 2.0, (bottom - top) / 2.0),
                angle: angle_deg.to_radians(),
                feather: (feather_pct / 100.0).clamp(0.0, 1.0),
                invert: flipped,
            }))
        }
        Kind::Group => match attr_str(e, "papp:MaskSource")?.as_deref() {
            Some("Everywhere") => Ok(Some(Mask::Everywhere)),
            Some("PersonSkin") => Ok(Some(Mask::Bitmap {
                recipe: BitmapRecipe {
                    person: attr_f32(e, "papp:MaskPerson")?.unwrap_or(0.0) as u32,
                    facial_skin: attr_str(e, "papp:MaskFacialSkin")?
                        .and_then(|v| parse_xmp_bool(&v))
                        .unwrap_or(true),
                    body_skin: attr_str(e, "papp:MaskBodySkin")?
                        .and_then(|v| parse_xmp_bool(&v))
                        .unwrap_or(true),
                    model: attr_str(e, "papp:MaskModel")?.unwrap_or_default(),
                    digest: attr_str(e, "papp:MaskDigest")?.ok_or_else(|| {
                        Error::Xmp("Mask/Image PersonSkin is missing papp:MaskDigest".into())
                    })?,
                },
                // Unresolved until `raw-ffi`'s mask-raster registry (a later
                // ticket) stamps a real id onto the parsed model — resolving
                // by digest is what makes that work without this parser
                // needing to know about the registry at all.
                raster_id: 0,
            })),
            // Lightroom's own AI masks (Select Subject, Select Sky, …) carry
            // Mask/Image with a MaskDigest but no papp: recipe — Maple can't
            // regenerate them, so skip (forward-compat), matching every
            // other unrecognized mask kind this reader already tolerates.
            _ => Ok(None),
        },
    }
}
