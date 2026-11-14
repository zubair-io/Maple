//! Real sidecar files through the repair-spot entries, cut and spliced the
//! way Android's `XmpDocument` does (`sidecar_tests`).
use super::*;
use crate::retouch_document::{spot_from_json, spot_json};
use crate::sidecar_tests::{call, splice, through_file_of, vendor_names, Sidecar, INDENT};
use raw_core::types::{Point2, RetouchKind, RetouchSpot};
use serde_json::{json, Value};

const NAMES: [&str; 2] = ["crs:RetouchAreas", "crs:RetouchInfo"];

fn fixture(name: &str) -> Sidecar {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../test-fixtures/retouch")
        .join(name);
    through_file_of(&std::fs::read_to_string(path).unwrap(), &NAMES)
}

fn read(document: &Sidecar) -> Vec<(RetouchSpot, Option<usize>)> {
    call(maple_android_retouch_read, &document.input)["spots"]
        .as_array()
        .unwrap()
        .iter()
        .map(|spot| spot_from_json(spot).unwrap())
        .collect()
}

fn output(document: &Sidecar, spots: &[(RetouchSpot, Option<usize>)]) -> Value {
    let mut input = document.input.clone();
    input["spots"] = json!(spots
        .iter()
        .map(|(spot, slot)| spot_json(spot, *slot))
        .collect::<Vec<_>>());
    call(maple_android_retouch_write, &input)
}

/// Writes `spots`, splices the result into the sidecar and saves it to disk.
fn write(document: &Sidecar, spots: &[(RetouchSpot, Option<usize>)]) -> Sidecar {
    through_file_of(&splice(document, &output(document, spots)), &NAMES)
}

fn rendered(xml: &str) -> Vec<RetouchSpot> {
    raw_core::xmp::parse_namespaced(xml).unwrap().retouch_spots
}

fn outside_areas(xml: &str) -> (String, String) {
    let start = xml.find("<crs:RetouchAreas").unwrap();
    let end = xml.rfind("</crs:RetouchAreas>").unwrap() + "</crs:RetouchAreas>".len();
    (xml[..start].to_owned(), xml[end..].to_owned())
}

/// A new spot whose values survive the writer's six-decimal precision exactly.
fn new_spot(x: f32, y: f32, source_x: f32) -> RetouchSpot {
    RetouchSpot {
        kind: RetouchKind::Clone,
        center: Point2::new(x, y),
        source: Point2::new(source_x, y),
        radius: 0.03,
        feather: 0.4,
        opacity: 0.9,
    }
}

#[test]
fn lightroom_spots_read_as_raw_core_renders_them() {
    let source = fixture("lightroom-spots.xmp");
    let spots = read(&source);
    assert_eq!(
        spots.iter().map(|(_, slot)| *slot).collect::<Vec<_>>(),
        [Some(0), Some(1)],
        "The brush heal is not modelled, so it is neither listed nor addressable"
    );
    let listed: Vec<RetouchSpot> = spots.iter().map(|(spot, _)| *spot).collect();
    assert_eq!(listed, rendered(&source.xml));
    let heal = listed[0];
    assert_eq!(heal.kind, RetouchKind::Heal);
    assert!((heal.source.x - 0.4325).abs() < 1e-6 && (heal.source.y - 0.36625).abs() < 1e-6);
    assert_eq!(listed[1].kind, RetouchKind::Clone);
}

#[test]
fn writing_the_read_spots_back_keeps_every_byte() {
    for name in ["lightroom-spots.xmp", "lightroom-legacy-info.xmp"] {
        let source = fixture(name);
        let spots = read(&source);
        let written = output(&source, &spots);
        if name == "lightroom-spots.xmp" {
            assert_eq!(splice(&source, &written), source.xml, "{name}");
        } else {
            // A legacy list has no structured entry to keep; Kotlin only
            // writes after a change, which converts it (see below).
            assert_eq!(spots.len(), 2);
        }
    }
}

#[test]
fn editing_a_lightroom_spot_keeps_its_metadata_and_every_other_byte() {
    let source = fixture("lightroom-spots.xmp");
    let mut spots = read(&source);
    spots[0].0.center = Point2::new(0.25, 0.5);
    spots[0].0.kind = RetouchKind::Clone;
    spots[0].0.opacity = 0.6;
    let saved = write(&source, &spots);

    let listed: Vec<RetouchSpot> = spots.iter().map(|(spot, _)| *spot).collect();
    assert_eq!(rendered(&saved.xml), listed);
    assert_eq!(read(&saved), spots, "Reopened spots keep their entries");
    assert_eq!(outside_areas(&saved.xml), outside_areas(&source.xml));
    for kept in [
        "crs:Seed=\"1306\"",
        "crs:Flow=\"0.850000\"",
        "crs:CenterWeight=\"0.100000\"",
        "crs:AreaSyncID=\"5904000000000000000000000000A001\"",
        "crs:MaskSyncID=\"5904000000000000000000000000B001\"",
        "vnd:Reviewed=\"kept &amp; exact\"",
        "<vnd:SpotNote>dust on the sensor</vnd:SpotNote>",
    ] {
        assert!(saved.xml.contains(kept), "{kept} survives the edit");
    }
    assert!(
        !saved.xml.contains("crs:OffsetX"),
        "The source is restated as SourceX/Y"
    );
    assert!(!saved.xml.contains("sourceAutoComputed"));
    // The untouched clone and the unmodelled brush keep their bytes.
    let entries =
        |xml: &str| -> Vec<String> { xml.split("<rdf:li>\n").skip(1).map(str::to_owned).collect() };
    assert_eq!(entries(&saved.xml)[1..], entries(&source.xml)[1..]);
}

#[test]
fn a_leaf_restoring_a_prefix_its_spot_shadows_keeps_its_namespace() {
    // `vnd` is urn:example:vendor on the description, urn:inner on the first
    // spot and urn:example:vendor again on its mask leaf.
    let xml = fixture("lightroom-spots.xmp")
        .xml
        .replacen(
            " vnd:Reviewed=",
            " xmlns:vnd=\"urn:inner\" vnd:Reviewed=",
            1,
        )
        .replacen(
            "B001\"/>",
            "B001\" xmlns:vnd=\"urn:example:vendor\" vnd:Leaf=\"top\"><vnd:Mark>kept</vnd:Mark></rdf:li>",
            1,
        );
    let source = through_file_of(&xml, &NAMES);
    let expected = [
        ("Reviewed", "urn:inner"),
        ("SpotNote", "urn:inner"),
        ("Leaf", "urn:example:vendor"),
        ("Mark", "urn:example:vendor"),
    ];
    for (local, uri) in expected {
        assert_eq!(vendor_names(&source.xml, local), [uri], "{local}");
    }
    let mut spots = read(&source);
    spots[0].0.center = Point2::new(0.25, 0.5);
    let saved = write(&source, &spots);
    for (local, uri) in expected {
        assert_eq!(
            vendor_names(&saved.xml, local),
            [uri],
            "{local} in\n{}",
            saved.xml
        );
    }
    assert_eq!(read(&saved), spots);
}

#[test]
fn unprefixed_nodes_under_a_default_namespace_reset_keep_no_namespace() {
    // The sequence's default namespace is urn:seq; the first spot resets it.
    let xml = fixture("lightroom-spots.xmp")
        .xml
        .replacen("<rdf:Seq>", "<rdf:Seq xmlns=\"urn:seq\">", 1)
        .replacen(" vnd:Reviewed=", " xmlns=\"\" vnd:Reviewed=", 1)
        .replacen(
            "<vnd:SpotNote>dust on the sensor</vnd:SpotNote>",
            "<Memo>dust on the sensor</Memo>",
            1,
        )
        .replacen("B001\"/>", "B001\"><Mark>kept</Mark></rdf:li>", 1);
    let source = through_file_of(&xml, &NAMES);
    for local in ["Memo", "Mark"] {
        assert_eq!(vendor_names(&source.xml, local), [""], "{local}");
    }
    let mut spots = read(&source);
    spots[0].0.center = Point2::new(0.25, 0.5);
    let saved = write(&source, &spots);
    for local in ["Memo", "Mark"] {
        assert_eq!(
            vendor_names(&saved.xml, local),
            [""],
            "{local} in\n{}",
            saved.xml
        );
    }
    assert_eq!(read(&saved), spots);
}

#[test]
fn deleting_and_adding_spots_keeps_the_unmodelled_entry_in_place() {
    let source = fixture("lightroom-spots.xmp");
    let spots = read(&source);
    let added = new_spot(0.8, 0.2, 0.85);
    let saved = write(&source, &[spots[0], (added, None)]);
    assert_eq!(rendered(&saved.xml), vec![spots[0].0, added]);
    assert!(saved.xml.contains("crs:Method=\"brush\""));
    assert!(
        saved.xml.find("Mask/Paint").unwrap() < saved.xml.find("crs:SourceX=\"0.850000\"").unwrap(),
        "A new spot applies after every spot that was read"
    );
    assert_eq!(read(&saved).len(), 2);

    let cleared = write(&saved, &[]);
    assert!(rendered(&cleared.xml).is_empty());
    assert!(
        cleared.xml.contains("Mask/Paint"),
        "Only Android's spots are deleted"
    );
    assert_eq!(outside_areas(&cleared.xml), outside_areas(&source.xml));
}

#[test]
fn a_sidecar_without_repairs_gains_one_canonical_container() {
    let xml = "<x:xmpmeta xmlns:x=\"adobe:ns:meta/\">\n <rdf:RDF xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\">\n  <rdf:Description rdf:about=\"\" xmlns:c=\"http://ns.adobe.com/camera-raw-settings/1.0/\" c:Exposure2012=\"0.5\">\n   <f:Note xmlns:f=\"urn:vendor\">kept</f:Note>\n  </rdf:Description>\n </rdf:RDF>\n</x:xmpmeta>\n";
    let source = through_file_of(xml, &NAMES);
    assert!(read(&source).is_empty());
    let spot = new_spot(0.3, 0.3, 0.35);
    let saved = write(&source, &[(spot, None)]);
    assert_eq!(rendered(&saved.xml), vec![spot]);
    assert_eq!(read(&saved), vec![(spot, Some(0))]);
    assert!(saved
        .xml
        .contains("<f:Note xmlns:f=\"urn:vendor\">kept</f:Note>"));
    assert!(saved.xml.contains(&format!("\n{INDENT}<crs:RetouchAreas")));
    assert_eq!(
        raw_core::xmp::parse_namespaced(&saved.xml)
            .unwrap()
            .exposure,
        0.5
    );
}

#[test]
fn an_edited_legacy_list_converts_to_the_structured_container() {
    let source = fixture("lightroom-legacy-info.xmp");
    let spots = read(&source);
    assert_eq!(
        spots.iter().map(|(_, slot)| *slot).collect::<Vec<_>>(),
        vec![Some(0), Some(1)]
    );
    assert_eq!(
        spots.iter().map(|(spot, _)| *spot).collect::<Vec<_>>(),
        rendered(&source.xml)
    );
    let saved = write(&source, &spots[..1]);
    assert!(!saved.xml.contains("crs:RetouchInfo"));
    assert_eq!(rendered(&saved.xml), vec![spots[0].0]);
    assert!(saved
        .xml
        .contains("<vnd:Keep>outside the repair list</vnd:Keep>"));
    assert_eq!(read(&saved), vec![(spots[0].0, Some(0))]);
}

#[test]
fn self_closing_empty_legacy_containers_read_as_empty_lists() {
    let legacy = fixture("lightroom-legacy-info.xmp").xml;
    let (head, tail) = legacy.split_once("   <crs:RetouchInfo>").unwrap();
    let tail = tail.split_once("</crs:RetouchInfo>").unwrap().1;
    for container in [
        "<crs:RetouchInfo/>",
        "<crs:RetouchInfo />",
        "<crs:RetouchInfo vnd:Tag=\"kept\"/>",
        "<crs:RetouchInfo>\n    </crs:RetouchInfo>",
        "<crs:RetouchInfo><rdf:Seq/></crs:RetouchInfo>",
        "<crs:RetouchInfo><rdf:Seq /></crs:RetouchInfo>",
    ] {
        let xml = format!("{head}   {container}{tail}");
        let source = through_file_of(&xml, &NAMES);
        assert!(rendered(&source.xml).is_empty(), "{container}");
        assert!(read(&source).is_empty(), "{container}");
        let spot = new_spot(0.3, 0.3, 0.35);
        let saved = write(&source, &[(spot, None)]);
        assert_eq!(rendered(&saved.xml), vec![spot], "{container}");
        assert_eq!(read(&saved), vec![(spot, Some(0))], "{container}");
    }
    // Alongside a structured list, an empty self-closing legacy container
    // must not stop the structured spots from being read or written.
    let xml = fixture("lightroom-spots.xmp")
        .xml
        .replace("   <vnd:Keep>", "   <crs:RetouchInfo/>\n   <vnd:Keep>");
    let source = through_file_of(&xml, &NAMES);
    let spots = read(&source);
    assert_eq!(spots.len(), 2);
    assert_eq!(read(&write(&source, &spots)), spots);
}

#[test]
fn spots_must_name_authored_entries_in_their_read_order() {
    let source = fixture("lightroom-spots.xmp");
    let spots = read(&source);
    let reject = |list: Vec<(RetouchSpot, Option<usize>)>| {
        let mut input = source.input.clone();
        input["spots"] = json!(list
            .iter()
            .map(|(spot, slot)| spot_json(spot, *slot))
            .collect::<Vec<_>>());
        assert!(crate::retouch_write::write(&input).is_err());
    };
    reject(vec![spots[1], spots[0]]);
    reject(vec![(spots[0].0, Some(2))]);
    reject(vec![(new_spot(0.1, 0.1, 0.15), None), spots[0]]);
    reject(vec![(
        RetouchSpot {
            radius: 0.0,
            ..spots[0].0
        },
        Some(0),
    )]);
}

#[test]
fn a_new_spot_applies_after_the_spots_of_a_later_kept_container() {
    let areas = |spot: RetouchSpot| {
        let model = raw_core::types::AdjustmentModel {
            retouch_spots: vec![spot],
            ..Default::default()
        };
        raw_core::xmp::serialize_retouch_areas(&model, "   ")
    };
    let (first, kept) = (new_spot(0.2, 0.2, 0.25), new_spot(0.6, 0.6, 0.65));
    // A vendor attribute on its container keeps the second list verbatim.
    let opaque = areas(kept).replacen(
        "<crs:RetouchAreas>",
        "<crs:RetouchAreas xmlns:f=\"urn:vendor\" f:Tag=\"kept\">",
        1,
    );
    let description = |areas: String| {
        format!("  <rdf:Description rdf:about=\"\" xmlns:crs=\"http://ns.adobe.com/camera-raw-settings/1.0/\">\n{areas}\n  </rdf:Description>\n")
    };
    let xml = format!(
        "<x:xmpmeta xmlns:x=\"adobe:ns:meta/\">\n <rdf:RDF xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\">\n{}{} </rdf:RDF>\n</x:xmpmeta>\n",
        description(areas(first)),
        description(opaque)
    );
    let source = through_file_of(&xml, &NAMES);
    assert_eq!(rendered(&source.xml), vec![first, kept], "{}", source.xml);
    let spots = read(&source);
    assert_eq!(spots, vec![(first, Some(0))]);
    let added = new_spot(0.8, 0.8, 0.85);
    let saved = write(&source, &[spots[0], (added, None)]);
    assert_eq!(
        rendered(&saved.xml),
        vec![first, kept, added],
        "{}",
        saved.xml
    );
}

#[test]
fn rewritten_spots_bind_camera_raw_below_a_sequence_that_rebinds_its_prefix() {
    const CRS: &str = "http://ns.adobe.com/camera-raw-settings/1.0/";
    let first = new_spot(0.2, 0.2, 0.25);
    let model = raw_core::types::AdjustmentModel {
        retouch_spots: vec![first],
        ..Default::default()
    };
    let block = raw_core::xmp::serialize_retouch_areas(&model, "   ");
    let (head, tail) = block.split_once("<rdf:Seq>").unwrap();
    // The sequence takes `crs` for a vendor; its entries name Camera Raw `c:`.
    let tail = tail
        .replace("crs:", "c:")
        .replace("</c:RetouchAreas>", "</crs:RetouchAreas>");
    for root in [
        "<crs:RetouchAreas>",
        &format!("<crs:RetouchAreas xmlns:crs=\"{CRS}\">"),
    ] {
        let areas = format!(
            "{}<rdf:Seq xmlns:crs=\"urn:vendor\">{tail}",
            head.replacen("<crs:RetouchAreas>", root, 1)
        );
        let xml = format!(
            "<x:xmpmeta xmlns:x=\"adobe:ns:meta/\">\n <rdf:RDF xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\">\n  <rdf:Description rdf:about=\"\" xmlns:crs=\"{CRS}\" xmlns:c=\"{CRS}\">\n{areas}\n  </rdf:Description>\n </rdf:RDF>\n</x:xmpmeta>\n"
        );
        let source = through_file_of(&xml, &NAMES);
        let spots = read(&source);
        assert_eq!(spots, vec![(first, Some(0))], "{xml}");
        let mut moved = spots[0];
        moved.0.center = Point2::new(0.4, 0.4);
        let added = new_spot(0.8, 0.8, 0.85);
        let saved = write(&source, &[moved, (added, None)]);
        assert_eq!(rendered(&saved.xml), vec![moved.0, added], "{}", saved.xml);
        assert_eq!(read(&saved), vec![(moved.0, Some(0)), (added, Some(1))]);
    }
}

#[path = "retouch_frame_tests.rs"]
mod frame;
