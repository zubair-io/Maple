//! The six per-mask SPATIAL controls' XMP contract (#3407) — Adobe's ±1
//! fraction scale, omit-on-default, and the `crs:CorrectionAmount` scaling.
//! A sibling file so `tests_local_adjustments.rs` stays inside the 600-line
//! source budget, the same split `tests_local_adjustments_canonical.rs` uses.

use super::tests_local_adjustments::{sidecar, INDENT};
use super::*;
use crate::types::local_adjustment::{LocalAdjustment, PartialAdjustments, Point2};

/// A Lightroom-authored correction carrying the six #3407 keys parses into
/// Maple's ±100 sliders, and re-serialising reproduces the SAME attribute
/// text byte-for-byte — the ticket's explicit acceptance bar. Adobe stores
/// these as ±1 fractions, so `crs:LocalClarity2012="0.35"` is a Clarity of
/// +35 and must come back out as `"0.35"`, not `"0.35000001"` or `"35"`.
#[test]
fn a_lightroom_authored_spatial_correction_round_trips_byte_for_byte() {
    let block = r#"      <crs:CircularGradientBasedCorrections>
        <rdf:Seq>
          <rdf:li>
            <rdf:Description
              crs:What="Correction"
              crs:CorrectionAmount="1"
              crs:CorrectionActive="True"
              crs:LocalTexture="0.2"
              crs:LocalClarity2012="0.35"
              crs:LocalDehaze="-0.4"
              crs:LocalSharpness="0.55"
              crs:LocalLuminanceNoise="0.3"
              crs:LocalDefringe="0.65">
              <crs:CorrectionMasks>
                <rdf:Seq>
                  <rdf:li
                    crs:What="Mask/CircularGradient"
                    crs:MaskValue="1"
                    crs:Top="0.25" crs:Left="0.25" crs:Bottom="0.75" crs:Right="0.75"
                    crs:Angle="0" crs:Midpoint="50" crs:Roundness="0"
                    crs:Feather="50" crs:Flipped="False"/>
                </rdf:Seq>
              </crs:CorrectionMasks>
            </rdf:Description>
          </rdf:li>
        </rdf:Seq>
      </crs:CircularGradientBasedCorrections>"#;
    let model = parse(&sidecar(block)).expect("parse");
    let a = &model.local_adjustments[0].adjustments;
    // The ×100 lift out of Adobe's fraction scale is a float multiply, so
    // these are compared to within f32 noise (0.3 × 100 is 30.000002);
    // the byte-for-byte assertion below is what pins the WIRE exactly.
    for (got, want) in [
        (a.texture, 20.0),
        (a.clarity, 35.0),
        (a.dehaze, -40.0),
        (a.sharpness, 55.0),
        (a.luminance_noise, 30.0),
        (a.defringe, 65.0),
    ] {
        let got = got.expect("control present");
        assert!((got - want).abs() < 1e-4, "{got} vs {want}");
    }
    assert_eq!(serialize_local_adjustments(&model, INDENT), block);
}

/// Omit-on-default: a layer that sets none of the six emits none of the six
/// keys, so an unedited correction stays byte-identical on re-save.
#[test]
fn unset_spatial_controls_emit_no_attributes() {
    let mut model = AdjustmentModel::default();
    model.local_adjustments = vec![LocalAdjustment::linear(
        Point2::new(0.0, 0.0),
        Point2::new(1.0, 0.0),
        PartialAdjustments {
            exposure: Some(0.25),
            ..Default::default()
        },
    )];
    let children = serialize_local_adjustments(&model, INDENT);
    for key in [
        "crs:LocalTexture",
        "crs:LocalClarity2012",
        "crs:LocalDehaze",
        "crs:LocalSharpness",
        "crs:LocalLuminanceNoise",
        "crs:LocalDefringe",
    ] {
        assert!(!children.contains(key), "{key} leaked into:\n{children}");
    }
    let parsed = parse(&sidecar(&children)).expect("parse");
    assert!(parsed.local_adjustments[0].adjustments.spatial_is_empty());
}

/// `crs:CorrectionAmount` scales the spatial controls exactly as it scales
/// every other stored delta — Adobe's own Amount semantics.
#[test]
fn correction_amount_scales_the_spatial_controls() {
    let block = r#"      <crs:GradientBasedCorrections>
        <rdf:Seq>
          <rdf:li>
            <rdf:Description
              crs:What="Correction"
              crs:CorrectionAmount="0.5"
              crs:LocalClarity2012="0.4">
              <crs:CorrectionMasks>
                <rdf:Seq>
                  <rdf:li
                    crs:What="Mask/Gradient"
                    crs:MaskValue="1"
                    crs:ZeroX="0" crs:ZeroY="0"
                    crs:FullX="1" crs:FullY="0"/>
                </rdf:Seq>
              </crs:CorrectionMasks>
            </rdf:Description>
          </rdf:li>
        </rdf:Seq>
      </crs:GradientBasedCorrections>"#;
    let model = parse(&sidecar(block)).expect("parse");
    let clarity = model.local_adjustments[0]
        .adjustments
        .clarity
        .expect("clarity present");
    assert!((clarity - 20.0).abs() < 1e-4, "{clarity}");
}
