//! Lightroom's `crs:Look` profile block (#4685) — the profile's own
//! `crs:Parameters` recipe is never the user's edit. Fixtures live under
//! `test-fixtures/look-profiles/`, shared with the Swift and TypeScript
//! suites.

use super::*;
use crate::types::adjustment::BlackWhiteMode;
use crate::workflow::SidecarWorkflow;

const ADOBE_COLOR: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../../test-fixtures/look-profiles/lightroom-adobe-color.xmp"
));
const ADOBE_MONOCHROME: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../../test-fixtures/look-profiles/lightroom-adobe-monochrome.xmp"
));

const USER_CURVE: &str = r#"   <crs:ToneCurvePV2012>
    <rdf:Seq>
     <rdf:li>0, 0</rdf:li>
     <rdf:li>128, 150</rdf:li>
     <rdf:li>255, 255</rdf:li>
    </rdf:Seq>
   </crs:ToneCurvePV2012>
"#;

fn look_subtree(xml: &str) -> &str {
    let start = xml.find("<crs:Look>").expect("fixture carries a crs:Look");
    let end = xml.find("</crs:Look>").expect("fixture closes crs:Look") + "</crs:Look>".len();
    &xml[start..end]
}

#[test]
fn adobe_color_look_is_not_a_user_edit() {
    let model = parse(ADOBE_COLOR).unwrap();
    assert!(model.display_tone_curve_luma.points.is_empty());
    assert_eq!(model, AdjustmentModel::default());
}

#[test]
fn adobe_monochrome_look_does_not_turn_on_grayscale() {
    let model = parse(ADOBE_MONOCHROME).unwrap();
    assert_eq!(model.black_white, BlackWhiteMode::Off);
    assert!(model.display_tone_curve_luma.points.is_empty());
    assert_eq!(model, AdjustmentModel::default());
}

#[test]
fn namespaced_import_ignores_the_look_too() {
    for fixture in [ADOBE_COLOR, ADOBE_MONOCHROME] {
        assert_eq!(
            parse_namespaced(fixture).unwrap(),
            AdjustmentModel::default()
        );
    }
}

#[test]
fn user_curve_beside_the_look_still_reads() {
    let xml = ADOBE_COLOR.replacen("   <crs:Look>", &format!("{USER_CURVE}   <crs:Look>"), 1);
    let model = parse(&xml).unwrap();
    assert_eq!(model.display_tone_curve_luma.points.len(), 3);
    assert!(model.display_tone_curve_luma.points[1].1 > 0.58);
    assert!(model.display_tone_curve_red.points.is_empty());
    assert_eq!(model.black_white, BlackWhiteMode::Off);
}

#[test]
fn look_under_an_aliased_camera_raw_prefix_is_skipped() {
    let xml = ADOBE_MONOCHROME
        .replacen(
            "<crs:Look>",
            r#"<lr:Look xmlns:lr="http://ns.adobe.com/camera-raw-settings/1.0/">"#,
            1,
        )
        .replacen("</crs:Look>", "</lr:Look>", 1);
    for model in [parse(&xml).unwrap(), parse_namespaced(&xml).unwrap()] {
        assert_eq!(model.black_white, BlackWhiteMode::Off);
        assert!(model.display_tone_curve_luma.points.is_empty());
    }
}

#[test]
fn look_in_a_non_primary_description_stays_skipped() {
    let xml = format!(
        r#"<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about="" xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/" crs:Exposure2012="+1.00"/>
  <rdf:Description rdf:about="urn:other" xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/">
   {}
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>"#,
        look_subtree(ADOBE_MONOCHROME)
    );
    let model = parse(&xml).unwrap();
    assert_eq!(model.exposure, 1.0);
    assert_eq!(model.black_white, BlackWhiteMode::Off);
    assert!(model.display_tone_curve_luma.points.is_empty());
}

#[test]
fn look_subtree_survives_a_workflow_round_trip_byte_for_byte() {
    for fixture in [ADOBE_COLOR, ADOBE_MONOCHROME] {
        let embedded = SidecarWorkflow::primary().embed_in_xmp(fixture).unwrap();
        assert!(embedded.contains(look_subtree(fixture)));
        assert_eq!(parse(&embedded).unwrap(), AdjustmentModel::default());
    }
}
