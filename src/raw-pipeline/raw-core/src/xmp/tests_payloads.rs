//! XMP parser tests — structured JSON payload attributes. Split out of the
//! sibling `tests_modes.rs` (#376) to keep both files under the 600-LOC
//! hard cap (CONTRIBUTING.md § File-size budget). Covers the two `papp:`
//! attributes whose value is an encoded JSON blob rather than a scalar or
//! an enum spelling:
//!   * `papp:LocalAdjustments` (ticket #280)
//!   * `papp:InpaintRemovals` (ticket #1486)

#![cfg(test)]

use super::*;

#[test]
fn default_local_adjustments_is_empty() {
    let m = AdjustmentModel::default();
    assert!(m.local_adjustments.is_empty());
}

#[test]
fn parse_local_adjustments_linear_round_trips() {
    use crate::types::local_adjustment::{
        encode_local_adjustments, LocalAdjustment, Mask, PartialAdjustments, Point2,
    };
    let layers = vec![LocalAdjustment {
        mask: Mask::Linear {
            start: Point2::new(0.0, 0.5),
            end: Point2::new(1.0, 0.5),
            feather: 0.5,
        },
        range: None,
        adjustments: PartialAdjustments {
            exposure: Some(1.0),
            ..Default::default()
        },
    }];
    let attr = encode_local_adjustments(&layers);
    // The attribute embeds JSON containing double-quotes; escape them
    // for the XML literal here.
    let escaped = attr.replace('"', "&quot;");
    let xml = format!(
        r#"<?xml version="1.0"?><x><rdf:Description xmlns:rdf="x" xmlns:papp="x"
            papp:LocalAdjustments="{escaped}"/></x>"#
    );
    let m = parse(&xml).expect("parse");
    assert_eq!(m.local_adjustments, layers);
}

#[test]
fn parse_local_adjustments_malformed_errors() {
    let xml = r#"<?xml version="1.0"?><x><rdf:Description xmlns:rdf="x" xmlns:papp="x"
        papp:LocalAdjustments="{not json}"/></x>"#;
    assert!(parse(xml).is_err());
}

// -----------------------------------------------------------------
// Inpaint removals (ticket #1486).
// -----------------------------------------------------------------

#[test]
fn default_inpaint_removals_is_empty() {
    let m = AdjustmentModel::default();
    assert!(m.inpaint_removals.is_empty());
}

#[test]
fn parse_inpaint_removals_round_trips() {
    use crate::types::inpaint::{encode_removals, BakeGrade, Removal};
    let removals = vec![Removal {
        region: [0.25, 0.1, 0.5, 0.4],
        patch_ref: "blake3:deadbeef".to_string(),
        model_version: "lama-bigl-1".to_string(),
        bake: BakeGrade {
            temperature: 5500.0,
            tint: 4.0,
            exposure: 0.3,
        },
    }];
    let attr = encode_removals(&removals).unwrap();
    let escaped = attr.replace('"', "&quot;");
    let xml = format!(
        r#"<?xml version="1.0"?><x><rdf:Description xmlns:rdf="x" xmlns:papp="x"
            papp:InpaintRemovals="{escaped}"/></x>"#
    );
    let m = parse(&xml).expect("parse");
    assert_eq!(m.inpaint_removals, removals);
}

fn write_inpaint_sidecar(dir: &std::path::Path, name: &str, payload: &str) -> std::path::PathBuf {
    let escaped = payload
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('"', "&quot;");
    let xml = format!(
        r#"<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/" xmlns:papp="http://ns.justmaple.app/photo/1.0/" crs:Exposure2012="+0.50" papp:InpaintRemovals="{escaped}"/></rdf:RDF></x:xmpmeta>"#
    );
    let path = dir.join(name);
    std::fs::write(&path, xml).expect("write sidecar");
    path
}

fn read_sidecar(path: &std::path::Path) -> String {
    std::fs::read_to_string(path).expect("read sidecar")
}

#[test]
fn inpaint_removals_round_trip_through_a_sidecar_file() {
    use crate::types::inpaint::{encode_removals, BakeGrade, Removal};
    let removals = vec![
        Removal {
            region: [0.25, 0.1, 0.5, 0.4],
            patch_ref: "blake3:deadbeef".to_string(),
            model_version: "fixture & <model>".to_string(),
            bake: BakeGrade {
                temperature: 5500.0,
                tint: 4.0,
                exposure: 0.3,
            },
        },
        Removal {
            region: [0.0, 0.0, 1.0, 1.0],
            patch_ref: "blake3:cafe".to_string(),
            model_version: "fixture".to_string(),
            bake: BakeGrade {
                temperature: 6500.0,
                tint: 0.0,
                exposure: -1.0,
            },
        },
    ];
    let dir = tempfile::tempdir().expect("temp dir");
    let path = write_inpaint_sidecar(
        dir.path(),
        "photo.xmp",
        &encode_removals(&removals).unwrap(),
    );
    let xml = read_sidecar(&path);
    for model in [parse(&xml).unwrap(), parse_namespaced(&xml).unwrap()] {
        assert_eq!(model.inpaint_removals, removals);
        assert_eq!(model.exposure, 0.5);
    }
}

#[test]
fn inpaint_sidecar_file_with_an_unknown_kind_keeps_its_removal() {
    let payload = r#"[{"kind":"sky-replace","schema":9},{"schema":2,"kind":"removal","region":[0.25,0.25,0.5,0.5],"patch":"blake3:ab","model":"m","bake":{"temp":6500,"tint":0,"ev":0}}]"#;
    let dir = tempfile::tempdir().expect("temp dir");
    let xml = read_sidecar(&write_inpaint_sidecar(dir.path(), "photo.xmp", payload));
    for model in [parse(&xml).unwrap(), parse_namespaced(&xml).unwrap()] {
        assert_eq!(model.inpaint_removals.len(), 1);
        assert_eq!(model.inpaint_removals[0].region, [0.25, 0.25, 0.5, 0.5]);
    }
}

#[test]
fn inpaint_removal_refused_only_by_a_check_new_in_3933_does_not_apply_and_does_not_fail_the_parse()
{
    let record = |schema: &str, region: &str, patch: &str| {
        format!(
            r#"[{{"schema":{schema},"kind":"removal","region":{region},"patch":"{patch}","model":"m","bake":{{"temp":6500,"tint":0,"ev":0}}}}]"#
        )
    };
    let dir = tempfile::tempdir().expect("temp dir");
    let control = read_sidecar(&write_inpaint_sidecar(
        dir.path(),
        "control.xmp",
        &record("2", "[0.25,0.25,0.5,0.5]", "blake3:ab"),
    ));
    assert_eq!(parse(&control).unwrap().inpaint_removals.len(), 1);
    for (name, payload) in [
        (
            "schema-3.xmp",
            record("3", "[0.25,0.25,0.5,0.5]", "blake3:ab"),
        ),
        (
            "schema-5.xmp",
            record("5", "[0.25,0.25,0.5,0.5]", "blake3:ab"),
        ),
        (
            "out-of-frame.xmp",
            record("2", "[0.75,0.25,0.5,0.5]", "blake3:ab"),
        ),
        (
            "non-finite.xmp",
            record("2", "[0.25,0.25,1e300,0.5]", "blake3:ab"),
        ),
        (
            "path-escape.xmp",
            record("2", "[0.25,0.25,0.5,0.5]", "../../x"),
        ),
    ] {
        let xml = read_sidecar(&write_inpaint_sidecar(dir.path(), name, &payload));
        for model in [parse(&xml).unwrap(), parse_namespaced(&xml).unwrap()] {
            assert!(model.inpaint_removals.is_empty(), "{name}: applied");
            assert_eq!(model.exposure, 0.5, "{name}: render fields");
        }
    }
}

#[test]
fn inpaint_removal_refused_only_by_a_new_check_keeps_its_valid_neighbour() {
    let payload = r#"[{"schema":3,"kind":"removal","region":[0.1,0.1,0.2,0.2],"patch":"p","model":"m","bake":{"temp":1,"tint":0,"ev":0}},{"schema":2,"kind":"removal","region":[0.25,0.25,0.5,0.5],"patch":"q","model":"m","bake":{"temp":6500,"tint":0,"ev":0}}]"#;
    let dir = tempfile::tempdir().expect("temp dir");
    let xml = read_sidecar(&write_inpaint_sidecar(dir.path(), "photo.xmp", payload));
    for model in [parse(&xml).unwrap(), parse_namespaced(&xml).unwrap()] {
        assert_eq!(model.inpaint_removals.len(), 1);
        assert_eq!(model.inpaint_removals[0].patch_ref, "q");
    }
}

#[test]
fn committed_calibration_sidecar_with_a_schema_4_removal_still_parses_and_applies_none() {
    let xml = include_str!("../../../../../test-fixtures/removal/calibration/saved.xmp");
    for model in [parse(xml).unwrap(), parse_namespaced(xml).unwrap()] {
        assert!(model.inpaint_removals.is_empty());
        assert_eq!(model.exposure, AdjustmentModel::default().exposure);
    }
}

const OLD_REJECTION_RECORD: &str = r#"{"kind":"removal","region":[0.25,0.25,0.5,0.5],"patch":"p","model":"m","bake":{"temp":6500,"tint":0,"ev":0}}"#;

fn parse_fails_both_ways(name: &str, payload: &str) {
    let dir = tempfile::tempdir().expect("temp dir");
    let xml = read_sidecar(&write_inpaint_sidecar(dir.path(), "photo.xmp", payload));
    for (reader, result) in [
        ("parse", parse(&xml)),
        ("parse_namespaced", parse_namespaced(&xml)),
    ] {
        let message = result
            .expect_err(&format!("{name}: {reader} must still fail"))
            .to_string();
        assert!(
            message.contains("InpaintRemovals: "),
            "{name}: {reader}: {message}"
        );
    }
}

#[test]
fn inpaint_attribute_that_is_not_json_still_fails_the_parse() {
    parse_fails_both_ways("not json", "{not json}");
}

#[test]
fn inpaint_attribute_that_is_not_an_array_still_fails_the_parse() {
    parse_fails_both_ways("object", OLD_REJECTION_RECORD);
}

#[test]
fn inpaint_removal_with_a_malformed_field_still_fails_the_parse() {
    let broken = |find: &str, replace: &str| {
        format!("[{}]", OLD_REJECTION_RECORD.replacen(find, replace, 1))
    };
    for (name, payload) in [
        (
            "region not an array",
            broken(r#""region":[0.25,0.25,0.5,0.5]"#, r#""region":"x""#),
        ),
        (
            "region missing",
            broken(r#""region":[0.25,0.25,0.5,0.5],"#, ""),
        ),
        (
            "region of 3",
            broken("[0.25,0.25,0.5,0.5]", "[0.25,0.25,0.5]"),
        ),
        (
            "region of 5",
            broken("[0.25,0.25,0.5,0.5]", "[0.25,0.25,0.5,0.5,1]"),
        ),
        (
            "region non-numeric",
            broken("[0.25,0.25,0.5,0.5]", r#"[0.25,"a",0.5,0.5]"#),
        ),
        ("patch missing", broken(r#""patch":"p","#, "")),
        (
            "patch not a string",
            broken(r#""patch":"p""#, r#""patch":7"#),
        ),
        ("model missing", broken(r#""model":"m","#, "")),
        (
            "model not a string",
            broken(r#""model":"m""#, r#""model":null"#),
        ),
        (
            "bake missing",
            broken(r#","bake":{"temp":6500,"tint":0,"ev":0}"#, ""),
        ),
        (
            "bake not an object",
            broken(r#"{"temp":6500,"tint":0,"ev":0}"#, "[1,2,3]"),
        ),
        ("bake.temp missing", broken(r#""temp":6500,"#, "")),
        (
            "bake.tint non-numeric",
            broken(r#""tint":0"#, r#""tint":"x""#),
        ),
        ("bake.ev missing", broken(r#","ev":0"#, "")),
    ] {
        parse_fails_both_ways(name, &payload);
    }
}

#[test]
fn inpaint_malformed_removal_still_fails_the_parse_when_it_also_carries_a_new_refusal() {
    let future_and_broken = OLD_REJECTION_RECORD
        .replacen(r#""kind""#, r#""schema":3,"kind""#, 1)
        .replacen(r#""patch":"p","#, "", 1);
    parse_fails_both_ways("schema 3 and no patch", &format!("[{future_and_broken}]"));
    let refused_then_broken = format!(
        "[{},{}]",
        OLD_REJECTION_RECORD.replacen(r#""kind""#, r#""schema":3,"kind""#, 1),
        OLD_REJECTION_RECORD.replacen(r#""patch":"p","#, "", 1)
    );
    parse_fails_both_ways("refused record then a malformed one", &refused_then_broken);
}

#[test]
fn inpaint_unknown_kind_and_non_object_elements_still_parse() {
    let payload = format!(r#"[7,"x",null,{{"kind":"sky-replace"}},{OLD_REJECTION_RECORD}]"#);
    let dir = tempfile::tempdir().expect("temp dir");
    let xml = read_sidecar(&write_inpaint_sidecar(dir.path(), "photo.xmp", &payload));
    for model in [parse(&xml).unwrap(), parse_namespaced(&xml).unwrap()] {
        assert_eq!(model.inpaint_removals.len(), 1);
        assert_eq!(model.exposure, 0.5);
    }
}

#[test]
fn committed_basic_removal_records_still_parse_and_apply_none() {
    let records = include_str!("../../../../../test-fixtures/removal/basic/records.txt").trim();
    let dir = tempfile::tempdir().expect("temp dir");
    let xml = read_sidecar(&write_inpaint_sidecar(dir.path(), "photo.xmp", records));
    for model in [parse(&xml).unwrap(), parse_namespaced(&xml).unwrap()] {
        assert!(model.inpaint_removals.is_empty());
        assert_eq!(model.exposure, 0.5);
    }
}
