use super::{
    descriptions, key, prefix, rating_value, replace, start_tag_end, CRS, EMPTY, PAPP, XMP,
};
use crate::controls::Control;
use crate::sidecar::{Culling, Flag, SidecarError};
use raw_core::types::adjustment::{AdjustmentModel, Profile, WbScaleVersion, WbSource};
use roxmltree::Document;
use std::collections::BTreeMap;
use std::ops::Range;

pub(crate) fn serialize(
    source: Option<&str>,
    model: &AdjustmentModel,
    culling: &Culling,
) -> Result<String, SidecarError> {
    if culling.rating > 5 {
        return Err(SidecarError::Invalid(
            "Rating must be between 0 and 5".into(),
        ));
    }
    let source = source.unwrap_or(EMPTY);
    let doc = Document::parse(source).map_err(|error| SidecarError::Invalid(error.to_string()))?;
    let descriptions = descriptions(&doc);
    if descriptions.is_empty() {
        return Err(SidecarError::Invalid("XMP has no RDF description".into()));
    }
    let mut attributes = attributes(model, culling)?;
    // An unchanged rating keeps its authored bytes, so a Lightroom `-1` reject or
    // `3.0` is not rewritten (or deleted) by an unrelated edit.
    let keep_rating = descriptions
        .iter()
        .rev()
        .find_map(|node| node.attribute((XMP, "Rating")))
        .is_some_and(|value| rating_value(value) == culling.rating);
    if keep_rating {
        attributes.remove("xmp:Rating");
    }
    for name in ["Version", "ProcessVersion"] {
        let value = descriptions
            .iter()
            .rev()
            .find_map(|node| node.attribute((CRS, name)))
            .unwrap_or("11.0");
        attributes.insert(format!("crs:{name}"), value.to_owned());
    }
    let mut replacements = Vec::new();
    for (index, node) in descriptions.iter().enumerate() {
        let start = node.range().start;
        let end = start + start_tag_end(&source[start..])?;
        let tag = &source[start..end];
        let suffix = if tag.ends_with("/>") { "/>" } else { ">" };
        // Preserve namespace declarations and all unowned attribute bytes.
        let mut removals: Vec<(Range<usize>, String)> = Vec::new();
        for attr in node.attributes() {
            if key(attr.namespace(), attr.name())
                .as_deref()
                .is_some_and(|name| {
                    (owned(
                        name,
                        matches!(model.wb_source, WbSource::Manual | WbSource::Auto),
                    ) && !(keep_rating && name == "xmp:Rating"))
                        || (name == "papp:Look" && attr.value() == "Neutral")
                })
            {
                let range = attr.range();
                let before = &source[start..range.start];
                let whitespace = before.len() - before.trim_end_matches(char::is_whitespace).len();
                removals.push((
                    range.start - start - whitespace..range.end - start,
                    String::new(),
                ));
            }
        }
        let stripped = replace(tag, removals);
        let mut rebuilt = stripped[..stripped.len() - suffix.len()].to_owned();
        if index + 1 == descriptions.len() {
            for (name, uri) in [("xmp", XMP), ("crs", CRS), ("papp", PAPP)] {
                match node.lookup_namespace_uri(Some(name)) {
                    Some(actual) if prefix(Some(actual)) != Some(name) => {
                        return Err(SidecarError::Invalid(format!(
                            "The {name} namespace prefix is bound to a foreign URI"
                        )))
                    }
                    None => rebuilt.push_str(&format!("\n      xmlns:{name}=\"{uri}\"")),
                    Some(actual) if actual != uri => {
                        rebuilt = canonical_namespace(&rebuilt, name, uri);
                    }
                    _ => {}
                }
            }
            let mut ordered: Vec<_> = attributes.iter().collect();
            ordered.sort_by_key(|(name, _)| (priority(name), *name));
            for (name, value) in ordered {
                rebuilt.push_str(&format!("\n      {name}=\"{}\"", escape(value)));
            }
        }
        rebuilt.push_str(suffix);
        replacements.push((start..end, rebuilt));
    }
    let serialized = replace(source, replacements);
    Document::parse(&serialized).map_err(|error| SidecarError::Invalid(error.to_string()))?;
    Ok(serialized)
}

fn attributes(
    model: &AdjustmentModel,
    culling: &Culling,
) -> Result<BTreeMap<String, String>, SidecarError> {
    let mut attrs = BTreeMap::new();
    attrs.insert(
        "papp:Profile".into(),
        match model.profile {
            Profile::Auto => "Auto",
            Profile::Neutral => "Neutral",
        }
        .into(),
    );
    attrs.insert("crs:HasSettings".into(), "True".into());
    if !model.film_look.is_empty() {
        attrs.insert("papp:FilmLook".into(), model.film_look.clone());
    }
    for control in Control::ALL {
        let value = number(control.get(model))?;
        let authored_wb = match control {
            Control::Temperature => model.temperature_seen,
            Control::Tint => model.tint_seen,
            _ => false,
        };
        if authored_wb || value != number(control.spec().default_f32)? {
            attrs.insert(control.xmp().into(), value);
        }
    }
    if attrs.contains_key("crs:Temperature") || attrs.contains_key("crs:Tint") {
        attrs.insert(
            "papp:WbScaleVersion".into(),
            match model.wb_scale_version {
                WbScaleVersion::V1 => "1",
                WbScaleVersion::V2 => "2",
                WbScaleVersion::V3 => "3",
                WbScaleVersion::V4 => "4",
                WbScaleVersion::V5 => "5",
            }
            .into(),
        );
    }
    if matches!(model.wb_source, WbSource::Manual | WbSource::Auto) {
        let auto = model.wb_source == WbSource::Auto;
        attrs.insert(
            "crs:WhiteBalance".into(),
            if auto { "Auto" } else { "Custom" }.into(),
        );
        attrs.insert(
            "papp:WbSource".into(),
            if auto { "Auto" } else { "Manual" }.into(),
        );
        if auto {
            attrs.insert(
                "papp:WbAlgorithmVersion".into(),
                number(model.wb_algorithm_version)?,
            );
        }
    }
    if model.auto_exposure == raw_core::types::adjustment::AutoExposureMode::Off {
        attrs.insert("papp:AutoExposure".into(), "Off".into());
    }
    if culling.rating > 0 {
        attrs.insert("xmp:Rating".into(), culling.rating.to_string());
    }
    match culling.flag {
        Flag::Pick => {
            attrs.insert("papp:Flag".into(), "pick".into());
        }
        Flag::Reject => {
            attrs.insert("papp:Flag".into(), "reject".into());
        }
        Flag::Unflagged => {}
    }
    Ok(attrs)
}

fn owned(key: &str, authored_wb: bool) -> bool {
    Control::ALL.iter().any(|control| control.xmp() == key)
        || matches!(
            key,
            "papp:AutoExposure"
                | "papp:Profile"
                | "papp:FilmLook"
                | "crs:HasSettings"
                | "crs:Version"
                | "crs:ProcessVersion"
                | "xmp:Rating"
                | "papp:Flag"
                | "papp:WbScaleVersion"
        )
        || (authored_wb
            && matches!(
                key,
                "crs:WhiteBalance"
                    | "papp:WbSource"
                    | "papp:WbSampleX"
                    | "papp:WbSampleY"
                    | "papp:WbAlgorithmVersion"
            ))
}

fn priority(name: &str) -> u8 {
    if name.starts_with("xmp:") {
        0
    } else if name.starts_with("crs:") {
        1
    } else {
        2
    }
}

fn number(value: f32) -> Result<String, SidecarError> {
    if !value.is_finite() {
        return Err(SidecarError::Invalid(
            "XMP cannot represent a non-finite value".into(),
        ));
    }
    let rounded = (f64::from(value) * 100.0 + 0.5).floor() / 100.0;
    Ok(if rounded == 0.0 {
        "0".into()
    } else {
        rounded.to_string()
    })
}

fn escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

// Only called on a parsed, valid start tag whose known namespace is legacy.
fn canonical_namespace(tag: &str, prefix: &str, uri: &str) -> String {
    let bytes = tag.as_bytes();
    let mut cursor = bytes
        .iter()
        .position(|ch| ch.is_ascii_whitespace())
        .unwrap_or(bytes.len());
    while cursor < bytes.len() {
        while cursor < bytes.len() && bytes[cursor].is_ascii_whitespace() {
            cursor += 1;
        }
        let name_start = cursor;
        while cursor < bytes.len() && bytes[cursor] != b'=' && !bytes[cursor].is_ascii_whitespace()
        {
            cursor += 1;
        }
        let name_end = cursor;
        while cursor < bytes.len() && (bytes[cursor].is_ascii_whitespace() || bytes[cursor] == b'=')
        {
            cursor += 1;
        }
        if cursor == bytes.len() {
            break;
        }
        let quote = bytes[cursor];
        cursor += 1;
        let value_start = cursor;
        while cursor < bytes.len() && bytes[cursor] != quote {
            cursor += 1;
        }
        if tag[name_start..name_end] == format!("xmlns:{prefix}") {
            return replace(tag, vec![(value_start..cursor, uri.to_owned())]);
        }
        cursor += 1;
    }
    format!("{tag}\n      xmlns:{prefix}=\"{uri}\"")
}
