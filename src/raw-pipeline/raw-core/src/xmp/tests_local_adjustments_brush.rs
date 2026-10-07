//! `Mask::Brush` XMP I/O (#360) — the fourth `crs:PaintBasedCorrections`
//! container: a `Mask/Paint` leaf whose `crs:Dabs` attribute carries the
//! ordered dab series. Split from `tests_local_adjustments.rs` for the same
//! size-budget reason that file's header explains for its own split from
//! `xmp/tests.rs`. Helpers (`sidecar`, `INDENT`) come from that sibling.

use super::tests_local_adjustments::{sidecar, INDENT};
use super::*;
use crate::types::local_adjustment::{BrushDab, LocalAdjustment, Mask, PartialAdjustments, Point2};

fn brush_layer() -> LocalAdjustment {
    LocalAdjustment {
        mask: Mask::Brush {
            dabs: vec![
                BrushDab::new(Point2::new(0.25, 0.3), 0.05, 0.5, 0.8, false),
                BrushDab::new(Point2::new(0.3, 0.35), 0.05, 0.5, 0.8, false),
                BrushDab::new(Point2::new(0.275, 0.325), 0.02, 0.0, 1.0, true),
            ],
            digest: "0123456789abcdef".to_string(),
            // A stamped id must NOT leak into the sidecar: the writer drops
            // it, the parser reads back 0, and the host re-resolves by digest.
            raster_id: 7,
        },
        range: None,
        adjustments: PartialAdjustments {
            exposure: Some(0.5),
            ..Default::default()
        },
    }
}

#[test]
fn model_to_bytes_to_model_round_trips_brush() {
    let mut model = AdjustmentModel::default();
    model.local_adjustments = vec![brush_layer()];

    let children = serialize_local_adjustments(&model, INDENT);
    let doc = sidecar(&children);
    let parsed = parse(&doc).expect("parse");

    assert_eq!(parsed.local_adjustments.len(), 1, "doc:\n{doc}");
    let layer = &parsed.local_adjustments[0];
    assert_eq!(layer.adjustments, brush_layer().adjustments);
    let Mask::Brush {
        dabs,
        digest,
        raster_id,
    } = &layer.mask
    else {
        panic!("expected a brush mask, doc:\n{doc}");
    };
    let Mask::Brush {
        dabs: want_dabs, ..
    } = &brush_layer().mask
    else {
        unreachable!();
    };
    assert_eq!(dabs, want_dabs);
    assert_eq!(digest, "0123456789abcdef");
    assert_eq!(*raster_id, 0);
}

/// Cross-language byte-parity fixture (#360): the same literal appears in
/// the Swift suite (`LocalAdjustmentXMPTests.swift`) and the TypeScript
/// suite (`local-adjustments-brush.spec.ts`), and all three serializers must
/// produce it byte-for-byte from the same brush layer at the same indent —
/// the same contract as the `CANONICAL_BLOCK` in
/// `tests_local_adjustments_canonical.rs`. (The C# suite pins only the
/// linear/radial literal: Windows passes paint through unmodelled.)
const CANONICAL_PAINT_BLOCK: &str = r#"      <crs:PaintBasedCorrections>
        <rdf:Seq>
          <rdf:li>
            <rdf:Description
              crs:What="Correction"
              crs:CorrectionAmount="1"
              crs:CorrectionActive="True"
              crs:LocalExposure2012="0.5">
              <crs:CorrectionMasks>
                <rdf:Seq>
                  <rdf:li
                    crs:What="Mask/Paint"
                    crs:MaskValue="1"
                    crs:Dabs="0.25 0.3 0.05 0.5 0.8 0 0.3 0.35 0.05 0.5 0.8 0 0.275 0.325 0.02 0 1 1"
                    papp:BrushDigest="0123456789abcdef"/>
                </rdf:Seq>
              </crs:CorrectionMasks>
            </rdf:Description>
          </rdf:li>
        </rdf:Seq>
      </crs:PaintBasedCorrections>"#;

#[test]
fn brush_serializes_to_the_canonical_paint_block() {
    let mut model = AdjustmentModel::default();
    model.local_adjustments = vec![brush_layer()];
    assert_eq!(
        serialize_local_adjustments(&model, INDENT),
        CANONICAL_PAINT_BLOCK
    );
}

#[test]
fn canonical_paint_block_parses_back_to_the_brush_layer() {
    let parsed = parse(&sidecar(CANONICAL_PAINT_BLOCK)).expect("parse");
    assert_eq!(parsed.local_adjustments.len(), 1);
    let Mask::Brush { dabs, digest, .. } = &parsed.local_adjustments[0].mask else {
        panic!("expected a brush mask");
    };
    let Mask::Brush { dabs: want, .. } = &brush_layer().mask else {
        unreachable!();
    };
    assert_eq!(dabs, want);
    assert_eq!(digest, "0123456789abcdef");
}

#[test]
fn brush_round_trips_through_a_real_sidecar_file() {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("brush.xmp");
    let mut model = AdjustmentModel::default();
    model.local_adjustments = vec![brush_layer()];
    let doc = sidecar(&serialize_local_adjustments(&model, INDENT));
    std::fs::write(&path, &doc).expect("write sidecar");
    let back = std::fs::read_to_string(&path).expect("read sidecar");
    let parsed = parse(&back).expect("parse");
    assert_eq!(parsed.local_adjustments.len(), 1);
    assert!(matches!(
        parsed.local_adjustments[0].mask,
        Mask::Brush { .. }
    ));
}

#[test]
fn paint_container_sorts_after_radial_before_group() {
    let mut model = AdjustmentModel::default();
    model.local_adjustments = vec![brush_layer()];
    model.local_adjustments.push(LocalAdjustment::linear(
        Point2::new(0.0, 0.0),
        Point2::new(1.0, 1.0),
        PartialAdjustments::default(),
    ));
    model.local_adjustments.push(LocalAdjustment {
        mask: Mask::Everywhere,
        range: None,
        adjustments: PartialAdjustments::default(),
    });
    let block = serialize_local_adjustments(&model, INDENT);
    let gradient = block.find("crs:GradientBasedCorrections").expect("linear");
    let paint = block.find("crs:PaintBasedCorrections").expect("paint");
    let group = block.find("crs:MaskGroupBasedCorrections").expect("group");
    assert!(gradient < paint && paint < group, "block:\n{block}");
}

#[test]
fn missing_dabs_is_an_empty_stroke_not_an_error() {
    let leaf = concat!(
        "<rdf:li\n",
        "  crs:What=\"Mask/Paint\"\n",
        "  crs:MaskValue=\"1\"/>",
    );
    let doc = sidecar(&paint_correction(leaf));
    let parsed = parse(&doc).expect("parse");
    assert_eq!(parsed.local_adjustments.len(), 1);
    assert!(matches!(
        &parsed.local_adjustments[0].mask,
        Mask::Brush { dabs, .. } if dabs.is_empty()
    ));
}

#[test]
fn missing_digest_reads_as_empty_for_foreign_paint_masks() {
    let leaf = concat!(
        "<rdf:li\n",
        "  crs:What=\"Mask/Paint\"\n",
        "  crs:MaskValue=\"1\"\n",
        "  crs:Dabs=\"0.5 0.5 0.05 0.5 1 0\"/>",
    );
    let parsed = parse(&sidecar(&paint_correction(leaf))).expect("parse");
    assert!(matches!(
        &parsed.local_adjustments[0].mask,
        Mask::Brush { digest, .. } if digest.is_empty()
    ));
}

#[test]
fn empty_series_omits_both_dabs_and_digest() {
    let mut model = AdjustmentModel::default();
    model.local_adjustments = vec![LocalAdjustment::brush(PartialAdjustments::default())];
    let block = serialize_local_adjustments(&model, INDENT);
    assert!(!block.contains("crs:Dabs"), "block:\n{block}");
    assert!(!block.contains("papp:BrushDigest"), "block:\n{block}");
    let parsed = parse(&sidecar(&block)).expect("parse");
    assert!(matches!(
        &parsed.local_adjustments[0].mask,
        Mask::Brush { dabs, .. } if dabs.is_empty()
    ));
}

#[test]
fn non_finite_dabs_are_dropped_on_write() {
    let mut layer = brush_layer();
    let Mask::Brush { dabs, .. } = &mut layer.mask else {
        unreachable!();
    };
    dabs.push(BrushDab::new(
        Point2::new(f32::NAN, 0.5),
        0.05,
        0.5,
        1.0,
        false,
    ));
    let mut model = AdjustmentModel::default();
    model.local_adjustments = vec![layer];
    let block = serialize_local_adjustments(&model, INDENT);
    assert!(!block.contains("NaN"), "block:\n{block}");
    let parsed = parse(&sidecar(&block)).expect("parse re-reads what the writer wrote");
    let Mask::Brush { dabs, .. } = &parsed.local_adjustments[0].mask else {
        panic!("expected a brush mask");
    };
    assert_eq!(dabs.len(), 3);
}

#[test]
fn malformed_dabs_is_a_hard_error() {
    for (name, dabs) in [
        ("odd token count", "0.5 0.5 0.05 0.5 1"),
        ("non-numeric", "0.5 0.5 0.05 0.5 one 0"),
        ("non-finite", "0.5 0.5 0.05 0.5 inf 0"),
        ("bad erase flag", "0.5 0.5 0.05 0.5 1 2"),
    ] {
        let leaf = format!(
            "<rdf:li\n  crs:What=\"Mask/Paint\"\n  crs:MaskValue=\"1\"\n  crs:Dabs=\"{dabs}\"/>"
        );
        let err = parse(&sidecar(&paint_correction(&leaf))).expect_err(name);
        assert!(err.to_string().contains("crs:Dabs"), "{name}: {err}");
    }
}

#[test]
fn paint_leaf_outside_the_paint_container_is_skipped() {
    let doc = sidecar(&format!(
        concat!(
            "      <crs:GradientBasedCorrections>\n",
            "        <rdf:Seq>\n",
            "          <rdf:li>\n",
            "            <rdf:Description\n",
            "              crs:What=\"Correction\"\n",
            "              crs:CorrectionAmount=\"1\"\n",
            "              crs:CorrectionActive=\"True\">\n",
            "              <crs:CorrectionMasks>\n",
            "                <rdf:Seq>\n",
            "                  {}\n",
            "                </rdf:Seq>\n",
            "              </crs:CorrectionMasks>\n",
            "            </rdf:Description>\n",
            "          </rdf:li>\n",
            "        </rdf:Seq>\n",
            "      </crs:GradientBasedCorrections>"
        ),
        "<rdf:li crs:What=\"Mask/Paint\" crs:MaskValue=\"1\" crs:Dabs=\"0.5 0.5 0.05 0.5 1 0\"/>"
    ));
    let parsed = parse(&doc).expect("parse");
    assert!(parsed.local_adjustments.is_empty());
}

#[test]
fn gradient_leaf_inside_the_paint_container_is_skipped() {
    let leaf = "<rdf:li crs:What=\"Mask/Gradient\" crs:ZeroX=\"0\" crs:ZeroY=\"0\" crs:FullX=\"1\" crs:FullY=\"1\"/>";
    let parsed = parse(&sidecar(&paint_correction(leaf))).expect("parse");
    assert!(parsed.local_adjustments.is_empty());
}

#[test]
fn group_with_a_paint_leaf_is_dropped_not_widened() {
    let doc = sidecar(&concat!(
        "      <crs:MaskGroupBasedCorrections>\n",
        "        <rdf:Seq>\n",
        "          <rdf:li>\n",
        "            <rdf:Description\n",
        "              crs:What=\"Correction\"\n",
        "              crs:CorrectionAmount=\"1\"\n",
        "              crs:CorrectionActive=\"True\"\n",
        "              papp:MaskGroupVersion=\"1\">\n",
        "              <crs:CorrectionMasks>\n",
        "                <rdf:Seq>\n",
        "                  <rdf:li crs:What=\"Mask/Paint\" crs:MaskValue=\"1\" crs:Dabs=\"0.5 0.5 0.05 0.5 1 0\"/>\n",
        "                </rdf:Seq>\n",
        "              </crs:CorrectionMasks>\n",
        "            </rdf:Description>\n",
        "          </rdf:li>\n",
        "        </rdf:Seq>\n",
        "      </crs:MaskGroupBasedCorrections>"
    ));
    let parsed = parse(&doc).expect("parse");
    assert!(parsed.local_adjustments.is_empty());
}

fn paint_correction(leaf: &str) -> String {
    format!(
        concat!(
            "      <crs:PaintBasedCorrections>\n",
            "        <rdf:Seq>\n",
            "          <rdf:li>\n",
            "            <rdf:Description\n",
            "              crs:What=\"Correction\"\n",
            "              crs:CorrectionAmount=\"1\"\n",
            "              crs:CorrectionActive=\"True\">\n",
            "              <crs:CorrectionMasks>\n",
            "                <rdf:Seq>\n",
            "                  {}\n",
            "                </rdf:Seq>\n",
            "              </crs:CorrectionMasks>\n",
            "            </rdf:Description>\n",
            "          </rdf:li>\n",
            "        </rdf:Seq>\n",
            "      </crs:PaintBasedCorrections>"
        ),
        leaf.replace('\n', "\n                  ")
    )
}
