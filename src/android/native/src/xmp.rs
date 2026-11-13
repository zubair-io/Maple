//! Import current development values without cloning or rewriting persisted XML.
use raw_core::types::adjustment::AdjustmentModel;

pub fn parse(source: &str) -> Result<AdjustmentModel, String> {
    raw_core::xmp::parse_namespaced(source).map_err(|error| error.to_string())
}

#[cfg(test)]
#[path = "xmp_memory.rs"]
mod memory;

#[cfg(test)]
mod tests {
    use super::*;
    use raw_core::types::adjustment::WbScaleVersion;

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
