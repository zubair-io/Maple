//! The cross-language byte-parity fixture for local adjustments (#358),
//! split out of `tests_local_adjustments.rs` to keep that file inside the
//! file-size budget. Helpers (`sidecar`, `linear_layer`, `radial_layer`,
//! `INDENT`) come from that sibling module — one fixture, two files.

use super::tests_local_adjustments::{linear_layer, radial_layer, sidecar, INDENT};
use super::*;
use crate::types::local_adjustment::{Mask, Point2};

#[test]
fn fine_mask_coordinates_survive_repeated_round_trips() {
    let mut linear = linear_layer();
    linear.mask = Mask::Linear {
        start: Point2::new(0.300698, 0.500123),
        end: Point2::new(0.700321, 0.499876),
        feather: 0.5,
    };
    let mut radial = radial_layer();
    radial.mask = Mask::Radial {
        center: Point2::new(0.500698, 0.499876),
        radii: Point2::new(0.001234, 0.002345),
        angle: 0.0,
        feather: 0.5,
        invert: false,
    };
    let mut model = AdjustmentModel::default();
    model.local_adjustments = vec![linear, radial];
    let block = serialize_local_adjustments(&model, INDENT);
    assert!(block.contains("crs:ZeroX=\"0.300698\" crs:ZeroY=\"0.500123\""));
    assert!(block.contains(
        "crs:Top=\"0.497531\" crs:Left=\"0.499464\" crs:Bottom=\"0.502221\" crs:Right=\"0.501932\""
    ));
    let mut current = block.clone();
    for _ in 0..5 {
        let parsed = parse(&sidecar(&current)).expect("fine mask parse");
        assert_eq!(parsed.local_adjustments.len(), 2);
        current = serialize_local_adjustments(&parsed, INDENT);
        assert_eq!(current, block);
    }
}

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
              crs:LocalHue="-0.425"
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
              crs:LocalHue="0"
              crs:LocalTexture="0.18"
              crs:LocalClarity2012="0.35"
              crs:LocalDehaze="-0.225"
              crs:LocalSharpness="0.66"
              crs:LocalLuminanceNoise="0.4"
              crs:LocalDefringe="0.75"
              papp:RangeKind="Color"
              papp:RangeHue="210"
              papp:RangeHueWidth="40"
              papp:RangeChromaMin="0.1"
              papp:RangeLMin="0"
              papp:RangeLMax="1"
              papp:RangeFeather="0">
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
