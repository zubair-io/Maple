//! The legacy `crs:RetouchInfo` fallback, the "spots remain" answer the frame
//! stamp follows and the sensor-frame conversion.
use super::*;
use raw_core::image::ExifOrientation;
use raw_core::pipeline::mask::display_to_sensor_norm;

const LEGACY: &str = "\n   <crs:RetouchInfo>\n    <rdf:Seq>\n     <rdf:li>centerX = 0.250000, centerY = 0.300000, radius = 0.020000, sourceState = sourceSetExplicitly, sourceX = 0.300000, sourceY = 0.300000, spotType = heal</rdf:li>\n    </rdf:Seq>\n   </crs:RetouchInfo>";

/// Lightroom's structured spots with a decodable legacy list beside them.
fn structured_and_legacy() -> Sidecar {
    let xml = std::fs::read_to_string(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../test-fixtures/retouch/lightroom-spots.xmp"),
    )
    .unwrap();
    let close = "</crs:RetouchAreas>";
    through_file_of(&xml.replacen(close, &format!("{close}{LEGACY}"), 1), &NAMES)
}

#[test]
fn clearing_the_structured_list_retires_the_legacy_fallback() {
    let source = structured_and_legacy();
    assert_eq!(rendered(&source.xml).len(), 2, "The structured list wins");
    let cleared = write(&source, &[]);
    assert!(
        rendered(&cleared.xml).is_empty(),
        "The legacy list must not render again: {}",
        cleared.xml
    );
    assert!(!cleared.xml.contains("crs:RetouchInfo"));
    assert_eq!(output(&source, &[])["spots"], json!(false));
}

#[test]
fn converting_a_legacy_list_keeps_what_raw_core_does_not_decode() {
    let xml = std::fs::read_to_string(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../test-fixtures/retouch/lightroom-legacy-info.xmp"),
    )
    .unwrap()
    .replacen("<crs:RetouchInfo>", "<crs:RetouchInfo vnd:Tag=\"kept\">", 1)
    .replacen(
        "    </rdf:Seq>\n   </crs:RetouchInfo>",
        "     <rdf:li>vendor = 1</rdf:li>\n    </rdf:Seq>\n    <vnd:Extra>note</vnd:Extra>\n   </crs:RetouchInfo>",
        1,
    );
    let source = through_file_of(&xml, &NAMES);
    let spots = read(&source);
    assert_eq!(spots.len(), 2);
    let saved = write(&source, &spots[..1]);
    assert_eq!(rendered(&saved.xml), vec![spots[0].0]);
    for kept in [
        "vnd:Tag=\"kept\"",
        "<rdf:li>vendor = 1</rdf:li>",
        "<vnd:Extra>note</vnd:Extra>",
    ] {
        assert!(saved.xml.contains(kept), "{kept} lost: {}", saved.xml);
    }
    assert!(!saved.xml.contains("centerX"), "{}", saved.xml);
    // Clearing the converted list leaves nothing for raw-core to fall back to.
    let cleared = write(&saved, &[]);
    assert!(rendered(&cleared.xml).is_empty(), "{}", cleared.xml);
}

#[test]
fn spots_remain_while_an_entry_android_keeps_still_renders() {
    // An `rdf:li` attribute keeps the first spot out of Android's list; raw-core renders it.
    let xml = std::fs::read_to_string(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../test-fixtures/retouch/lightroom-spots.xmp"),
    )
    .unwrap()
    .replacen(
        "<rdf:Seq>\n     <rdf:li>",
        "<rdf:Seq>\n     <rdf:li vnd:Row=\"1\">",
        1,
    );
    let source = through_file_of(&xml, &NAMES);
    let spots = read(&source);
    assert_eq!(spots.len(), 1);
    assert_eq!(rendered(&source.xml).len(), 2);
    let out = output(&source, &[]);
    assert_eq!(out["spots"], json!(true));
    assert_eq!(rendered(&splice(&source, &out)).len(), 1);
}

fn frame(source: &Sidecar, orientation: u16) -> Sidecar {
    let mut framed = through_file_of(&source.xml, &NAMES);
    framed.input["frame"] = json!({"orientation": orientation, "aspect": 1.5});
    framed
}

#[test]
fn a_sensor_framed_list_is_listed_and_written_upright() {
    let source = fixture("lightroom-spots.xmp");
    let sensor: Vec<RetouchSpot> = read(&source).iter().map(|(spot, _)| *spot).collect();
    let framed = frame(&source, 6);
    let spots = read(&framed);
    for ((upright, _), sensor) in spots.iter().zip(&sensor) {
        // raw-core's own mapping of an upright spot back onto the sensor.
        let center = display_to_sensor_norm(upright.center, ExifOrientation::Rotate90);
        assert!(
            (center.x - sensor.center.x).abs() < 1e-6 && (center.y - sensor.center.y).abs() < 1e-6
        );
        assert!((upright.radius * 1.5 - sensor.radius).abs() < 1e-6);
    }
    assert_ne!(spots[0].0.center, sensor[0].center);
    // Unchanged spots are still rewritten: the list is about to be stamped upright.
    let saved = write(&framed, &spots);
    let written = rendered(&saved.xml);
    for ((upright, _), written) in spots.iter().zip(&written) {
        assert!(
            (upright.center.x - written.center.x).abs() < 1e-5,
            "{}",
            saved.xml
        );
        assert!((upright.radius - written.radius).abs() < 1e-5);
    }
    assert!(
        saved.xml.contains("vnd:SpotNote"),
        "metadata travels with the rewrite"
    );
    // An upright EXIF orientation needs no conversion.
    assert_eq!(read(&frame(&source, 1)), read(&source));
}

#[test]
fn a_sensor_framed_list_with_entries_android_cannot_convert_is_refused() {
    let xml = std::fs::read_to_string(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../test-fixtures/retouch/lightroom-spots.xmp"),
    )
    .unwrap()
    .replacen(
        "<rdf:Seq>\n     <rdf:li>",
        "<rdf:Seq>\n     <rdf:li vnd:Row=\"1\">",
        1,
    );
    let framed = frame(&through_file_of(&xml, &NAMES), 6);
    let mut input = framed.input.clone();
    input["spots"] = json!([]);
    let refused = crate::retouch_write::write(&input).unwrap_err();
    assert!(refused.contains("cannot convert"), "{refused}");
}
