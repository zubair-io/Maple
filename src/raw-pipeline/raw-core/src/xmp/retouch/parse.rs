//! Attribute and legacy-string decoding for `crs:RetouchAreas` /
//! `crs:RetouchInfo`. Split from `mod.rs` for the file-size budget, the same
//! way `local_adjustments/parse.rs` is.

use crate::error::{Error, Result};
use crate::types::local_adjustment::Point2;
use crate::types::retouch::{RetouchKind, RetouchSpot, DEFAULT_FEATHER};
use quick_xml::events::BytesStart;

/// The correction-level attributes of one `rdf:Description` under
/// `crs:RetouchAreas`.
pub(super) struct SpotAttrs {
    /// `None` when `crs:SpotType` names a kind this build does not model —
    /// the walker drops that one spot rather than failing the parse.
    pub kind: Option<RetouchKind>,
    pub source: Option<Point2>,
    /// Adobe's alternative source encoding: destination centre + offset.
    pub offset: Option<Point2>,
    pub feather: f32,
    pub opacity: f32,
}

/// The mask-leaf attributes: where the destination disc sits and how big
/// it is.
pub(super) struct MaskAttrs {
    pub center: Point2,
    pub radius: f32,
    /// A `crs:Feather` on the mask leaf overrides the correction's, matching
    /// how Adobe's own circular-gradient leaf carries the feather.
    pub feather: Option<f32>,
}

fn attr_value(e: &BytesStart<'_>, key: &str) -> Result<Option<String>> {
    for attr in e.attributes() {
        let attr = attr.map_err(|err| Error::Xmp(err.to_string()))?;
        let name =
            std::str::from_utf8(attr.key.as_ref()).map_err(|err| Error::Xmp(err.to_string()))?;
        if name == key {
            let value = attr
                .unescape_value()
                .map_err(|err| Error::Xmp(err.to_string()))?;
            return Ok(Some(value.into_owned()));
        }
    }
    Ok(None)
}

fn number(e: &BytesStart<'_>, key: &str) -> Result<Option<f32>> {
    let Some(raw) = attr_value(e, key)? else {
        return Ok(None);
    };
    raw.trim()
        .parse::<f32>()
        .map(Some)
        .map_err(|_| Error::Xmp(format!("{key} must be numeric, got {raw:?}")))
}

/// Read the correction attributes. Only `crs:SpotType` is required — a
/// retouch area with no spot type is not a retouch area.
pub(super) fn parse_spot_attrs(e: &BytesStart<'_>) -> Result<SpotAttrs> {
    let kind = attr_value(e, "crs:SpotType")?
        .as_deref()
        .and_then(RetouchKind::from_wire);
    let source = match (number(e, "crs:SourceX")?, number(e, "crs:SourceY")?) {
        (Some(x), Some(y)) => Some(Point2::new(x, y)),
        _ => None,
    };
    let offset = match (number(e, "crs:OffsetX")?, number(e, "crs:OffsetY")?) {
        (Some(x), Some(y)) => Some(Point2::new(x, y)),
        _ => None,
    };
    Ok(SpotAttrs {
        kind,
        source,
        offset,
        feather: number(e, "crs:Feather")?.unwrap_or(DEFAULT_FEATHER),
        opacity: number(e, "crs:Opacity")?.unwrap_or(1.0),
    })
}

/// Read a `crs:Masks` leaf. `None` when `crs:What` is not the circular form
/// (a brush or AI mask — nothing Maple's circular spot models), or when the
/// leaf carries no radius. A recognised leaf with a malformed number is a
/// hard error, matching the strictness rule every other known key follows.
pub(super) fn parse_mask_attrs(e: &BytesStart<'_>) -> Result<Option<MaskAttrs>> {
    let what = attr_value(e, "crs:What")?;
    if what.as_deref() != Some(super::MASK_WHAT_CIRCULAR) {
        return Ok(None);
    }
    let Some(radius) = number(e, "crs:Radius")? else {
        return Ok(None);
    };
    let x = number(e, "crs:X")?
        .ok_or_else(|| Error::Xmp("retouch mask leaf missing crs:X".to_string()))?;
    let y = number(e, "crs:Y")?
        .ok_or_else(|| Error::Xmp("retouch mask leaf missing crs:Y".to_string()))?;
    Ok(Some(MaskAttrs {
        center: Point2::new(x, y),
        radius,
        feather: number(e, "crs:Feather")?,
    }))
}

/// Assemble a spot from the correction attributes and its recognised mask
/// leaf. `None` when either half is missing or unmodelled.
pub(super) fn assemble(attrs: &SpotAttrs, mask: &MaskAttrs) -> Option<RetouchSpot> {
    let kind = attrs.kind?;
    let source = attrs.source.or_else(|| {
        attrs
            .offset
            .map(|o| Point2::new(mask.center.x + o.x, mask.center.y + o.y))
    })?;
    Some(RetouchSpot {
        kind,
        center: mask.center,
        source,
        radius: mask.radius,
        feather: mask.feather.unwrap_or(attrs.feather),
        opacity: attrs.opacity,
    })
}

/// Decode one legacy `crs:RetouchInfo` `rdf:li` body — Lightroom's
/// pre-struct form, a comma-separated `key = value` list:
///
/// ```text
/// centerX = 0.5, centerY = 0.5, radius = 0.02,
/// sourceState = sourceSetExplicitly, sourceX = 0.6, sourceY = 0.5,
/// spotType = heal
/// ```
///
/// Tolerant: an entry missing a coordinate, a radius or a modelled spot type
/// yields `None` (skip that spot) rather than failing the document, since
/// these strings are third-party content Maple never writes.
pub(super) fn parse_legacy_info(body: &str) -> Option<RetouchSpot> {
    let mut center = (None, None);
    let mut source = (None, None);
    let mut radius = None;
    let mut kind = None;
    for field in body.split(',') {
        let Some((key, value)) = field.split_once('=') else {
            continue;
        };
        let (key, value) = (key.trim(), value.trim());
        match key {
            "centerX" => center.0 = value.parse::<f32>().ok(),
            "centerY" => center.1 = value.parse::<f32>().ok(),
            "sourceX" => source.0 = value.parse::<f32>().ok(),
            "sourceY" => source.1 = value.parse::<f32>().ok(),
            "radius" => radius = value.parse::<f32>().ok(),
            "spotType" => kind = RetouchKind::from_wire(value),
            _ => {}
        }
    }
    Some(RetouchSpot {
        kind: kind?,
        center: Point2::new(center.0?, center.1?),
        source: Point2::new(source.0?, source.1?),
        radius: radius?,
        feather: DEFAULT_FEATHER,
        opacity: 1.0,
    })
}
