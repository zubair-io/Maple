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
    let attr = encode_removals(&removals);
    let escaped = attr.replace('"', "&quot;");
    let xml = format!(
        r#"<?xml version="1.0"?><x><rdf:Description xmlns:rdf="x" xmlns:papp="x"
            papp:InpaintRemovals="{escaped}"/></x>"#
    );
    let m = parse(&xml).expect("parse");
    assert_eq!(m.inpaint_removals, removals);
}

#[test]
fn parse_inpaint_removals_malformed_errors() {
    let xml = r#"<?xml version="1.0"?><x><rdf:Description xmlns:rdf="x" xmlns:papp="x"
        papp:InpaintRemovals="{not json}"/></x>"#;
    assert!(parse(xml).is_err());
}
