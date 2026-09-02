//! Display-referred point tone-curve XMP I/O (#2232) — nested `rdf:Seq` /
//! `rdf:li` elements under the four `crs:ToneCurvePV2012*` parents.
//!
//! Sibling of `tests_tone_curves.rs` (the scene-linear `papp:` family),
//! split out rather than appended so neither file grows past the 600-LOC
//! hard cap. `CANONICAL_BLOCK` here is this ticket's own cross-language
//! parity artifact — the same literal must appear in
//! `DisplayToneCurveXMPTests.swift` and `display-tone-curve.spec.ts`.

use super::*;
use crate::types::adjustment::ToneCurve;

/// Child indent used by the parity fixtures (`docs/xmp-canonical-format.md`
/// § "Indentation").
const INDENT: &str = "      ";

/// Cross-language byte-parity fixture — a non-identity three-point master
/// curve (PV2012's own point curve editor authors far fewer knots on
/// average than Maple's scene-linear editor, so three knots here is a
/// deliberately different shape from `tests_tone_curves::CANONICAL_BLOCK`'s
/// five — both cases matter).
const CANONICAL_BLOCK: &str = r#"      <crs:ToneCurvePV2012>
        <rdf:Seq>
          <rdf:li>0, 0</rdf:li>
          <rdf:li>128, 150</rdf:li>
          <rdf:li>255, 255</rdf:li>
        </rdf:Seq>
      </crs:ToneCurvePV2012>"#;

/// The `[0, 1]` model form of `CANONICAL_BLOCK`.
fn canonical_points() -> Vec<(f32, f32)> {
    vec![(0.0, 0.0), (128.0 / 255.0, 150.0 / 255.0), (1.0, 1.0)]
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
fn parses_nested_three_point_master_curve() {
    let model = parse(&sidecar(CANONICAL_BLOCK)).expect("parse");
    let expected = canonical_points();
    assert_eq!(model.display_tone_curve_luma.points.len(), 3);
    for (got, want) in model
        .display_tone_curve_luma
        .points
        .iter()
        .zip(expected.iter())
    {
        assert!((got.0 - want.0).abs() < 1e-6, "x {got:?} vs {want:?}");
        assert!((got.1 - want.1).abs() < 1e-6, "y {got:?} vs {want:?}");
    }
    // Only the master curve was authored — the scene-linear family and the
    // display-referred R/G/B siblings all stay identity.
    assert!(model.tone_curve_luma.is_identity());
    assert!(model.display_tone_curve_red.is_identity());
    assert!(model.display_tone_curve_green.is_identity());
    assert!(model.display_tone_curve_blue.is_identity());
}

/// The load-bearing acceptance test: bytes → model → bytes is the identity
/// function for a non-identity display-referred curve.
#[test]
fn round_trips_three_point_curve_byte_for_byte() {
    let model = parse(&sidecar(CANONICAL_BLOCK)).expect("parse");
    assert_eq!(serialize_tone_curves(&model, INDENT), CANONICAL_BLOCK);
}

#[test]
fn serializes_canonical_block_from_a_hand_built_model() {
    let mut model = AdjustmentModel::default();
    model.display_tone_curve_luma = ToneCurve::new(canonical_points());
    assert_eq!(serialize_tone_curves(&model, INDENT), CANONICAL_BLOCK);
}

/// Identity is silence — an unedited model must add nothing to the document.
#[test]
fn identity_curves_emit_nothing() {
    let model = AdjustmentModel::default();
    assert!(model.display_tone_curve_luma.is_identity());
    assert_eq!(serialize_tone_curves(&model, INDENT), "");
}

#[test]
fn all_four_display_channels_round_trip_in_canonical_order_after_the_scene_linear_family() {
    let mut model = AdjustmentModel::default();
    model.display_tone_curve_luma = ToneCurve::new(vec![(0.0, 0.0), (1.0, 1.0)]);
    model.display_tone_curve_red = ToneCurve::new(vec![(0.0, 0.0), (0.5, 0.6), (1.0, 1.0)]);
    model.display_tone_curve_green = ToneCurve::new(vec![(0.0, 0.0), (0.25, 0.2), (1.0, 1.0)]);
    model.display_tone_curve_blue = ToneCurve::new(vec![(0.0, 0.1), (1.0, 0.9)]);
    // A scene-linear curve too, to pin that BOTH families coexist and emit
    // in the documented order (scene-linear block first, then display).
    model.tone_curve_luma = ToneCurve::new(vec![(0.0, 0.0), (1.0, 1.0)]);

    let block = serialize_tone_curves(&model, INDENT);
    let order: Vec<usize> = [
        "<papp:SceneLinearToneCurve>",
        "<crs:ToneCurvePV2012>",
        "<crs:ToneCurvePV2012Red>",
        "<crs:ToneCurvePV2012Green>",
        "<crs:ToneCurvePV2012Blue>",
    ]
    .iter()
    .map(|e| block.find(e).unwrap_or_else(|| panic!("missing {e}")))
    .collect();
    assert!(
        order.windows(2).all(|w| w[0] < w[1]),
        "child order: {order:?}"
    );

    let reparsed = parse(&sidecar(&block)).expect("parse");
    assert_eq!(serialize_tone_curves(&reparsed, INDENT), block);
}

/// Real ACR/Lightroom-authored content: the same fixture the Apple suite
/// uses (`XMPPassthroughTests.lightroomSidecar` / `SidecarContractSupport`)
/// and the TypeScript suite mirrors — a genuine Lightroom Classic export
/// carrying a master `crs:ToneCurvePV2012`, a mask group, a snapshot stack
/// and an edit history. Before #2232 all four rode the unknown-node
/// passthrough; now the curve parses structurally and the other three stay
/// passthrough (verified by the Apple/TS suites' passthrough-count tests).
const ACR_AUTHORED_SIDECAR: &str = r#"<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="Adobe XMP Core 9.0-c001 79.b0f8be9">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""
    xmlns:xmp="http://ns.adobe.com/xap/1.0/"
    xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
    xmlns:xmpMM="http://ns.adobe.com/xap/1.0/mm/"
    xmlns:stEvt="http://ns.adobe.com/xap/1.0/sType/ResourceEvent#"
   xmp:Rating="3"
   xmpMM:DocumentID="xmp.did:9a5f1b40-2c1b-4a2f-9d3d-1f0b2c4d5e6f"
   xmpMM:InstanceID="xmp.iid:0e3a7c21-91d5-4b0c-8a44-2f7c1e8d9a10"
   crs:Version="15.0"
   crs:ProcessVersion="11.0"
   crs:Exposure2012="+0.35"
   crs:Contrast2012="+10"
   crs:RawFileName="DSCF1234.RAF"
   crs:CameraProfile="Adobe Standard &amp; Neutral"
   crs:HasSettings="True">
   <crs:ToneCurvePV2012>
    <rdf:Seq>
     <rdf:li>0, 0</rdf:li>
     <rdf:li>32, 22</rdf:li>
     <rdf:li>255, 255</rdf:li>
    </rdf:Seq>
   </crs:ToneCurvePV2012>
   <crs:MaskGroupBasedCorrections>
    <rdf:Seq>
     <rdf:li>
      <rdf:Description
       crs:What="Correction"
       crs:CorrectionAmount="1"
       crs:LocalExposure2012="+0.500000">
      <crs:CorrectionMasks>
       <rdf:Seq>
        <rdf:li crs:What="Mask/Gradient" crs:MaskValue="1" crs:ZeroX="0.5" crs:ZeroY="0.1"/>
       </rdf:Seq>
      </crs:CorrectionMasks>
      </rdf:Description>
     </rdf:li>
    </rdf:Seq>
   </crs:MaskGroupBasedCorrections>
   <crs:Snapshots>
    <rdf:Bag>
     <rdf:li>Import</rdf:li>
    </rdf:Bag>
   </crs:Snapshots>
   <xmpMM:History>
    <rdf:Seq>
     <rdf:li stEvt:action="derived" stEvt:parameters="converted 5 &gt; 4 stops"/>
     <rdf:li stEvt:action="saved" stEvt:when="2026-01-04T10:11:12-05:00"/>
    </rdf:Seq>
   </xmpMM:History>
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>"#;

#[test]
fn acr_authored_sidecar_parses_the_master_curve_and_the_basic_panel() {
    let model = parse(ACR_AUTHORED_SIDECAR).expect("parse a real Lightroom export");
    assert_eq!(model.display_tone_curve_luma.points.len(), 3);
    let expected = [(0.0, 0.0), (32.0 / 255.0, 22.0 / 255.0), (1.0, 1.0)];
    for (got, want) in model
        .display_tone_curve_luma
        .points
        .iter()
        .zip(expected.iter())
    {
        assert!((got.0 - want.0).abs() < 1e-6);
        assert!((got.1 - want.1).abs() < 1e-6);
    }
    // Flat attributes on the same element still parse alongside the nested
    // curve — the walker must not swallow the attribute pass.
    assert_eq!(model.exposure, 0.35);
    assert_eq!(model.contrast, 10.0);
    // The mask group / snapshot / history subtrees have no raw-core model
    // representation at all — raw-core's `parse` only ever produces an
    // `AdjustmentModel`, never a passthrough bucket (that lives in the
    // Swift/TypeScript writers per `docs/architecture.md`); this test's
    // job is only to prove the curve extraction doesn't choke on their
    // presence in the same document.
}

/// Re-serializing a model parsed from the ACR fixture reproduces the exact
/// same `crs:ToneCurvePV2012` block — the round-trip half of the ACR test
/// above.
#[test]
fn acr_authored_curve_round_trips_byte_for_byte() {
    let model = parse(ACR_AUTHORED_SIDECAR).expect("parse");
    let emitted = serialize_tone_curves(&model, "    ");
    assert_eq!(
        emitted,
        "    <crs:ToneCurvePV2012>\n      <rdf:Seq>\n        <rdf:li>0, 0</rdf:li>\n        \
         <rdf:li>32, 22</rdf:li>\n        <rdf:li>255, 255</rdf:li>\n      </rdf:Seq>\n    \
         </crs:ToneCurvePV2012>"
    );
}
