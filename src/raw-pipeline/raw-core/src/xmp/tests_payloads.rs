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
        accepted: None,
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
        r#"<?xml version="1.0"?><x><rdf:Description xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:papp="http://ns.justmaple.app/photo/1.0/"
            papp:InpaintRemovals="{escaped}"/></x>"#
    );
    let m = parse(&xml).expect("parse");
    assert_eq!(m.inpaint_removals, removals);
}

#[test]
fn parse_inpaint_removals_malformed_errors() {
    let xml = r#"<?xml version="1.0"?><x><rdf:Description xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:papp="http://ns.justmaple.app/photo/1.0/"
        papp:InpaintRemovals="{not json}"/></x>"#;
    assert!(parse(xml).is_err());
}

#[test]
fn removal_sidecar_and_companion_round_trip_from_real_files() {
    use crate::pipeline::{patch_from_bytes, patch_to_bytes};
    use crate::types::inpaint::{encode_removals, BakeGrade, InpaintPatch, Removal};
    let dir = tempfile::tempdir().unwrap();
    let patch = InpaintPatch {
        width: 2,
        height: 1,
        origin: [0.0, 0.0],
        extent: [1.0, 1.0],
        pixels: vec![[-0.25, 4.0, 0.125], [2.0, 0.5, 0.0]],
        coverage: vec![1.0, 0.5],
    };
    let bytes = patch_to_bytes(&patch).unwrap();
    let digest = blake3::hash(&bytes).to_hex().to_string();
    let companion = dir.path().join(format!("{digest}.f16"));
    std::fs::write(&companion, &bytes).unwrap();
    let removal = Removal {
        accepted: None,
        region: [0.0, 0.0, 1.0, 1.0],
        patch_ref: format!("blake3:{digest}"),
        model_version: "test-accepted-pixels".into(),
        bake: BakeGrade {
            temperature: 6500.0,
            tint: 0.0,
            exposure: 0.0,
        },
    };
    let json = encode_removals(std::slice::from_ref(&removal)).unwrap();
    let xml = format!(
        r#"<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:papp="http://ns.justmaple.app/photo/1.0/" papp:InpaintRemovals="{}"/></rdf:RDF></x:xmpmeta>"#,
        json.replace('"', "&quot;")
    );
    let sidecar = dir.path().join("photo.xmp");
    std::fs::write(&sidecar, xml).unwrap();
    let model = parse(&std::fs::read_to_string(&sidecar).unwrap()).unwrap();
    assert_eq!(model.inpaint_removals, vec![removal]);
    let saved = std::fs::read(&companion).unwrap();
    assert_eq!(blake3::hash(&saved).to_hex().as_str(), digest);
    assert_eq!(patch_from_bytes(&saved).unwrap(), patch);

    // A recognized incompatible version survives file I/O and fails the real
    // parser; it cannot silently become a partial list of accepted edits.
    let mut record: serde_json::Value = serde_json::from_str(&json).unwrap();
    record[0]["schema"] = serde_json::json!(5);
    let xml = format!(
        r#"<rdf:Description xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:papp="http://ns.justmaple.app/photo/1.0/" papp:InpaintRemovals="{}"/>"#,
        record.to_string().replace('"', "&quot;")
    );
    std::fs::write(&sidecar, xml).unwrap();
    assert!(parse(&std::fs::read_to_string(&sidecar).unwrap())
        .unwrap_err()
        .to_string()
        .contains("unsupported removal schema"));
}
