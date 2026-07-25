//! Point tone-curve XMP I/O (#365) — nested `rdf:Seq` / `rdf:li` elements
//! under the four `papp:SceneLinearToneCurve*` parents.
//!
//! `CANONICAL_BLOCK` below is the cross-language parity artifact: the same
//! literal appears in the Swift suite (`ToneCurveXMPTests.swift`) and the
//! TypeScript suite (`point-tone-curve.spec.ts`), and all three serializers
//! must produce it byte-for-byte from the same model at the same indent.
//! Whole *documents* still differ across the three writers (namespace URIs,
//! `x:xmptk`, attribute order — see the header on `XMPSerialization.swift`),
//! so the block is the unit of byte parity, not the file.

use super::*;
use crate::types::adjustment::ToneCurve;

/// Child indent used by the parity fixture. Six spaces is the canonical
/// depth for children of `rdf:Description` per
/// `docs/xmp-canonical-format.md` § "Indentation".
const INDENT: &str = "      ";

/// Cross-language byte-parity fixture — a non-identity five-point luma curve.
const CANONICAL_BLOCK: &str = r#"      <papp:SceneLinearToneCurve>
        <rdf:Seq>
          <rdf:li>0, 0</rdf:li>
          <rdf:li>64, 48</rdf:li>
          <rdf:li>128, 140</rdf:li>
          <rdf:li>192, 205</rdf:li>
          <rdf:li>255, 255</rdf:li>
        </rdf:Seq>
      </papp:SceneLinearToneCurve>"#;

/// The `[0, 1]` model form of `CANONICAL_BLOCK`.
fn canonical_points() -> Vec<(f32, f32)> {
    vec![
        (0.0, 0.0),
        (64.0 / 255.0, 48.0 / 255.0),
        (128.0 / 255.0, 140.0 / 255.0),
        (192.0 / 255.0, 205.0 / 255.0),
        (1.0, 1.0),
    ]
}

/// Wrap a nested child block in the surrounding sidecar envelope.
fn sidecar(children: &str) -> String {
    format!(
        r#"<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
    <rdf:Description
      xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
      xmlns:papp="http://ns.justmaple.app/1.0/"
      crs:Version="11.0">
{children}
    </rdf:Description>
  </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>"#
    )
}

#[test]
fn parses_nested_five_point_luma_curve() {
    let model = parse(&sidecar(CANONICAL_BLOCK)).expect("parse");
    let expected = canonical_points();
    assert_eq!(model.tone_curve_luma.points.len(), 5);
    for (got, want) in model.tone_curve_luma.points.iter().zip(expected.iter()) {
        assert!((got.0 - want.0).abs() < 1e-6, "x {got:?} vs {want:?}");
        assert!((got.1 - want.1).abs() < 1e-6, "y {got:?} vs {want:?}");
    }
    // Only the luma channel was authored.
    assert!(model.tone_curve_red.is_identity());
    assert!(model.tone_curve_green.is_identity());
    assert!(model.tone_curve_blue.is_identity());
}

/// The load-bearing acceptance test: bytes → model → bytes is the identity
/// function for a non-identity five-point curve.
#[test]
fn round_trips_five_point_curve_byte_for_byte() {
    let model = parse(&sidecar(CANONICAL_BLOCK)).expect("parse");
    assert_eq!(serialize_tone_curves(&model, INDENT), CANONICAL_BLOCK);
}

#[test]
fn serializes_canonical_block_from_a_hand_built_model() {
    let mut model = AdjustmentModel::default();
    model.tone_curve_luma = ToneCurve::new(canonical_points());
    assert_eq!(serialize_tone_curves(&model, INDENT), CANONICAL_BLOCK);
}

/// Identity is silence — an unedited model must add nothing to the document,
/// so a sidecar written before #365 stays byte-identical after a re-save.
#[test]
fn identity_curves_emit_nothing() {
    let model = AdjustmentModel::default();
    assert!(model.tone_curve_luma.is_identity());
    assert_eq!(serialize_tone_curves(&model, INDENT), "");
}

/// An explicitly empty `rdf:Seq` parses back to identity, and re-serializes
/// to nothing rather than to an empty container.
#[test]
fn empty_seq_parses_as_identity_and_emits_nothing() {
    let block = r#"      <papp:SceneLinearToneCurve>
        <rdf:Seq>
        </rdf:Seq>
      </papp:SceneLinearToneCurve>"#;
    let model = parse(&sidecar(block)).expect("parse");
    assert!(model.tone_curve_luma.is_identity());
    assert_eq!(serialize_tone_curves(&model, INDENT), "");
}

#[test]
fn all_four_channels_round_trip() {
    let mut model = AdjustmentModel::default();
    model.tone_curve_luma = ToneCurve::new(vec![(0.0, 0.0), (1.0, 1.0)]);
    model.tone_curve_red = ToneCurve::new(vec![(0.0, 0.0), (0.5, 0.6), (1.0, 1.0)]);
    model.tone_curve_green = ToneCurve::new(vec![(0.0, 0.0), (0.25, 0.2), (1.0, 1.0)]);
    model.tone_curve_blue = ToneCurve::new(vec![(0.0, 0.1), (1.0, 0.9)]);

    let block = serialize_tone_curves(&model, INDENT);
    // Canonical child order: luma, red, green, blue.
    let order: Vec<usize> = [
        "<papp:SceneLinearToneCurve>",
        "<papp:SceneLinearToneCurveRed>",
        "<papp:SceneLinearToneCurveGreen>",
        "<papp:SceneLinearToneCurveBlue>",
    ]
    .iter()
    .map(|e| block.find(e).unwrap_or_else(|| panic!("missing {e}")))
    .collect();
    assert!(order.windows(2).all(|w| w[0] < w[1]), "child order: {order:?}");

    let reparsed = parse(&sidecar(&block)).expect("parse");
    assert_eq!(serialize_tone_curves(&reparsed, INDENT), block);
}

/// Non-integer wire coordinates survive the two-decimal canonical codec.
#[test]
fn fractional_coordinates_round_trip() {
    let block = r#"      <papp:SceneLinearToneCurveRed>
        <rdf:Seq>
          <rdf:li>0, 0</rdf:li>
          <rdf:li>127.5, 130.25</rdf:li>
          <rdf:li>255, 255</rdf:li>
        </rdf:Seq>
      </papp:SceneLinearToneCurveRed>"#;
    let model = parse(&sidecar(block)).expect("parse");
    let emitted = serialize_tone_curves(&model, INDENT);
    assert!(
        emitted.contains("<rdf:li>127.5, 130.25</rdf:li>"),
        "emitted: {emitted}"
    );
}

/// Lightroom's display-referred curves are a different quantity (post-AgX)
/// and must NOT land in the scene-linear fields — see the module header on
/// `xmp::tone_curves`. They are preserved by the writers' unknown-node
/// passthrough instead.
#[test]
fn crs_tone_curve_pv2012_is_not_parsed_into_scene_linear_fields() {
    let block = r#"      <crs:ToneCurvePV2012>
        <rdf:Seq>
          <rdf:li>0, 0</rdf:li>
          <rdf:li>128, 180</rdf:li>
          <rdf:li>255, 255</rdf:li>
        </rdf:Seq>
      </crs:ToneCurvePV2012>"#;
    let model = parse(&sidecar(block)).expect("parse");
    assert!(model.tone_curve_luma.is_identity());
    assert!(model.tone_curve_red.is_identity());
    assert!(model.tone_curve_green.is_identity());
    assert!(model.tone_curve_blue.is_identity());
}

/// The keyword bag is the other nested element in the schema; the curve
/// walker must not swallow its `rdf:li` children.
#[test]
fn dc_subject_li_children_are_not_captured_as_curve_points() {
    let block = r#"      <dc:subject>
        <rdf:Bag>
          <rdf:li>sunset</rdf:li>
        </rdf:Bag>
      </dc:subject>"#;
    let model = parse(&sidecar(block)).expect("parse");
    assert!(model.tone_curve_luma.is_identity());
}

/// A malformed control point is dropped, not fatal — same tolerance the
/// walker applies to every other unrecognised construct.
#[test]
fn malformed_points_are_skipped() {
    let block = r#"      <papp:SceneLinearToneCurve>
        <rdf:Seq>
          <rdf:li>0, 0</rdf:li>
          <rdf:li>not a point</rdf:li>
          <rdf:li>255, 255</rdf:li>
        </rdf:Seq>
      </papp:SceneLinearToneCurve>"#;
    let model = parse(&sidecar(block)).expect("parse");
    assert_eq!(model.tone_curve_luma.points.len(), 2);
}

/// The nested walk must not disturb the flat attribute path that carries the
/// other ~70 fields, including the parametric scalars that share the ticket.
#[test]
fn flat_attributes_still_parse_alongside_a_nested_curve() {
    let xml = format!(
        r#"<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
    <rdf:Description
      xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
      xmlns:papp="http://ns.justmaple.app/1.0/"
      crs:Exposure2012="1.25"
      crs:ParametricLights="12.75"
      papp:ToneCurveMode="RatioPreserving">
{CANONICAL_BLOCK}
    </rdf:Description>
  </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>"#
    );
    let model = parse(&xml).expect("parse");
    assert_eq!(model.exposure, 1.25);
    assert_eq!(model.parametric_lights, 12.75);
    assert_eq!(model.tone_curve_mode, ToneCurveMode::RatioPreserving);
    assert_eq!(model.tone_curve_luma.points.len(), 5);
    assert_eq!(serialize_tone_curves(&model, INDENT), CANONICAL_BLOCK);
}
