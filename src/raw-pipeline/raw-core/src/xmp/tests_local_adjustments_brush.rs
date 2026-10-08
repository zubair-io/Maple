//! `Mask::Brush` XMP I/O (#360) — Maple's own `papp:BrushCorrections`
//! container: a versioned `Mask/Paint` leaf whose `papp:Dabs` attribute
//! carries the ordered dab series. Lightroom's `crs:PaintBasedCorrections`
//! is never modelled. Split from `tests_local_adjustments.rs` for the same
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
/// linear/radial literal: Windows passes the brush container through.)
const CANONICAL_BRUSH_BLOCK: &str = r#"      <papp:BrushCorrections>
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
                    papp:BrushVersion="1"
                    papp:Dabs="0.25 0.3 0.05 0.5 0.8 0 0.3 0.35 0.05 0.5 0.8 0 0.275 0.325 0.02 0 1 1"
                    papp:BrushDigest="0123456789abcdef"/>
                </rdf:Seq>
              </crs:CorrectionMasks>
            </rdf:Description>
          </rdf:li>
        </rdf:Seq>
      </papp:BrushCorrections>"#;

#[test]
fn brush_serializes_to_the_canonical_brush_block() {
    let mut model = AdjustmentModel::default();
    model.local_adjustments = vec![brush_layer()];
    assert_eq!(
        serialize_local_adjustments(&model, INDENT),
        CANONICAL_BRUSH_BLOCK
    );
}

#[test]
fn canonical_brush_block_parses_back_to_the_brush_layer() {
    let parsed = parse(&sidecar(CANONICAL_BRUSH_BLOCK)).expect("parse");
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
fn brush_container_sorts_after_linear_before_group() {
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
    assert!(
        !block.contains("crs:PaintBasedCorrections"),
        "block:\n{block}"
    );
    let paint = block.find("papp:BrushCorrections").expect("brush");
    let group = block.find("crs:MaskGroupBasedCorrections").expect("group");
    assert!(gradient < paint && paint < group, "block:\n{block}");
}

#[test]
fn missing_dabs_is_an_empty_stroke_not_an_error() {
    let leaf = concat!(
        "<rdf:li\n",
        "  crs:What=\"Mask/Paint\"\n",
        "  crs:MaskValue=\"1\"\n",
        "  papp:BrushVersion=\"1\"/>",
    );
    let doc = sidecar(&brush_correction(leaf));
    let parsed = parse(&doc).expect("parse");
    assert_eq!(parsed.local_adjustments.len(), 1);
    assert!(matches!(
        &parsed.local_adjustments[0].mask,
        Mask::Brush { dabs, .. } if dabs.is_empty()
    ));
}

#[test]
fn missing_digest_reads_as_empty() {
    let leaf = concat!(
        "<rdf:li\n",
        "  crs:What=\"Mask/Paint\"\n",
        "  crs:MaskValue=\"1\"\n",
        "  papp:BrushVersion=\"1\"\n",
        "  papp:Dabs=\"0.5 0.5 0.05 0.5 1 0\"/>",
    );
    let parsed = parse(&sidecar(&brush_correction(leaf))).expect("parse");
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
    assert!(!block.contains("papp:Dabs"), "block:\n{block}");
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
            "<rdf:li\n  crs:What=\"Mask/Paint\"\n  crs:MaskValue=\"1\"\n  papp:BrushVersion=\"1\"\n  papp:Dabs=\"{dabs}\"/>"
        );
        let err = parse(&sidecar(&brush_correction(&leaf))).expect_err(name);
        assert!(err.to_string().contains("papp:Dabs"), "{name}: {err}");
    }
}

#[test]
fn paint_leaf_outside_the_brush_container_is_skipped() {
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
        "<rdf:li crs:What=\"Mask/Paint\" crs:MaskValue=\"1\" papp:BrushVersion=\"1\" papp:Dabs=\"0.5 0.5 0.05 0.5 1 0\"/>"
    ));
    let parsed = parse(&doc).expect("parse");
    assert!(parsed.local_adjustments.is_empty());
}

#[test]
fn gradient_leaf_inside_the_brush_container_is_skipped() {
    let leaf = "<rdf:li crs:What=\"Mask/Gradient\" crs:ZeroX=\"0\" crs:ZeroY=\"0\" crs:FullX=\"1\" crs:FullY=\"1\"/>";
    let parsed = parse(&sidecar(&brush_correction(leaf))).expect("parse");
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
        "                  <rdf:li crs:What=\"Mask/Paint\" crs:MaskValue=\"1\" papp:BrushVersion=\"1\" papp:Dabs=\"0.5 0.5 0.05 0.5 1 0\"/>\n",
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

fn brush_correction(leaf: &str) -> String {
    format!(
        concat!(
            "      <papp:BrushCorrections>\n",
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
            "      </papp:BrushCorrections>"
        ),
        leaf.replace('\n', "\n                  ")
    )
}

#[test]
fn brush_leaf_without_a_known_version_is_dropped_not_misread() {
    for version in ["", "  papp:BrushVersion=\"2\"\n"] {
        let leaf = format!(
            "<rdf:li\n  crs:What=\"Mask/Paint\"\n  crs:MaskValue=\"1\"\n{version}  papp:Dabs=\"0.5 0.5 0.05 0.5 1 0\"/>"
        );
        let parsed = parse(&sidecar(&brush_correction(&leaf))).expect("parse");
        assert!(parsed.local_adjustments.is_empty(), "version {version:?}");
    }
}

const LIGHTROOM_PAINT: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../../test-fixtures/local-adjustments/lightroom-paint.xmp"
));

#[test]
fn lightroom_paint_corrections_are_not_modelled() {
    let parsed = parse(LIGHTROOM_PAINT).expect("a Lightroom paint sidecar parses");
    assert!(parsed.local_adjustments.is_empty());
    assert!((parsed.exposure - 0.35).abs() < 1e-6);
}

#[test]
fn maple_brush_beside_lightroom_paint_reads_only_the_maple_brush() {
    let brush = sidecar(CANONICAL_BRUSH_BLOCK);
    let start = LIGHTROOM_PAINT
        .find("   <crs:PaintBasedCorrections>")
        .unwrap();
    let end = LIGHTROOM_PAINT
        .find("</crs:PaintBasedCorrections>")
        .unwrap()
        + "</crs:PaintBasedCorrections>".len();
    let close = brush
        .find("    </rdf:Description>")
        .expect("sidecar closes its description");
    let doc = format!(
        "{}{}\n{}",
        &brush[..close],
        &LIGHTROOM_PAINT[start..end],
        &brush[close..]
    );
    let parsed = parse(&doc).expect("parse");
    assert_eq!(parsed.local_adjustments.len(), 1, "doc:\n{doc}");
    let Mask::Brush { dabs, .. } = &parsed.local_adjustments[0].mask else {
        panic!("expected the Maple brush");
    };
    assert_eq!(dabs.len(), 3);
}

#[test]
fn brush_container_with_an_unreadable_correction_models_none_of_it() {
    let correction = |leaf: &str| {
        format!(
            "          <rdf:li>\n            <rdf:Description crs:What=\"Correction\" crs:CorrectionAmount=\"1\" crs:CorrectionActive=\"True\" crs:LocalExposure2012=\"0.5\">\n              <crs:CorrectionMasks>\n                <rdf:Seq>\n                  {leaf}\n                </rdf:Seq>\n              </crs:CorrectionMasks>\n            </rdf:Description>\n          </rdf:li>\n"
        )
    };
    let doc = sidecar(&format!(
        "      <papp:BrushCorrections>\n        <rdf:Seq>\n{}{}        </rdf:Seq>\n      </papp:BrushCorrections>\n{}",
        correction("<rdf:li crs:What=\"Mask/Paint\" crs:MaskValue=\"1\" papp:BrushVersion=\"1\" papp:Dabs=\"0.5 0.5 0.05 0.5 1 0\"/>"),
        correction("<rdf:li crs:What=\"Mask/Paint\" crs:MaskValue=\"1\" papp:BrushVersion=\"2\" papp:Dabs=\"0.5 0.5 0.05 0.5 1 0\"/>"),
        CANONICAL_BRUSH_BLOCK,
    ));
    let parsed = parse(&doc).expect("parse");
    assert_eq!(parsed.local_adjustments.len(), 1, "doc:\n{doc}");
    let Mask::Brush { dabs, .. } = &parsed.local_adjustments[0].mask else {
        panic!("expected the readable container's brush");
    };
    assert_eq!(dabs.len(), 3);
}
