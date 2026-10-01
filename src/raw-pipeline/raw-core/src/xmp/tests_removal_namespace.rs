use super::parse;

const XMP: &str = include_str!("../../../../../test-fixtures/removal/calibration/saved.xmp");

#[test]
fn saved_removal_namespace_aliases_and_element_payloads_match_canonical_attributes() {
    let expected = parse(XMP).unwrap().inpaint_removals;
    assert_eq!(expected.len(), 1);
    for uri in [
        "http://ns.justmaple.app/photo/1.0/",
        "http://ns.justmaple.app/1.0/",
    ] {
        let alias = XMP
            .replace("xmlns:papp=", "xmlns:m=")
            .replace("papp:InpaintRemovals=", "m:InpaintRemovals=")
            .replace("http://ns.justmaple.app/photo/1.0/", uri);
        assert_eq!(parse(&alias).unwrap().inpaint_removals, expected);
        let json = crate::types::inpaint::encode_removals(&expected).unwrap();
        for payload in [
            quick_xml::escape::escape(&json).to_string(),
            format!("<![CDATA[{json}]]>"),
        ] {
            let element = format!(
                r#"<r:RDF xmlns:r="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:m="{uri}"><r:Description><m:InpaintRemovals>{payload}</m:InpaintRemovals></r:Description></r:RDF>"#
            );
            assert_eq!(parse(&element).unwrap().inpaint_removals, expected);
        }
    }
}

#[test]
fn foreign_shadowed_removal_names_are_opaque_but_ambiguous_owned_fields_fail_closed() {
    let foreign = XMP
        .replace("http://ns.justmaple.app/photo/1.0/", "urn:foreign")
        .replace("&quot;", "no JSON");
    assert!(parse(&foreign).unwrap().inpaint_removals.is_empty());
    let owned_empty = r#"<r:RDF xmlns:r="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:m="http://ns.justmaple.app/photo/1.0/"><r:Description xmlns:m="urn:foreign" m:InpaintRemovals="foreign opaque"/><r:Description m:InpaintRemovals="[]"/></r:RDF>"#;
    assert!(parse(owned_empty).unwrap().inpaint_removals.is_empty());
    for xml in [
        r#"<r:Description xmlns:r="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:papp="http://ns.justmaple.app/photo/1.0/" xmlns:m="http://ns.justmaple.app/photo/1.0/" papp:InpaintRemovals="[]" m:InpaintRemovals="[]"/>"#,
        r#"<r:Description xmlns:r="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:m="http://ns.justmaple.app/photo/1.0/" m:InpaintRemovals="[]"><m:InpaintRemovals>[]</m:InpaintRemovals></r:Description>"#,
        r#"<r:Description xmlns:r="http://www.w3.org/1999/02/22-rdf-syntax-ns#" m:InpaintRemovals="[]"/>"#,
        r#"<r:Description xmlns:r="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:m="http://ns.justmaple.app/photo/1.0/" m:InpaintRemovals="bad JSON"/>"#,
        r#"<r:Description xmlns:r="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:m="http://ns.justmaple.app/photo/1.0/"><m:InpaintRemovals><x>[]</x></m:InpaintRemovals></r:Description>"#,
    ] {
        assert!(parse(xml).is_err(), "{xml}");
    }
}
