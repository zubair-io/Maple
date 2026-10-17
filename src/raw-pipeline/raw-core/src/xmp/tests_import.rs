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

const SPATIAL_RADIAL: &str =
    include_str!("../../../../../test-fixtures/local-adjustments/spatial-radial.xmp");
const GROUP_SUBTRACT: &str =
    include_str!("../../../../../test-fixtures/local-adjustments/lightroom-group-subtract.xmp");

/// A checkout with `core.autocrlf` hands `include_str!` CRLF fixtures, so every
/// mutation below anchors on a single line and runs against both endings.
fn line_endings(xml: &str) -> [String; 2] {
    let lf = xml.replace("\r\n", "\n");
    let crlf = lf.replace('\n', "\r\n");
    [lf, crlf]
}

#[test]
fn foreign_mask_component_drops_the_group_in_both_readers() {
    for fixture in line_endings(GROUP_SUBTRACT) {
        let gradient = fixture.find(r#"crs:What="Mask/Gradient""#).unwrap();
        let subtract_li = fixture[..gradient].rfind("<rdf:li").unwrap();
        let xml = format!(
            "{}<f:li xmlns:f=\"urn:foreign\"{}",
            &fixture[..subtract_li],
            &fixture[subtract_li + "<rdf:li".len()..]
        );
        assert!(xml.contains("<f:li"));
        let expected = parse(&xml).unwrap();
        assert!(expected.local_adjustments.is_empty());
        assert_eq!(parse_namespaced(&xml).unwrap(), expected);
        assert_eq!(parse_namespaced(&aliases(&xml)).unwrap(), expected);
    }
}

#[test]
fn foreign_mask_component_attributes_and_children_stay_opaque() {
    for fixture in line_endings(SPATIAL_RADIAL) {
        let expected = parse(&fixture).unwrap();
        assert_eq!(expected.local_adjustments.len(), 1);
        let with_foreign_sibling = fixture.replacen(
            "</rdf:Seq>",
            r#"<f:li xmlns:f="urn:foreign" crs:What="Mask/CircularGradient" crs:MaskValue="1" crs:LocalExposure2012="4"><rdf:Description crs:Exposure2012="-4" crs:LocalExposure2012="4"/>text</f:li></rdf:Seq>"#,
            1,
        );
        assert!(with_foreign_sibling.contains("<f:li"));
        assert_eq!(parse(&with_foreign_sibling).unwrap(), expected);
        assert_eq!(parse_namespaced(&with_foreign_sibling).unwrap(), expected);
    }
}

#[test]
fn legacy_maple_namespace_uri_owns_local_attributes_in_both_readers() {
    for fixture in line_endings(SPATIAL_RADIAL) {
        let vibrant = fixture.replacen(
            r#"crs:LocalExposure2012="0.35""#,
            r#"crs:LocalExposure2012="0.35" papp:LocalVibrance="-10""#,
            1,
        );
        assert_ne!(vibrant, fixture);
        let expected = parse(&vibrant).unwrap();
        assert_eq!(
            expected.local_adjustments[0].adjustments.vibrance,
            Some(-10.0)
        );
        let legacy = vibrant.replace(
            r#"xmlns:papp="http://ns.justmaple.app/1.0/""#,
            r#"xmlns:papp="https://maple.app/ns/1.0/""#,
        );
        assert_ne!(legacy, vibrant);
        assert_eq!(parse(&legacy).unwrap(), expected);
        assert_eq!(parse_namespaced(&legacy).unwrap(), expected);
    }
}

#[test]
fn multi_description_sidecar_hydrates_curves_gradients_and_retouch_across_siblings() {
    let xml = r#"<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
    <rdf:Description rdf:about=""
      xmlns:tiff="http://ns.adobe.com/tiff/1.0/"
      xmlns:xmp="http://ns.adobe.com/xap/1.0/"
      xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
      tiff:Make="Fujifilm"
      xmp:Rating="4"
      crs:Exposure2012="+0.35"/>
    <rdf:Description rdf:about=""
      xmlns:aux="http://ns.adobe.com/exif/1.0/aux/"
      xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
      xmlns:xmpMM="http://ns.adobe.com/xap/1.0/mm/"
      xmlns:stEvt="http://ns.adobe.com/xap/1.0/sType/ResourceEvent#"
      aux:Lens="XF35mmF1.4 R"
      crs:Contrast2012="+15">
      <crs:ToneCurvePV2012>
        <rdf:Seq><rdf:li>0, 0</rdf:li><rdf:li>128, 140</rdf:li><rdf:li>255, 255</rdf:li></rdf:Seq>
      </crs:ToneCurvePV2012>
      <crs:GradientBasedCorrections>
        <rdf:Seq><rdf:li><rdf:Description crs:What="Correction" crs:CorrectionAmount="1" crs:CorrectionActive="True" crs:LocalExposure2012="0.5"><crs:CorrectionMasks><rdf:Seq><rdf:li crs:What="Mask/Gradient" crs:MaskValue="1" crs:ZeroX="0.2" crs:ZeroY="0.3" crs:FullX="0.8" crs:FullY="0.7"/></rdf:Seq></crs:CorrectionMasks></rdf:Description></rdf:li></rdf:Seq>
      </crs:GradientBasedCorrections>
      <crs:RetouchAreas>
        <rdf:Seq><rdf:li><rdf:Description crs:SpotType="heal" crs:SourceState="sourceSetExplicitly" crs:Method="circle" crs:SourceX="0.400000" crs:SourceY="0.500000" crs:Opacity="1.000000" crs:Feather="0.250000" crs:Seed="0"><crs:Masks><rdf:Seq><rdf:li crs:What="Mask/CircularGradient" crs:MaskValue="1" crs:X="0.200000" crs:Y="0.300000" crs:Radius="0.020000" crs:Flow="1" crs:CenterWeight="0"/></rdf:Seq></crs:Masks></rdf:Description></rdf:li></rdf:Seq>
      </crs:RetouchAreas>
      <xmpMM:History><rdf:Seq><rdf:li stEvt:action="saved"/></rdf:Seq></xmpMM:History>
    </rdf:Description>
  </rdf:RDF>
  <vendor:Audit xmlns:vendor="https://vendor.test/" vendor:Step="ingest"/>
</x:xmpmeta>
<?xpacket end="w"?>"#;
    let parsed = parse(xml).unwrap();
    assert_eq!(parse_namespaced(xml).unwrap(), parsed);
    assert!((parsed.exposure - 0.35).abs() < 1e-6);
    assert!((parsed.contrast - 15.0).abs() < 1e-6);
    assert_eq!(parsed.display_tone_curve_luma.points.len(), 3);
    assert_eq!(parsed.local_adjustments.len(), 1);
    assert_eq!(parsed.retouch_spots.len(), 1);
}

#[test]
fn foreign_subject_descriptions_are_ignored_in_both_readers() {
    let sibling_foreign = r#"<x:xmpmeta xmlns:x="adobe:ns:meta/">
  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
    <rdf:Description rdf:about=""
      xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
      crs:Exposure2012="+0.50"/>
    <rdf:Description rdf:about="other-subject"
      xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
      crs:Exposure2012="+2.25"
      crs:Contrast2012="+40">
      <crs:ToneCurvePV2012>
        <rdf:Seq><rdf:li>0, 0</rdf:li><rdf:li>128, 160</rdf:li><rdf:li>255, 255</rdf:li></rdf:Seq>
      </crs:ToneCurvePV2012>
    </rdf:Description>
    <rdf:Description rdf:nodeID="blank1"
      xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
      crs:Highlights2012="-55"/>
    <rdf:Description
      xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
      crs:Shadows2012="+65"/>
  </rdf:RDF>
</x:xmpmeta>"#;
    let parsed = parse(sibling_foreign).unwrap();
    assert_eq!(parse_namespaced(sibling_foreign).unwrap(), parsed);
    assert!((parsed.exposure - 0.50).abs() < 1e-6);
    assert_eq!(parsed.contrast, 0.0);
    assert_eq!(parsed.highlights, 0.0);
    assert_eq!(parsed.shadows, 0.0);
    assert!(parsed.display_tone_curve_luma.points.is_empty());

    let preceding_foreign = r#"<x:xmpmeta xmlns:x="adobe:ns:meta/">
  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
    <rdf:Description rdf:about="other-subject"
      xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
      crs:Exposure2012="+2.25"
      crs:Contrast2012="+40"/>
    <rdf:Description rdf:about=""
      xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
      crs:Exposure2012="+0.75"/>
  </rdf:RDF>
</x:xmpmeta>"#;
    let parsed_preceding = parse(preceding_foreign).unwrap();
    assert_eq!(
        parse_namespaced(preceding_foreign).unwrap(),
        parsed_preceding
    );
    assert!((parsed_preceding.exposure - 0.75).abs() < 1e-6);
    assert_eq!(parsed_preceding.contrast, 0.0);

    let two_anonymous = r#"<x:xmpmeta xmlns:x="adobe:ns:meta/">
  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
    <rdf:Description
      xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
      crs:Exposure2012="+0.60"/>
    <rdf:Description
      xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
      crs:Contrast2012="+30"/>
  </rdf:RDF>
</x:xmpmeta>"#;
    let parsed_anon = parse(two_anonymous).unwrap();
    assert_eq!(parse_namespaced(two_anonymous).unwrap(), parsed_anon);
    assert!((parsed_anon.exposure - 0.60).abs() < 1e-6);
    assert_eq!(parsed_anon.contrast, 0.0);
}
