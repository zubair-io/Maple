use super::{descriptions, key, legacy_flag, prefix, replace, start_tag_end, XMP};
use crate::sidecar::{Culling, Flag, SidecarError};
use raw_core::types::adjustment::{AdjustmentModel, WbScaleVersion, TRANSFER_XMP_ELEMENTS};
use roxmltree::Document;

pub(crate) fn parse(source: &str) -> Result<(AdjustmentModel, Culling), SidecarError> {
    let doc = Document::parse(source).map_err(|error| SidecarError::Invalid(error.to_string()))?;
    let descriptions = descriptions(&doc);
    if descriptions.is_empty() {
        return Err(SidecarError::Invalid("XMP has no RDF description".into()));
    }
    // The shared render-side reader matches qualified names. Normalize aliases
    // in a temporary copy only; never mutate foreign XML to make it parse.
    let mut replacements = Vec::new();
    for node in doc.descendants().filter(|node| node.is_element()) {
        let range = node.range();
        let tag = &source[range.clone()];
        let name_end = tag[1..]
            .find(|c: char| c.is_whitespace() || c == '/' || c == '>')
            .unwrap()
            + 1;
        let original_name = &tag[1..name_end];
        let name = key(node.tag_name().namespace(), node.tag_name().name()).unwrap_or_else(|| {
            if original_name.starts_with("crs:")
                || original_name.starts_with("papp:")
                || original_name.starts_with("rdf:")
            {
                format!("foreign:{}", node.tag_name().name())
            } else {
                original_name.to_owned()
            }
        });
        replacements.push((range.start + 1..range.start + name_end, name.clone()));
        if !tag[..start_tag_end(tag)?].ends_with("/>") {
            if let Some(offset) = tag.rfind("</") {
                replacements.push((
                    range.start + offset + 2..range.start + offset + 2 + original_name.len(),
                    name,
                ));
            }
        }
        let develop_context = descriptions.contains(&node)
            || node.ancestors().any(|ancestor| {
                let name = key(ancestor.tag_name().namespace(), ancestor.tag_name().name());
                name.as_deref().is_some_and(|name| {
                    TRANSFER_XMP_ELEMENTS
                        .iter()
                        .any(|(_, element)| *element == name)
                        || matches!(
                            name,
                            "crs:GradientBasedCorrections"
                                | "crs:CircularGradientBasedCorrections"
                                | "crs:RetouchAreas"
                                | "papp:Workflow"
                        )
                })
            });
        for attr in node.attributes() {
            let range = attr.range_qname();
            let original = &source[range.clone()];
            let canonical =
                if !develop_context && matches!(prefix(attr.namespace()), Some("crs" | "papp")) {
                    format!("foreign:{}", attr.name())
                } else {
                    key(attr.namespace(), attr.name()).unwrap_or_else(|| {
                        if original.starts_with("crs:") || original.starts_with("papp:") {
                            format!("foreign:{}", attr.name())
                        } else {
                            original.to_owned()
                        }
                    })
                };
            replacements.push((range, canonical));
        }
    }
    let normalized = replace(source, replacements);
    let mut model = raw_core::xmp::parse(&normalized)
        .map_err(|error| SidecarError::Invalid(error.to_string()))?;
    // Namespace identity, not an arbitrary source prefix, determines authorship.
    let explicit_scale = descriptions.iter().any(|node| {
        node.attributes().any(|attr| {
            key(attr.namespace(), attr.name()).as_deref() == Some("papp:WbScaleVersion")
        })
    });
    if !explicit_scale {
        let maple_authored = descriptions.iter().any(|node| {
            node.namespaces()
                .any(|namespace| prefix(Some(namespace.uri())) == Some("papp"))
        });
        model.wb_scale_version = if maple_authored && (model.temperature_seen || model.tint_seen) {
            WbScaleVersion::V1
        } else {
            WbScaleVersion::V5
        };
    }
    let mut culling = Culling::default();
    for node in descriptions {
        let canonical_flag = node
            .attributes()
            .find(|attr| key(attr.namespace(), attr.name()).as_deref() == Some("papp:Flag"));
        let legacy = node.attribute((XMP, "Label")).and_then(legacy_flag);
        if canonical_flag.is_none() {
            if let Some(flag) = legacy {
                culling.flag = flag;
            }
        }
        for attr in node.attributes() {
            match key(attr.namespace(), attr.name()).as_deref() {
                Some("xmp:Rating") => {
                    culling.rating = attr.value().parse::<i32>().unwrap_or(0).clamp(0, 5) as u8
                }
                Some("papp:Flag") => {
                    culling.flag = match attr.value() {
                        "pick" => Flag::Pick,
                        "reject" => Flag::Reject,
                        _ => Flag::Unflagged,
                    }
                }
                _ => {}
            }
        }
    }
    Ok((model, culling))
}
