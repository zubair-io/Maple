//! Namespace import feeds the existing adjustment walkers without a DOM copy.
use super::*;

fn sidecar(attributes: &str, children: &str) -> String {
    format!(
        r#"<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/" xmlns:papp="http://ns.justmaple.app/photo/1.0/"><rdf:Description {attributes}>{children}</rdf:Description></rdf:RDF>"#
    )
}

fn aliases(xml: &str) -> String {
    xml.replace("rdf:", "r:")
        .replace("crs:", "c:")
        .replace("papp:", "m:")
        .replace("xmlns:rdf=", "xmlns:r=")
        .replace("xmlns:crs=", "xmlns:c=")
        .replace("xmlns:papp=", "xmlns:m=")
}

#[test]
fn committed_local_mask_fixtures_match_canonical_reader() {
    for xml in [
        include_str!("../../../../../test-fixtures/local-adjustments/spatial-radial.xmp"),
        include_str!("../../../../../test-fixtures/local-adjustments/lightroom-paint.xmp"),
        include_str!("../../../../../test-fixtures/local-adjustments/lightroom-group-add.xmp"),
        include_str!("../../../../../test-fixtures/local-adjustments/lightroom-group-subtract.xmp"),
        include_str!(
            "../../../../../test-fixtures/local-adjustments/lightroom-group-intersect.xmp"
        ),
    ] {
        let expected = parse(xml).unwrap();
        assert_eq!(parse_namespaced(xml).unwrap(), expected);
        assert_eq!(parse_namespaced(&aliases(xml)).unwrap(), expected);
    }
}

#[test]
fn serialized_curves_retouch_and_modes_keep_shared_reader_semantics() {
    use crate::types::local_adjustment::Point2;
    use crate::types::retouch::{RetouchKind, RetouchSpot};
    let model = AdjustmentModel {
        exposure: 0.75,
        temperature: 6000.0,
        tint: 5.0,
        retouch_spots: vec![RetouchSpot {
            kind: RetouchKind::Heal,
            center: Point2::new(0.25, 0.5),
            source: Point2::new(0.75, 0.5),
            radius: 0.05,
            feather: 0.5,
            opacity: 1.0,
        }],
        ..Default::default()
    };
    let xml = sidecar(&serialize(&model), &serialize_retouch_areas(&model, ""));
    assert_eq!(
        parse_namespaced(&aliases(&xml)).unwrap(),
        parse(&xml).unwrap()
    );
    let curves = sidecar(
        r#"crs:ConvertToGrayscale="True" papp:FilmLook="None""#,
        "<papp:SceneLinearToneCurve><rdf:Seq><rdf:li><![CDATA[0, 0]]></rdf:li><rdf:li>255, 230</rdf:li></rdf:Seq></papp:SceneLinearToneCurve>",
    );
    assert_eq!(
        parse_namespaced(&aliases(&curves)).unwrap(),
        parse(&curves.replace("<![CDATA[0, 0]]>", "0, 0")).unwrap()
    );
}

#[test]
fn wb_legacy_uris_aliases_and_explicit_stamps_match_canonical_reader() {
    for stamp in ["", "papp:WbScaleVersion=\"5\"", "papp:WbScaleVersion=\"1\""] {
        let xml = sidecar(
            &format!(r#"crs:Temperature="6000" crs:Tint="5" {stamp}"#),
            "",
        );
        let expected = parse(&xml).unwrap();
        for uri in [
            "http://ns.justmaple.app/photo/1.0/",
            "http://ns.justmaple.app/1.0/",
            "https://maple.app/ns/1.0/",
        ] {
            let imported = aliases(&xml.replace("http://ns.justmaple.app/photo/1.0/", uri));
            assert_eq!(parse_namespaced(&imported).unwrap(), expected);
        }
    }
}

#[test]
fn opaque_foreign_and_workflow_records_cannot_override_current_development() {
    let xml = sidecar(
        r#"crs:Exposure2012="0.75" crs:Temperature="6000" crs:Tint="5""#,
        r#"<f:opaque xmlns:f="urn:foreign"><rdf:Description crs:Exposure2012="-3" crs:Contrast2012="100"/></f:opaque><papp:Workflow><rdf:Description crs:Exposure2012="-4"/></papp:Workflow><papp:SceneLinearToneCurve><rdf:Seq><f:opaque xmlns:f="urn:foreign"><rdf:li>255, 0</rdf:li></f:opaque><rdf:li>0, 0</rdf:li><rdf:li>255, 230</rdf:li></rdf:Seq></papp:SceneLinearToneCurve>"#,
    );
    let encoded_namespace = xml.replace("camera-raw", "camera&#45;raw");
    assert_eq!(parse_namespaced(&encoded_namespace).unwrap().exposure, 0.75);
    let imported = parse_namespaced(&aliases(&xml)).unwrap();
    assert_eq!(imported.exposure, 0.75);
    assert_eq!(imported.contrast, 0.0);
    assert_eq!(imported.tone_curve_luma.points.len(), 2);
    let foreign = r#"<RDF xmlns="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:crs="urn:foreign" xmlns:c="http://ns.adobe.com/camera-raw-settings/1.0/"><Description c:Exposure2012="1" c:Temperature="6000" c:Tint="5" crs:Contrast2012="100"/></RDF>"#;
    let imported = parse_namespaced(foreign).unwrap();
    assert_eq!(imported.exposure, 1.0);
    assert_eq!(imported.contrast, 0.0);
    assert_eq!(imported.wb_scale_version, WbScaleVersion::V5);
}

#[test]
fn complete_document_envelope_entities_and_unicode_remain_valid() {
    let xml = sidecar(
        r#"crs:Exposure2012="&#x31;.&#48;""#,
        "<工作 xmlns=\"urn:foreign\" 内容=\"&amp;&quot;&#x1F342;\">&lt;opaque&gt;</工作>",
    );
    for envelope in [
        xml.clone(),
        format!("<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>{xml}"),
        format!("\u{feff}<?xml version=\"1.0\"?>{xml}"),
        format!("<?xpacket begin=\"\u{feff}\"?>{xml}<?xpacket end=\"w\"?>"),
    ] {
        assert_eq!(parse_namespaced(&envelope).unwrap().exposure, 1.0);
    }
    assert_eq!(parse_namespaced("").unwrap(), AdjustmentModel::default());
}

#[test]
fn malformed_opaque_xml_is_rejected_without_importing_partial_adjustments() {
    for xml in [
        " ",
        "<x>",
        "<x/><y/>",
        "text<x/>",
        "<x/>text",
        "<1bad/>",
        "<x a:b:c=\"v\"/>",
        "<x a=\"<\"/>",
        "<x>]]></x>",
        "<![CDATA[text]]><x/>",
        "<x><y></x>",
        "<x p:v=\"1\"/>",
        "<x p:v=\"&bogus;\" xmlns:p=\"urn:foreign\"/>",
        "<x>&#x0;</x>",
        "<x>&#+65;</x>",
        "<x>&amp</x>",
        "<x>\u{1}</x>",
        "<!DOCTYPE x [<!ENTITY e 'value'>]><x>&e;</x>",
        "<x><!-- a--b --></x>",
        "<x/><?xml version=\"1.0\"?>",
        " <?xml version=\"1.0\"?><x/>",
        "<?xml?><x/>",
        "<?xml encoding=\"UTF-8\"?><x/>",
        "<?XML version=\"1.0\"?><x/>",
        "<?xml version=\"1.0\" version=\"1.0\"?><x/>",
        "<?xml version=\"1.0\" bogus=\"x\"?><x/>",
    ] {
        assert!(
            parse_namespaced(xml).is_err(),
            "accepted malformed XML: {xml}"
        );
    }
}
