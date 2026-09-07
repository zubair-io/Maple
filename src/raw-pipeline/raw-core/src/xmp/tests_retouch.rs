//! `crs:RetouchAreas` round trips (#3409).
//!
//! [`CANONICAL_BLOCK`] is the cross-language parity artifact: the same
//! literal appears in the Swift suite (`RetouchXMPTests.swift`), the
//! TypeScript suite (`retouch.spec.ts`) and the C# suite
//! (`XmpRetouchTests.cs`), and every writer that models the block must
//! produce it byte for byte from [`canonical_spots`].

use super::*;
use crate::types::local_adjustment::Point2;
use crate::types::retouch::{RetouchKind, RetouchSpot};

/// Six spaces — the canonical `rdf:Description` child indent.
const CANONICAL_INDENT: &str = "      ";

/// Mirrored by `canonicalSpots()` in Swift, `canonicalSpots()` in
/// TypeScript and `CanonicalSpots()` in C#.
fn canonical_spots() -> Vec<RetouchSpot> {
    vec![
        RetouchSpot {
            kind: RetouchKind::Heal,
            center: Point2::new(0.25, 0.5),
            source: Point2::new(0.75, 0.5),
            radius: 0.05,
            feather: 0.5,
            opacity: 1.0,
        },
        RetouchSpot {
            kind: RetouchKind::Clone,
            center: Point2::new(0.8, 0.2),
            source: Point2::new(0.6, 0.3),
            radius: 0.0125,
            feather: 0.0,
            opacity: 0.75,
        },
    ]
}

const CANONICAL_BLOCK: &str = r#"      <crs:RetouchAreas>
        <rdf:Seq>
          <rdf:li>
            <rdf:Description
              crs:SpotType="heal"
              crs:SourceState="sourceSetExplicitly"
              crs:Method="circle"
              crs:SourceX="0.750000"
              crs:SourceY="0.500000"
              crs:Opacity="1.000000"
              crs:Feather="0.500000"
              crs:Seed="0">
              <crs:Masks>
                <rdf:Seq>
                  <rdf:li
                    crs:What="Mask/CircularGradient"
                    crs:MaskValue="1"
                    crs:X="0.250000"
                    crs:Y="0.500000"
                    crs:Radius="0.050000"
                    crs:Flow="1"
                    crs:CenterWeight="0"/>
                </rdf:Seq>
              </crs:Masks>
            </rdf:Description>
          </rdf:li>
          <rdf:li>
            <rdf:Description
              crs:SpotType="clone"
              crs:SourceState="sourceSetExplicitly"
              crs:Method="circle"
              crs:SourceX="0.600000"
              crs:SourceY="0.300000"
              crs:Opacity="0.750000"
              crs:Feather="0.000000"
              crs:Seed="0">
              <crs:Masks>
                <rdf:Seq>
                  <rdf:li
                    crs:What="Mask/CircularGradient"
                    crs:MaskValue="1"
                    crs:X="0.800000"
                    crs:Y="0.200000"
                    crs:Radius="0.012500"
                    crs:Flow="1"
                    crs:CenterWeight="0"/>
                </rdf:Seq>
              </crs:Masks>
            </rdf:Description>
          </rdf:li>
        </rdf:Seq>
      </crs:RetouchAreas>"#;

/// Wrap a child block in the minimum envelope `xmp::parse` accepts.
fn document(children: &str) -> String {
    format!(
        r#"<x:xmpmeta xmlns:x="adobe:ns:meta/">
  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
    <rdf:Description rdf:about=""
      xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
      crs:Version="11.0">
{children}
    </rdf:Description>
  </rdf:RDF>
</x:xmpmeta>"#
    )
}

#[test]
fn default_model_emits_nothing() {
    let model = AdjustmentModel::default();
    assert_eq!(serialize_retouch_areas(&model, CANONICAL_INDENT), "");
}

#[test]
fn serializes_the_canonical_block_byte_for_byte() {
    let model = AdjustmentModel {
        retouch_spots: canonical_spots(),
        ..AdjustmentModel::default()
    };
    assert_eq!(
        serialize_retouch_areas(&model, CANONICAL_INDENT),
        CANONICAL_BLOCK
    );
}

#[test]
fn round_trips_the_canonical_block() {
    let parsed = parse(&document(CANONICAL_BLOCK)).unwrap();
    assert_eq!(parsed.retouch_spots, canonical_spots());
    let reserialized = serialize_retouch_areas(&parsed, CANONICAL_INDENT);
    assert_eq!(reserialized, CANONICAL_BLOCK);
}

#[test]
fn a_document_without_spots_parses_to_an_empty_list() {
    let parsed = parse(&document("")).unwrap();
    assert!(parsed.retouch_spots.is_empty());
}

#[test]
fn imports_a_lightroom_spot_that_encodes_its_source_as_an_offset() {
    // Adobe also writes the source as a delta from the destination.
    let block = r#"      <crs:RetouchAreas>
        <rdf:Seq>
          <rdf:li>
            <rdf:Description
              crs:SpotType="heal"
              crs:SourceState="sourceAutoComputed"
              crs:Method="circle"
              crs:OffsetX="0.100000"
              crs:OffsetY="-0.050000"
              crs:Opacity="1.000000"
              crs:Feather="0.250000"
              crs:Seed="0">
              <crs:Masks>
                <rdf:Seq>
                  <rdf:li crs:What="Mask/CircularGradient" crs:MaskValue="1"
                    crs:X="0.400000" crs:Y="0.600000" crs:Radius="0.030000"/>
                </rdf:Seq>
              </crs:Masks>
            </rdf:Description>
          </rdf:li>
        </rdf:Seq>
      </crs:RetouchAreas>"#;
    let parsed = parse(&document(block)).unwrap();
    assert_eq!(parsed.retouch_spots.len(), 1);
    let spot = parsed.retouch_spots[0];
    assert_eq!(spot.kind, RetouchKind::Heal);
    assert!((spot.source.x - 0.5).abs() < 1e-6);
    assert!((spot.source.y - 0.55).abs() < 1e-6);
    assert!((spot.feather - 0.25).abs() < 1e-6);
}

#[test]
fn skips_a_correction_whose_mask_is_not_the_circular_form() {
    // A Lightroom brush stroke: modelled by neither Maple's spot nor its
    // masks. It must drop that one correction, not the whole document.
    let block = r#"      <crs:RetouchAreas>
        <rdf:Seq>
          <rdf:li>
            <rdf:Description crs:SpotType="heal" crs:SourceX="0.1" crs:SourceY="0.1">
              <crs:Masks>
                <rdf:Seq>
                  <rdf:li crs:What="Mask/Paint" crs:MaskValue="1" crs:Radius="0.02"/>
                </rdf:Seq>
              </crs:Masks>
            </rdf:Description>
          </rdf:li>
        </rdf:Seq>
      </crs:RetouchAreas>"#;
    let parsed = parse(&document(block)).unwrap();
    assert!(parsed.retouch_spots.is_empty());
}

#[test]
fn skips_a_spot_type_this_build_does_not_model() {
    let block = CANONICAL_BLOCK.replace(r#"crs:SpotType="heal""#, r#"crs:SpotType="contentAware""#);
    let parsed = parse(&document(&block)).unwrap();
    // The clone spot survives; the unmodelled one is dropped.
    assert_eq!(parsed.retouch_spots.len(), 1);
    assert_eq!(parsed.retouch_spots[0].kind, RetouchKind::Clone);
}

#[test]
fn a_malformed_number_on_a_recognized_leaf_is_a_hard_error() {
    let block = CANONICAL_BLOCK.replace(r#"crs:Radius="0.050000""#, r#"crs:Radius="wide""#);
    assert!(parse(&document(&block)).is_err());
}

#[test]
fn reads_the_legacy_retouch_info_string_form() {
    let block = r#"      <crs:RetouchInfo>
        <rdf:Seq>
          <rdf:li>centerX = 0.5, centerY = 0.5, radius = 0.02, sourceState = sourceSetExplicitly, sourceX = 0.6, sourceY = 0.5, spotType = heal</rdf:li>
          <rdf:li>centerX = 0.1, centerY = 0.2, radius = 0.01, sourceState = sourceSetExplicitly, sourceX = 0.3, sourceY = 0.4, spotType = clone</rdf:li>
        </rdf:Seq>
      </crs:RetouchInfo>"#;
    let parsed = parse(&document(block)).unwrap();
    assert_eq!(parsed.retouch_spots.len(), 2);
    assert_eq!(parsed.retouch_spots[0].kind, RetouchKind::Heal);
    assert!((parsed.retouch_spots[0].radius - 0.02).abs() < 1e-6);
    assert_eq!(parsed.retouch_spots[1].kind, RetouchKind::Clone);
    assert!((parsed.retouch_spots[1].source.x - 0.3).abs() < 1e-6);
}

#[test]
fn the_struct_form_wins_over_the_legacy_strings() {
    let legacy = r#"      <crs:RetouchInfo>
        <rdf:Seq>
          <rdf:li>centerX = 0.9, centerY = 0.9, radius = 0.5, sourceState = sourceSetExplicitly, sourceX = 0.1, sourceY = 0.1, spotType = clone</rdf:li>
        </rdf:Seq>
      </crs:RetouchInfo>"#;
    let both = format!("{legacy}\n{CANONICAL_BLOCK}");
    let parsed = parse(&document(&both)).unwrap();
    assert_eq!(parsed.retouch_spots, canonical_spots());
}

#[test]
fn retouch_coexists_with_local_adjustments_and_tone_curves() {
    // The three nested walkers share one parse loop; none may swallow
    // another's subtree.
    let model = AdjustmentModel {
        retouch_spots: canonical_spots(),
        tone_curve_luma: crate::types::ToneCurve::new(vec![(0.0, 0.0), (1.0, 1.0)]),
        ..AdjustmentModel::default()
    };
    let children = format!(
        "{}\n{}",
        serialize_tone_curves(&model, CANONICAL_INDENT),
        serialize_retouch_areas(&model, CANONICAL_INDENT)
    );
    let parsed = parse(&document(&children)).unwrap();
    assert_eq!(parsed.retouch_spots, canonical_spots());
    assert_eq!(parsed.tone_curve_luma.points.len(), 2);
}
