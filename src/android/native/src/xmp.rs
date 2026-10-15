//! Import-only namespace adaptation. Persisted source XML is never rewritten here.
use raw_core::types::adjustment::{AdjustmentModel, WbScaleVersion, TRANSFER_XMP_ELEMENTS};
use roxmltree::{Document, Node};
use std::fmt::Write;

const RDF: &str = "http://www.w3.org/1999/02/22-rdf-syntax-ns#";

fn prefix(uri: Option<&str>) -> Option<&'static str> {
    match uri? {
        RDF => Some("rdf"),
        "http://ns.adobe.com/camera-raw-settings/1.0/" => Some("crs"),
        "http://ns.adobe.com/xap/1.0/" => Some("xmp"),
        "http://ns.justmaple.app/photo/1.0/"
        | "http://ns.justmaple.app/1.0/"
        | "https://maple.app/ns/1.0/" => Some("papp"),
        _ => None,
    }
}

fn key(uri: Option<&str>, local: &str) -> String {
    format!("{}:{local}", prefix(uri).unwrap_or("foreign"))
}

fn escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

fn develop_context(node: Node<'_, '_>, descriptions: &[Node<'_, '_>]) -> bool {
    descriptions.contains(&node)
        || node.ancestors().any(|ancestor| {
            let tag = ancestor.tag_name();
            let name = key(tag.namespace(), tag.name());
            TRANSFER_XMP_ELEMENTS
                .iter()
                .any(|(_, element)| *element == name)
                || matches!(
                    name.as_str(),
                    "crs:GradientBasedCorrections"
                        | "crs:CircularGradientBasedCorrections"
                        | "crs:RetouchAreas"
                        | "papp:BrushCorrections"
                        | "papp:Workflow"
                )
        })
}

fn append(node: Node<'_, '_>, descriptions: &[Node<'_, '_>], output: &mut String) {
    if node.is_text() {
        output.push_str(&escape(node.text().unwrap_or_default()));
    } else if node.is_element() {
        let tag = node.tag_name();
        let name = key(tag.namespace(), tag.name());
        write!(output, "<{name}").unwrap();
        for attr in node.attributes() {
            let Some(prefix) = prefix(attr.namespace()) else {
                continue;
            };
            if matches!(prefix, "crs" | "papp") && !develop_context(node, descriptions) {
                continue;
            }
            write!(
                output,
                " {prefix}:{}=\"{}\"",
                attr.name(),
                escape(attr.value())
            )
            .unwrap();
        }
        output.push('>');
        for child in node.children() {
            append(child, descriptions, output);
        }
        write!(output, "</{name}>").unwrap();
    }
}

pub fn parse(source: &str) -> Result<AdjustmentModel, String> {
    if source.is_empty() {
        return Ok(AdjustmentModel::default());
    }
    let document = Document::parse(source).map_err(|error| error.to_string())?;
    let descriptions: Vec<_> = document
        .descendants()
        .filter(|node| {
            node.has_tag_name((RDF, "Description"))
                && node
                    .parent()
                    .is_some_and(|parent| parent.has_tag_name((RDF, "RDF")) || parent.is_root())
        })
        .collect();
    // The core's flat reader expects canonical qualified names. A disposable
    // namespace-clean envelope also prevents foreign prefix shadowing in nested
    // curve/mask walkers. The source stays available verbatim for persistence.
    let mut normalized = String::from(
        r#"<import xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/" xmlns:papp="http://ns.justmaple.app/photo/1.0/" xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmlns:foreign="urn:maple:unowned">"#,
    );
    append(document.root_element(), &descriptions, &mut normalized);
    normalized.push_str("</import>");
    let mut model = raw_core::xmp::parse(&normalized).map_err(|error| error.to_string())?;
    let explicit_scale = descriptions.iter().any(|node| {
        node.attributes()
            .any(|attr| prefix(attr.namespace()) == Some("papp") && attr.name() == "WbScaleVersion")
    });
    if !explicit_scale {
        let maple_authored = descriptions.iter().any(|node| {
            node.namespaces()
                .any(|ns| prefix(Some(ns.uri())) == Some("papp"))
        });
        model.wb_scale_version = if maple_authored && (model.temperature_seen || model.tint_seen) {
            WbScaleVersion::V1
        } else {
            WbScaleVersion::V5
        };
    }
    Ok(model)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn namespace_import_matches_canonical_model_without_changing_source_bytes() {
        let source = r#"<r:RDF xmlns:r="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:c="http://ns.adobe.com/camera-raw-settings/1.0/" xmlns:m="https://maple.app/ns/1.0/"><r:Description c:Exposure2012="0.75" c:Contrast2012="20" c:Temperature="6000" c:Tint="5" m:Profile="Neutral"><m:SceneLinearToneCurve><r:Seq><r:li>0, 0</r:li><r:li>1, 0.9</r:li></r:Seq></m:SceneLinearToneCurve><f:data xmlns:f="urn:foreign"><r:Description c:Exposure2012="-3"/></f:data></r:Description></r:RDF>"#;
        let canonical = source
            .replace("r:", "rdf:")
            .replace("c:", "crs:")
            .replace("m:", "papp:")
            .replace("xmlns:r=", "xmlns:rdf=")
            .replace("xmlns:c=", "xmlns:crs=")
            .replace("xmlns:m=", "xmlns:papp=")
            .replace(
                "https://maple.app/ns/1.0/",
                "http://ns.justmaple.app/photo/1.0/",
            )
            .replace(" c:Exposure2012=\"-3\"", "")
            .replace(" crs:Exposure2012=\"-3\"", "");
        let path = std::env::temp_dir().join(format!(
            "android-import-{}-{}.xmp",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::write(&path, source).unwrap();
        let imported = parse(&std::fs::read_to_string(&path).unwrap()).unwrap();
        let expected = raw_core::xmp::parse(&canonical).unwrap();
        assert_eq!(imported, expected);
        assert_eq!(std::fs::read(&path).unwrap(), source.as_bytes());
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn foreign_prefix_shadowing_never_changes_development_or_wb_authorship() {
        let xml = r#"<RDF xmlns="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:crs="urn:foreign" xmlns:c="http://ns.adobe.com/camera-raw-settings/1.0/"><Description c:Exposure2012="1" c:Temperature="6000" c:Tint="5" crs:Contrast2012="100"/></RDF>"#;
        let imported = parse(xml).unwrap();
        assert_eq!(imported.exposure, 1.0);
        assert_eq!(imported.contrast, 0.0);
        assert_eq!(imported.wb_scale_version, WbScaleVersion::V5);
    }
}
