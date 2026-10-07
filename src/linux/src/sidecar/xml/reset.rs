//! Reset known develop values using the shared wire inventory, retaining geometry.
use super::{descriptions, key, replace};
use crate::sidecar::SidecarError;
use raw_core::types::adjustment::{TRANSFER_XMP_ATTRIBUTES, TRANSFER_XMP_ELEMENTS};

pub(crate) fn reset(source: &str) -> Result<String, SidecarError> {
    let document = roxmltree::Document::parse(source)
        .map_err(|error| SidecarError::Invalid(error.to_string()))?;
    let reset_keys: Vec<_> = TRANSFER_XMP_ATTRIBUTES
        .iter()
        .filter(|(field, _)| !matches!(*field, "crop" | "perspective_rotate"))
        .flat_map(|(_, keys)| keys.iter().copied())
        .chain(["crs:WhiteBalance"])
        .collect();
    let mut changes = Vec::new();
    for description in descriptions(&document) {
        for attribute in description.attributes() {
            if key(attribute.namespace(), attribute.name())
                .as_deref()
                .is_some_and(|name| reset_keys.contains(&name))
            {
                changes.push((attribute.range(), String::new()));
            }
        }
        for child in description.children().filter(|node| node.is_element()) {
            if key(child.tag_name().namespace(), child.tag_name().name())
                .as_deref()
                .is_some_and(|name| TRANSFER_XMP_ELEMENTS.iter().any(|(_, wire)| *wire == name))
            {
                changes.push((child.range(), String::new()));
            }
        }
    }
    Ok(replace(source, changes))
}
