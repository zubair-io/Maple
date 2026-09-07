//! The cross-language byte-parity fixture for local adjustments (#358),
//! split out of `tests_local_adjustments.rs` to keep that file inside the
//! file-size budget. Helpers (`sidecar`, `linear_layer`, `radial_layer`,
//! `INDENT`) come from that sibling module — one fixture, two files.

use super::tests_local_adjustments::{linear_layer, radial_layer, sidecar, INDENT};
use super::*;

/// Cross-language byte-parity fixture (#358): the same literal appears in
/// the Swift suite (`LocalAdjustmentXMPTests.swift`), the TypeScript suite
/// (`local-adjustments.spec.ts`) and the C# suite
/// (`XmpLocalAdjustmentsTests.cs`), and all four serializers must produce
/// it byte-for-byte from the same two-layer model at the same indent. Same
/// contract as the tone-curve `CANONICAL_BLOCK` in `tests_tone_curves.rs`.
const CANONICAL_BLOCK: &str = r#"      <crs:GradientBasedCorrections>
        <rdf:Seq>
          <rdf:li>
            <rdf:Description
              crs:What="Correction"
              crs:CorrectionAmount="1"
              crs:CorrectionActive="True"
              crs:LocalExposure2012="0.5"
              crs:LocalShadows2012="-20"
              crs:LocalHue="-0.425">
              <crs:CorrectionMasks>
                <rdf:Seq>
                  <rdf:li
                    crs:What="Mask/Gradient"
                    crs:MaskValue="1"
                    crs:ZeroX="0.2" crs:ZeroY="0.3"
                    crs:FullX="0.8" crs:FullY="0.7"
                    papp:LocalFeather="0.4"/>
                </rdf:Seq>
              </crs:CorrectionMasks>
            </rdf:Description>
          </rdf:li>
        </rdf:Seq>
      </crs:GradientBasedCorrections>
      <crs:CircularGradientBasedCorrections>
        <rdf:Seq>
          <rdf:li>
            <rdf:Description
              crs:What="Correction"
              crs:CorrectionAmount="1"
              crs:CorrectionActive="True"
              crs:LocalContrast2012="15"
              papp:LocalVibrance="-10"
              crs:LocalTemperature="200"
              papp:RangeKind="Color"
              papp:RangeHue="55"
              papp:RangeHueWidth="25"
              papp:RangeChromaMin="0.02"
              papp:RangeLMin="0.15"
              papp:RangeLMax="0.95"
              papp:RangeFeather="0.3">
              <crs:CorrectionMasks>
                <rdf:Seq>
                  <rdf:li
                    crs:What="Mask/CircularGradient"
                    crs:MaskValue="1"
                    crs:Top="0.25" crs:Left="0.25" crs:Bottom="0.5" crs:Right="0.75"
                    crs:Angle="45" crs:Midpoint="50" crs:Roundness="0"
                    crs:Feather="60" crs:Flipped="True"/>
                </rdf:Seq>
              </crs:CorrectionMasks>
            </rdf:Description>
          </rdf:li>
        </rdf:Seq>
      </crs:CircularGradientBasedCorrections>"#;

/// The serializer reproduces `CANONICAL_BLOCK` byte-for-byte from the
/// shared two-layer fixture — the Rust half of the four-way parity claim.
#[test]
fn serializes_the_cross_language_canonical_block() {
    let mut model = AdjustmentModel::default();
    model.local_adjustments = vec![linear_layer(), radial_layer()];
    assert_eq!(serialize_local_adjustments(&model, INDENT), CANONICAL_BLOCK);
}

/// …and parses it back into the identical fixture layers.
#[test]
fn parses_the_cross_language_canonical_block() {
    let parsed = parse(&sidecar(CANONICAL_BLOCK)).expect("parse");
    assert_eq!(
        parsed.local_adjustments,
        vec![linear_layer(), radial_layer()]
    );
}
