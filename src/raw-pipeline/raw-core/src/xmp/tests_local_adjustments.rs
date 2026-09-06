//! Canonical local-adjustment XMP I/O (#358) — `crs:GradientBasedCorrections`
//! / `crs:CircularGradientBasedCorrections`, `crs:CorrectionMasks`, migration
//! from the Slice-1 `papp:LocalAdjustments` JSON attribute.

use super::*;
use crate::types::local_adjustment::{
    LocalAdjustment, Mask, PartialAdjustments, Point2, SKIN_TONE_RANGE,
};

/// Six-space child indent, matching `docs/xmp-canonical-format.md` §
/// "Indentation" and the tone-curve tests' own `INDENT`.
pub(super) const INDENT: &str = "      ";

pub(super) fn sidecar(children: &str) -> String {
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

pub(super) fn linear_layer() -> LocalAdjustment {
    LocalAdjustment {
        mask: Mask::Linear {
            start: Point2::new(0.2, 0.3),
            end: Point2::new(0.8, 0.7),
            feather: 0.4,
        },
        range: None,
        adjustments: PartialAdjustments {
            exposure: Some(0.5),
            shadows: Some(-20.0),
            ..Default::default()
        },
    }
}

pub(super) fn radial_layer() -> LocalAdjustment {
    LocalAdjustment {
        mask: Mask::Radial {
            // Binary-exact fractions so the wire form's `center ± radii`
            // bounding box round-trips to bit-identical doubles on the
            // Swift/TypeScript/C# sides too (0.4 ± 0.15 does not).
            center: Point2::new(0.5, 0.375),
            radii: Point2::new(0.25, 0.125),
            angle: std::f32::consts::FRAC_PI_4,
            feather: 0.6,
            invert: true,
        },
        range: None,
        adjustments: PartialAdjustments {
            contrast: Some(15.0),
            vibrance: Some(-10.0),
            temperature: Some(200.0),
            ..Default::default()
        },
    }
}

/// Round trip through the model, not through hand-typed bytes: build a
/// model, serialize, splice into a sidecar, parse it back, and assert the
/// recovered layers equal the originals exactly. This is the ticket's
/// load-bearing acceptance bar: "a sidecar written by Maple must read
/// identically back via the same parser."
#[test]
fn model_to_bytes_to_model_round_trips_linear_and_radial() {
    let mut model = AdjustmentModel::default();
    model.local_adjustments = vec![linear_layer(), radial_layer()];

    let children = serialize_local_adjustments(&model, INDENT);
    let doc = sidecar(&children);
    let parsed = parse(&doc).expect("parse");

    assert_eq!(parsed.local_adjustments.len(), 2, "doc:\n{doc}");
    assert_eq!(parsed.local_adjustments[0], linear_layer());
    assert_eq!(parsed.local_adjustments[1], radial_layer());
}

/// Write → parse → write is a fixed point (same claim #3 in the canonical
/// format doc's test contract, applied to this subtree).
#[test]
fn write_parse_write_is_a_fixed_point() {
    let mut model = AdjustmentModel::default();
    model.local_adjustments = vec![linear_layer(), radial_layer()];

    let once = serialize_local_adjustments(&model, INDENT);
    let parsed = parse(&sidecar(&once)).expect("parse");
    let twice = serialize_local_adjustments(&parsed, INDENT);
    assert_eq!(once, twice);
}

/// Identity is silence: no layers, no output — an untouched model stays
/// byte-identical to a pre-#358 sidecar on re-save.
#[test]
fn no_layers_emits_nothing() {
    let model = AdjustmentModel::default();
    assert_eq!(serialize_local_adjustments(&model, INDENT), "");
}

/// A hand-authored, ACR-schema-plausible fixture (real attribute names and
/// nesting confirmed against the Camera Raw Settings XMP tag reference —
/// see the docs addition in the same commit) must parse into the same
/// model shape a Maple-authored one would, proving the *read* side accepts
/// third-party input, not only Maple's own writer output.
#[test]
fn parses_acr_plausible_gradient_and_radial() {
    let children = r#"      <crs:GradientBasedCorrections>
        <rdf:Seq>
          <rdf:li>
            <rdf:Description
              crs:What="Correction"
              crs:CorrectionAmount="1"
              crs:CorrectionActive="True"
              crs:LocalExposure2012="0.5"
              crs:LocalContrast2012="10">
              <crs:CorrectionMasks>
                <rdf:Seq>
                  <rdf:li
                    crs:What="Mask/Gradient"
                    crs:MaskValue="1"
                    crs:ZeroX="0.100000"
                    crs:ZeroY="0.200000"
                    crs:FullX="0.900000"
                    crs:FullY="0.800000"/>
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
              crs:LocalSaturation="-15"
              crs:LocalTemperature="-50">
              <crs:CorrectionMasks>
                <rdf:Seq>
                  <rdf:li
                    crs:What="Mask/CircularGradient"
                    crs:MaskValue="1"
                    crs:Top="0.200000"
                    crs:Left="0.250000"
                    crs:Bottom="0.600000"
                    crs:Right="0.750000"
                    crs:Angle="0"
                    crs:Midpoint="50"
                    crs:Roundness="0"
                    crs:Feather="50"
                    crs:Flipped="false"/>
                </rdf:Seq>
              </crs:CorrectionMasks>
            </rdf:Description>
          </rdf:li>
        </rdf:Seq>
      </crs:CircularGradientBasedCorrections>"#;

    let model = parse(&sidecar(children)).expect("parse");
    assert_eq!(model.local_adjustments.len(), 2);

    match &model.local_adjustments[0].mask {
        Mask::Linear { start, end, .. } => {
            assert!((start.x - 0.1).abs() < 1e-4);
            assert!((end.y - 0.8).abs() < 1e-4);
        }
        other => panic!("expected linear mask, got {other:?}"),
    }
    assert_eq!(model.local_adjustments[0].adjustments.exposure, Some(0.5));
    assert_eq!(model.local_adjustments[0].adjustments.contrast, Some(10.0));

    match &model.local_adjustments[1].mask {
        Mask::Radial {
            center,
            radii,
            invert,
            ..
        } => {
            assert!((center.x - 0.5).abs() < 1e-4);
            assert!((radii.y - 0.2).abs() < 1e-4);
            assert!(!invert);
        }
        other => panic!("expected radial mask, got {other:?}"),
    }
    assert_eq!(
        model.local_adjustments[1].adjustments.saturation,
        Some(-15.0)
    );
}

/// Forward-compat: an unrecognized `crs:What` on `CorrectionMasks` (a brush
/// or range mask Maple doesn't model) drops that one correction rather than
/// failing the whole document — same tolerant-reader contract Slice 1's
/// JSON format documents.
#[test]
fn unrecognized_mask_kind_is_skipped_not_fatal() {
    let children = r#"      <crs:GradientBasedCorrections>
        <rdf:Seq>
          <rdf:li>
            <rdf:Description crs:What="Correction" crs:CorrectionAmount="1" crs:CorrectionActive="True" crs:LocalExposure2012="1">
              <crs:CorrectionMasks>
                <rdf:Seq>
                  <rdf:li crs:What="Mask/Brush" crs:MaskValue="1"/>
                </rdf:Seq>
              </crs:CorrectionMasks>
            </rdf:Description>
          </rdf:li>
        </rdf:Seq>
      </crs:GradientBasedCorrections>"#;
    let model = parse(&sidecar(children)).expect("parse");
    assert!(model.local_adjustments.is_empty());
}

/// A recognized mask's core geometry is required, not defaulted: a
/// gradient mask missing `crs:ZeroX` is a hard parse error rather than a
/// silently invented `0` (Copilot review on #3212 — a silently-placed mask
/// would produce a plausible-looking but wrong render with no signal
/// anything was off).
#[test]
fn missing_required_geometry_is_a_hard_error() {
    let children = r#"      <crs:GradientBasedCorrections>
        <rdf:Seq>
          <rdf:li>
            <rdf:Description crs:What="Correction" crs:CorrectionAmount="1" crs:CorrectionActive="True" crs:LocalExposure2012="1">
              <crs:CorrectionMasks>
                <rdf:Seq>
                  <rdf:li crs:What="Mask/Gradient" crs:MaskValue="1" crs:ZeroY="0" crs:FullX="1" crs:FullY="1"/>
                </rdf:Seq>
              </crs:CorrectionMasks>
            </rdf:Description>
          </rdf:li>
        </rdf:Seq>
      </crs:GradientBasedCorrections>"#;
    assert!(parse(&sidecar(children)).is_err());
}

/// `crs:CorrectionActive="False"` drops the whole correction — Lightroom's
/// own "disabled pin" semantics, since Maple has no present-but-inactive
/// layer state to preserve it as (Copilot review on #3212).
#[test]
fn inactive_correction_is_dropped() {
    let children = r#"      <crs:GradientBasedCorrections>
        <rdf:Seq>
          <rdf:li>
            <rdf:Description crs:What="Correction" crs:CorrectionAmount="1" crs:CorrectionActive="False" crs:LocalExposure2012="2">
              <crs:CorrectionMasks>
                <rdf:Seq>
                  <rdf:li crs:What="Mask/Gradient" crs:MaskValue="1" crs:ZeroX="0" crs:ZeroY="0" crs:FullX="1" crs:FullY="0"/>
                </rdf:Seq>
              </crs:CorrectionMasks>
            </rdf:Description>
          </rdf:li>
        </rdf:Seq>
      </crs:GradientBasedCorrections>"#;
    let model = parse(&sidecar(children)).expect("parse");
    assert!(model.local_adjustments.is_empty());
}

/// `crs:CorrectionActive` and `crs:Flipped` accept the same case-insensitive
/// `on`/`off` spelling set as every other boolean-like field in the schema
/// (`crs:LensProfileEnable`), not just the exact-cased `"True"`/`"False"`
/// pair Maple's own writer emits — a third-party sidecar may spell these
/// lowercase (Copilot review on #3212).
#[test]
fn correction_active_and_flipped_accept_case_insensitive_on_off() {
    let children = r#"      <crs:CircularGradientBasedCorrections>
        <rdf:Seq>
          <rdf:li>
            <rdf:Description crs:What="Correction" crs:CorrectionActive="on" crs:LocalExposure2012="1">
              <crs:CorrectionMasks>
                <rdf:Seq>
                  <rdf:li crs:What="Mask/CircularGradient" crs:MaskValue="1" crs:Top="0" crs:Left="0" crs:Bottom="1" crs:Right="1" crs:Flipped="ON"/>
                </rdf:Seq>
              </crs:CorrectionMasks>
            </rdf:Description>
          </rdf:li>
        </rdf:Seq>
      </crs:CircularGradientBasedCorrections>"#;
    let model = parse(&sidecar(children)).expect("parse");
    assert_eq!(
        model.local_adjustments.len(),
        1,
        "CorrectionActive=\"on\" must keep the layer"
    );
    match &model.local_adjustments[0].mask {
        Mask::Radial { invert, .. } => assert!(invert, "Flipped=\"ON\" must set invert"),
        other => panic!("expected radial mask, got {other:?}"),
    }
}

/// `crs:CorrectionAmount` (Adobe's 0-1 overall-strength dial) scales every
/// wired slider by that amount at parse time (Copilot review on #3212).
#[test]
fn correction_amount_scales_every_slider() {
    let children = r#"      <crs:GradientBasedCorrections>
        <rdf:Seq>
          <rdf:li>
            <rdf:Description crs:What="Correction" crs:CorrectionAmount="0.5" crs:CorrectionActive="True" crs:LocalExposure2012="2" crs:LocalContrast2012="-40">
              <crs:CorrectionMasks>
                <rdf:Seq>
                  <rdf:li crs:What="Mask/Gradient" crs:MaskValue="1" crs:ZeroX="0" crs:ZeroY="0" crs:FullX="1" crs:FullY="0"/>
                </rdf:Seq>
              </crs:CorrectionMasks>
            </rdf:Description>
          </rdf:li>
        </rdf:Seq>
      </crs:GradientBasedCorrections>"#;
    let model = parse(&sidecar(children)).expect("parse");
    assert_eq!(model.local_adjustments.len(), 1);
    assert_eq!(model.local_adjustments[0].adjustments.exposure, Some(1.0));
    assert_eq!(model.local_adjustments[0].adjustments.contrast, Some(-20.0));
}

/// A mask leaf written as an explicit open/close pair (`<rdf:li
/// ...></rdf:li>`, `Event::Start`+`Event::End` with no text) rather than
/// self-closing must parse the same as the self-closing form — a
/// third-party writer's XML-shape choice shouldn't silently drop the mask
/// (Copilot + Jules review on #3212).
#[test]
fn non_self_closing_mask_li_still_parses() {
    let children = r#"      <crs:GradientBasedCorrections>
        <rdf:Seq>
          <rdf:li>
            <rdf:Description crs:What="Correction" crs:CorrectionAmount="1" crs:CorrectionActive="True" crs:LocalExposure2012="0.5">
              <crs:CorrectionMasks>
                <rdf:Seq>
                  <rdf:li crs:What="Mask/Gradient" crs:MaskValue="1" crs:ZeroX="0.1" crs:ZeroY="0.2" crs:FullX="0.9" crs:FullY="0.8"></rdf:li>
                </rdf:Seq>
              </crs:CorrectionMasks>
            </rdf:Description>
          </rdf:li>
        </rdf:Seq>
      </crs:GradientBasedCorrections>"#;
    let model = parse(&sidecar(children)).expect("parse");
    assert_eq!(model.local_adjustments.len(), 1);
    match &model.local_adjustments[0].mask {
        Mask::Linear { start, end, .. } => {
            assert!((start.x - 0.1).abs() < 1e-4);
            assert!((end.y - 0.8).abs() < 1e-4);
        }
        other => panic!("expected linear mask, got {other:?}"),
    }
}

/// A recognized mask with a corrupt numeric field is a hard parse error —
/// matches every other known numeric key in the schema.
#[test]
fn corrupt_known_field_is_a_hard_error() {
    let children = r#"      <crs:GradientBasedCorrections>
        <rdf:Seq>
          <rdf:li>
            <rdf:Description crs:What="Correction" crs:CorrectionAmount="1" crs:CorrectionActive="True" crs:LocalExposure2012="not-a-number">
              <crs:CorrectionMasks>
                <rdf:Seq>
                  <rdf:li crs:What="Mask/Gradient" crs:MaskValue="1" crs:ZeroX="0" crs:ZeroY="0" crs:FullX="1" crs:FullY="1"/>
                </rdf:Seq>
              </crs:CorrectionMasks>
            </rdf:Description>
          </rdf:li>
        </rdf:Seq>
      </crs:GradientBasedCorrections>"#;
    assert!(parse(&sidecar(children)).is_err());
}

/// Migration: the Slice-1 `papp:LocalAdjustments` JSON attribute still
/// parses on its own (no canonical elements present).
#[test]
fn legacy_json_attribute_still_parses() {
    let json = r#"[{"mask":{"type":"linear","start":[0.0,0.0],"end":[1.0,0.0],"feather":0.5},"adjustments":{"exposure":1.0}}]"#;
    let children = format!(
        r#"      papp:LocalAdjustments="{}""#,
        json.replace('"', "&quot;")
    );
    // The legacy attribute lives on `rdf:Description` itself, not as a
    // child element — splice it into the open tag rather than the body.
    let doc = format!(
        r#"<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
    <rdf:Description
      xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
      xmlns:papp="http://ns.justmaple.app/1.0/"
      crs:Version="11.0"
{children}>
    </rdf:Description>
  </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>"#
    );
    let model = parse(&doc).expect("parse");
    assert_eq!(model.local_adjustments.len(), 1);
    assert_eq!(model.local_adjustments[0].adjustments.exposure, Some(1.0));
}

/// Precedence: when a document carries both the legacy attribute and the
/// canonical nested form (should only happen in a hand-edited fixture), the
/// canonical form wins — see the precedence note in `local_adjustments.rs`.
#[test]
fn canonical_form_wins_over_legacy_attribute_when_both_present() {
    let json = r#"[{"mask":{"type":"linear","start":[0.0,0.0],"end":[1.0,0.0],"feather":0.5},"adjustments":{"exposure":9.0}}]"#;
    let legacy_attr = format!("papp:LocalAdjustments=\"{}\"", json.replace('"', "&quot;"));
    let canonical = r#"<crs:GradientBasedCorrections>
        <rdf:Seq>
          <rdf:li>
            <rdf:Description crs:What="Correction" crs:CorrectionAmount="1" crs:CorrectionActive="True" crs:LocalExposure2012="0.25">
              <crs:CorrectionMasks>
                <rdf:Seq>
                  <rdf:li crs:What="Mask/Gradient" crs:MaskValue="1" crs:ZeroX="0" crs:ZeroY="0" crs:FullX="1" crs:FullY="0"/>
                </rdf:Seq>
              </crs:CorrectionMasks>
            </rdf:Description>
          </rdf:li>
        </rdf:Seq>
      </crs:GradientBasedCorrections>"#;
    let doc = format!(
        r#"<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
    <rdf:Description
      xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
      xmlns:papp="http://ns.justmaple.app/1.0/"
      crs:Version="11.0"
      {legacy_attr}>
      {canonical}
    </rdf:Description>
  </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>"#
    );
    let model = parse(&doc).expect("parse");
    assert_eq!(model.local_adjustments.len(), 1);
    // 0.25 (canonical), not 9.0 (legacy) — canonical won.
    assert_eq!(model.local_adjustments[0].adjustments.exposure, Some(0.25));
}

#[test]
fn local_hue_round_trips_through_crs_local_hue_at_adobe_scale() {
    let mut model = AdjustmentModel::default();
    model.local_adjustments = vec![LocalAdjustment::linear(
        Point2::new(0.1, 0.1),
        Point2::new(0.9, 0.9),
        PartialAdjustments {
            hue: Some(-35.0),
            ..Default::default()
        },
    )];
    let children = serialize_local_adjustments(&model, INDENT);
    assert!(
        children.contains(r#"crs:LocalHue="-0.35""#),
        "hue is written on Adobe's ±1 scale:\n{children}"
    );
    let parsed = parse(&sidecar(&children)).expect("parse");
    assert_eq!(parsed.local_adjustments[0].adjustments.hue, Some(-35.0));
}

#[test]
fn range_refinement_round_trips_as_papp_range_attributes() {
    let mut layer = radial_layer();
    layer.range = Some(SKIN_TONE_RANGE);
    let mut model = AdjustmentModel::default();
    model.local_adjustments = vec![layer.clone()];
    let children = serialize_local_adjustments(&model, INDENT);
    for key in [
        "papp:RangeKind=\"Color\"",
        "papp:RangeHue=\"55\"",
        "papp:RangeHueWidth=\"25\"",
        "papp:RangeChromaMin=\"0.02\"",
        "papp:RangeLMin=\"0.15\"",
        "papp:RangeLMax=\"0.95\"",
        "papp:RangeFeather=\"0.3\"",
    ] {
        assert!(children.contains(key), "missing {key}:\n{children}");
    }
    let parsed = parse(&sidecar(&children)).expect("parse");
    assert_eq!(parsed.local_adjustments, vec![layer]);
}

#[test]
fn a_correction_without_range_attributes_parses_with_range_none() {
    let mut model = AdjustmentModel::default();
    model.local_adjustments = vec![linear_layer()];
    let children = serialize_local_adjustments(&model, INDENT);
    assert!(!children.contains("papp:Range"));
    let parsed = parse(&sidecar(&children)).expect("parse");
    assert_eq!(parsed.local_adjustments[0].range, None);
}

#[test]
fn an_everywhere_style_range_only_correction_still_needs_a_recognized_mask() {
    // A range refinement is a REFINEMENT of a primary mask, not a standalone
    // one — a correction whose mask is unrecognized still drops entirely
    // even if papp:Range* attributes are present, matching the tolerant
    // reader's existing "no mask ⇒ nothing to render" rule.
    let children = format!(
        "{INDENT}<crs:GradientBasedCorrections>\n{INDENT}  <rdf:Seq>\n{INDENT}    <rdf:li>\n{INDENT}      <rdf:Description\n{INDENT}        crs:What=\"Correction\"\n{INDENT}        crs:CorrectionAmount=\"1\"\n{INDENT}        crs:CorrectionActive=\"True\"\n{INDENT}        papp:RangeKind=\"Color\"\n{INDENT}        papp:RangeHue=\"55\">\n{INDENT}        <crs:CorrectionMasks>\n{INDENT}          <rdf:Seq>\n{INDENT}            <rdf:li crs:What=\"Mask/Unknown\" crs:MaskValue=\"1\"/>\n{INDENT}          </rdf:Seq>\n{INDENT}        </crs:CorrectionMasks>\n{INDENT}      </rdf:Description>\n{INDENT}    </rdf:li>\n{INDENT}  </rdf:Seq>\n{INDENT}</crs:GradientBasedCorrections>"
    );
    let parsed = parse(&sidecar(&children)).expect("parse");
    assert!(parsed.local_adjustments.is_empty());
}

#[test]
fn a_fractional_local_hue_survives_the_adobe_scale_round_trip() {
    // ±100 → ±1 loses two decimal places at the 2-decimal wire precision;
    // LocalHue is written with four so −42.5 comes back as −42.5, not −43
    // (#3280 review).
    let mut model = AdjustmentModel::default();
    model.local_adjustments = vec![LocalAdjustment::linear(
        Point2::new(0.1, 0.1),
        Point2::new(0.9, 0.9),
        PartialAdjustments {
            hue: Some(-42.5),
            ..Default::default()
        },
    )];
    let children = serialize_local_adjustments(&model, INDENT);
    assert!(children.contains(r#"crs:LocalHue="-0.425""#), "{children}");
    let parsed = parse(&sidecar(&children)).expect("parse");
    assert_eq!(parsed.local_adjustments[0].adjustments.hue, Some(-42.5));
}
