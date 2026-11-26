//! Wire tests for the `papp:InpaintRemovals` records and the patch layout check.

use super::*;

fn sample() -> Removal {
    Removal {
        region: [0.25, 0.1, 0.5, 0.4],
        patch_ref: "blake3:deadbeef".to_string(),
        model_version: "lama-bigl-1".to_string(),
        bake: BakeGrade {
            temperature: 5500.0,
            tint: 4.0,
            exposure: 0.3,
        },
    }
}

#[test]
fn encode_empty_is_empty_array() {
    assert_eq!(encode_removals(&[]).unwrap(), "[]");
}

#[test]
fn round_trips_single_and_multi() {
    let one = sample();
    let mut two = sample();
    two.patch_ref = "blake3:cafe".to_string();
    two.region = [0.0, 0.0, 1.0, 1.0];
    let removals = vec![one, two];
    let encoded = encode_removals(&removals).unwrap();
    let decoded = decode_removals(&encoded).unwrap();
    assert_eq!(decoded, removals);
}

#[test]
fn decode_skips_unknown_kind_keeps_removal() {
    // A future element kind next to a valid removal must not drop the removal.
    let r = sample();
    let s = format!(
        r#"[{{"kind":"sky-replace","schema":9}},{}]"#,
        removal_to_json(&r)
    );
    let decoded = decode_removals(&s).unwrap();
    assert_eq!(decoded, vec![r]);
}

#[test]
fn decode_skips_non_object_and_untagged() {
    let s = r#"[42, "x", {}, {"region":[0,0,1,1]}]"#;
    assert!(decode_removals(s).unwrap().is_empty());
}

#[test]
fn decode_corrupt_removal_errors() {
    // Tagged as a removal but region is malformed → loud error, not skipped.
    let s = r#"[{"kind":"removal","region":[0,0,1],"patch":"x","model":"m","bake":{"temp":5500,"tint":0,"ev":0}}]"#;
    assert!(decode_removals(s).is_err());
}

#[test]
fn decode_removal_missing_patch_errors() {
    let s = r#"[{"kind":"removal","region":[0,0,1,1],"model":"m","bake":{"temp":5500,"tint":0,"ev":0}}]"#;
    assert!(decode_removals(s).is_err());
}

fn record_with(field: &str, value: &str) -> String {
    let mut record = removal_to_json(&sample());
    record[field] = serde_json::from_str(value).expect("test value is JSON");
    Value::Array(vec![record]).to_string()
}

#[test]
fn decode_refuses_unsupported_schema_on_a_recognized_removal() {
    for schema in ["3", "4", "9", "1", "0", "-2", "2.5", "\"2\"", "null", "[2]"] {
        assert!(
            decode_removals(&record_with("schema", schema)).is_err(),
            "schema {schema}"
        );
    }
}

#[test]
fn decode_reads_an_untagged_removal_as_schema_2() {
    let mut record = removal_to_json(&sample());
    record
        .as_object_mut()
        .expect("record is an object")
        .remove("schema");
    let decoded = decode_removals(&Value::Array(vec![record]).to_string()).unwrap();
    assert_eq!(decoded, vec![sample()]);
}

#[test]
fn decode_refuses_non_finite_or_out_of_frame_region() {
    for region in [
        "[-0.1,0,0.5,0.5]",
        "[0,-0.1,0.5,0.5]",
        "[0.6,0,0.5,0.5]",
        "[0,0.6,0.5,0.5]",
        "[0,0,0,0.5]",
        "[0,0,0.5,-0.5]",
        "[0,0,1e300,0.5]",
        "[-1e300,0,0.5,0.5]",
    ] {
        assert!(
            decode_removals(&record_with("region", region)).is_err(),
            "region {region}"
        );
    }
}

#[test]
fn decode_keeps_an_edge_aligned_region() {
    for region in ["[0,0,1,1]", "[0.75,0.5,0.25,0.5]"] {
        assert_eq!(
            decode_removals(&record_with("region", region))
                .expect("in-frame region decodes")
                .len(),
            1,
            "region {region}"
        );
    }
}

#[test]
fn decode_refuses_non_finite_bake() {
    for bake in [
        r#"{"temp":1e300,"tint":0,"ev":0}"#,
        r#"{"temp":5500,"tint":-1e300,"ev":0}"#,
        r#"{"temp":5500,"tint":0,"ev":1e300}"#,
    ] {
        assert!(
            decode_removals(&record_with("bake", bake)).is_err(),
            "bake {bake}"
        );
    }
}

fn patch(width: u32, height: u32) -> InpaintPatch {
    let samples = (width * height) as usize;
    InpaintPatch {
        width,
        height,
        origin: [0.25, 0.25],
        extent: [0.5, 0.5],
        pixels: vec![[0.18, 0.18, 0.18]; samples],
        coverage: vec![1.0; samples],
    }
}

#[test]
fn layout_accepts_a_well_formed_patch() {
    assert!(patch(3, 2).is_valid());
}

#[test]
fn layout_refuses_non_finite_placement() {
    for bad in [f32::NAN, f32::INFINITY, f32::NEG_INFINITY] {
        for axis in 0..2 {
            let mut origin = patch(3, 2);
            origin.origin[axis] = bad;
            assert!(!origin.is_valid(), "origin[{axis}] = {bad}");
            let mut extent = patch(3, 2);
            extent.extent[axis] = bad;
            assert!(!extent.is_valid(), "extent[{axis}] = {bad}");
        }
    }
}

#[test]
fn layout_refuses_out_of_frame_placement() {
    for (origin, extent) in [
        ([-0.1, 0.0], [0.5, 0.5]),
        ([0.6, 0.0], [0.5, 0.5]),
        ([0.0, 0.6], [0.5, 0.5]),
        ([0.0, 0.0], [0.5, 0.0]),
    ] {
        let placed = InpaintPatch {
            origin,
            extent,
            ..patch(3, 2)
        };
        assert!(!placed.is_valid(), "origin {origin:?} extent {extent:?}");
    }
}

#[test]
fn layout_refuses_zero_overflowing_and_mismatched_dimensions() {
    let empty = |width, height| InpaintPatch {
        width,
        height,
        pixels: Vec::new(),
        coverage: Vec::new(),
        ..patch(1, 1)
    };
    assert!(!empty(0, 0).is_valid());
    assert!(!empty(0, 3).is_valid());
    assert!(!empty(65_536, 65_536).is_valid());
    let short = InpaintPatch {
        coverage: vec![1.0; 5],
        ..patch(3, 2)
    };
    assert!(!short.is_valid());
}

#[test]
fn unsupported_schema_is_named_in_the_error() {
    assert_eq!(
        decode_removals(&record_with("schema", "4")),
        Err(RemovalRecordError::UnsupportedSchema {
            found: "4".to_string()
        })
    );
    assert_eq!(
        decode_removals(&record_with("region", "[0.75,0.25,0.5,0.5]")),
        Err(RemovalRecordError::Region {
            region: [0.75, 0.25, 0.5, 0.5]
        })
    );
}

#[test]
fn decode_refuses_a_patch_or_model_that_is_not_a_plain_file_name() {
    for field in ["patch", "model"] {
        for name in [
            "\"\"",
            "\".\"",
            "\"..\"",
            "\"../../x\"",
            "\"a/b\"",
            "\"a\\\\b\"",
            "\"a\\u0000b\"",
        ] {
            assert_eq!(
                decode_removals(&record_with(field, name)),
                Err(RemovalRecordError::FileName {
                    field: if field == "patch" { "patch" } else { "model" }
                }),
                "{field} = {name}"
            );
        }
        for name in [
            "\"blake3:deadbeef\"",
            "\"two words\"",
            "\"a.b..c\"",
            "\"...\"",
        ] {
            assert!(
                decode_removals(&record_with(field, name)).is_ok(),
                "{field} = {name}"
            );
        }
    }
}

#[test]
fn encode_refuses_what_decode_refuses_and_every_encoded_record_reads_back() {
    let with = |edit: fn(&mut Removal)| {
        let mut removal = sample();
        edit(&mut removal);
        removal
    };
    let refused = [
        with(|r| r.region = [0.75, 0.25, 0.5, 0.5]),
        with(|r| r.region = [f32::NAN, 0.0, 1.0, 1.0]),
        with(|r| r.region = [0.0, 0.0, 0.0, 1.0]),
        with(|r| r.bake.temperature = f32::NAN),
        with(|r| r.bake.tint = f32::INFINITY),
        with(|r| r.bake.exposure = f32::NEG_INFINITY),
        with(|r| r.patch_ref = "../../x".to_string()),
        with(|r| r.model_version = String::new()),
    ];
    for removal in &refused {
        assert!(
            encode_removals(std::slice::from_ref(removal)).is_err(),
            "{removal:?}"
        );
    }
    let accepted = [
        sample(),
        with(|r| r.region = [0.0, 0.0, 1.0, 1.0]),
        with(|r| r.bake.exposure = -2.5),
    ];
    let encoded = encode_removals(&accepted).unwrap();
    assert_eq!(decode_removals(&encoded).unwrap(), accepted);
}

#[test]
fn tolerant_decode_applies_valid_records_and_reports_each_refusal() {
    let mut records = vec![
        removal_to_json(&sample()),
        removal_to_json(&sample()),
        removal_to_json(&sample()),
    ];
    records[0]["schema"] = serde_json::json!(3);
    records[2]["region"] = serde_json::json!([0.75, 0.25, 0.5, 0.5]);
    let decoded = decode_removals_tolerant(&Value::Array(records).to_string());
    assert_eq!(decoded.removals, vec![sample()]);
    assert_eq!(
        decoded.refused,
        vec![
            RemovalRecordError::UnsupportedSchema {
                found: "3".to_string()
            },
            RemovalRecordError::Region {
                region: [0.75, 0.25, 0.5, 0.5]
            },
        ]
    );
}

#[test]
fn tolerant_decode_of_a_non_array_applies_nothing_and_says_why() {
    for (attribute, cause) in [
        ("{not json}", "invalid JSON"),
        ("{\"kind\":\"removal\"}", "JSON array"),
    ] {
        let decoded = decode_removals_tolerant(attribute);
        assert!(decoded.removals.is_empty(), "{attribute}");
        assert!(
            decoded.refused[0].to_string().contains(cause),
            "{attribute}"
        );
    }
}

#[test]
fn layout_refuses_a_side_beyond_two_to_the_24th_but_not_at_it() {
    let side = |width: u32, height: u32| InpaintPatch {
        width,
        height,
        origin: [0.0, 0.0],
        extent: [0.5, 1.0],
        pixels: Vec::new(),
        coverage: Vec::new(),
    };
    for (width, height) in [((1 << 24) + 1, 1), (1, (1 << 24) + 1), (16_777_220, 1)] {
        assert_eq!(
            side(width, height).check_layout(),
            Err(InpaintPatchError::DimensionTooLarge { width, height })
        );
    }
    assert!(matches!(
        side(1 << 24, 1).check_layout(),
        Err(InpaintPatchError::BufferLength { .. })
    ));
}

#[test]
fn only_errors_the_reader_raised_before_3933_fail_a_sidecar() {
    let decoded = decode_removals_tolerant(&format!(
        "[{}]",
        [
            record_with_one("schema", "3"),
            record_with_one("region", "[0.75,0.25,0.5,0.5]"),
            record_with_one("patch", r#""../x""#),
            record_with_one("bake", r#"{"temp":1e300,"tint":0,"ev":0}"#),
            record_with_one("region", "[0.25,0.25]"),
            record_with_one("patch", "7"),
            record_with_one("bake", "[]"),
        ]
        .join(",")
    ));
    let old: Vec<bool> = decoded
        .refused
        .iter()
        .map(|e| e.was_refused_before_3933())
        .collect();
    assert_eq!(old, [false, false, false, false, true, true, true]);
    assert!(decode_removals_tolerant("{not json}").refused[0].was_refused_before_3933());
    assert!(decode_removals_tolerant("{}").refused[0].was_refused_before_3933());
}

fn record_with_one(field: &str, value: &str) -> String {
    let mut record = removal_to_json(&sample());
    record[field] = serde_json::from_str(value).expect("test value is JSON");
    record.to_string()
}
