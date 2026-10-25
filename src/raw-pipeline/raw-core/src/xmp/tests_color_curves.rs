use super::*;
use crate::types::adjustment::{ToneCurve, ToneCurveMode};

const INDENT: &str = "      ";

// Byte-parity fixture: the same block is asserted in the Swift, TS and C# suites.
const CANONICAL_BLOCK: &str = r#"      <papp:ColorCurveHueVsSat>
        <rdf:Seq>
          <rdf:li>0, 128</rdf:li>
          <rdf:li>85, 191</rdf:li>
          <rdf:li>255, 128</rdf:li>
        </rdf:Seq>
      </papp:ColorCurveHueVsSat>"#;

const NEW_KEYS: [&str; 9] = [
    "papp:ColorCurveHueVsHue",
    "papp:ColorCurveHueVsSat",
    "papp:ColorCurveHueVsLuma",
    "papp:ColorCurveLumaVsSat",
    "papp:ColorCurveSatVsSat",
    "papp:ColorCurveSatVsLuma",
    "papp:ColorGradeBlending",
    "papp:ColorGradeShadowEdge",
    "papp:ColorGradeHighlightEdge",
];

fn canonical_points() -> Vec<(f32, f32)> {
    vec![
        (0.0, 128.0 / 255.0),
        (85.0 / 255.0, 191.0 / 255.0),
        (1.0, 128.0 / 255.0),
    ]
}

fn edited_model() -> AdjustmentModel {
    AdjustmentModel {
        color_curve_hue_vs_hue: ToneCurve::new(vec![(0.0, 0.5), (0.5, 0.75), (1.0, 0.5)]),
        color_curve_hue_vs_sat: ToneCurve::new(canonical_points()),
        color_curve_hue_vs_luma: ToneCurve::new(vec![(0.2, 0.4), (0.6, 0.6)]),
        color_curve_luma_vs_sat: ToneCurve::new(vec![(0.0, 0.5), (1.0, 0.8)]),
        color_curve_sat_vs_sat: ToneCurve::new(vec![(0.0, 0.0), (1.0, 0.9)]),
        color_curve_sat_vs_luma: ToneCurve::new(vec![(0.1, 0.5), (0.9, 0.3)]),
        color_grade_blending: 40.0,
        color_grade_shadow_edge: 0.3,
        color_grade_highlight_edge: 0.7,
        ..AdjustmentModel::default()
    }
}

fn sidecar(model: &AdjustmentModel) -> String {
    format!(
        r#"<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
    <rdf:Description
      xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
      xmlns:papp="http://ns.justmaple.app/1.0/"
      crs:Version="11.0"{}>
{}
    </rdf:Description>
  </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>"#,
        serialize(model),
        serialize_tone_curves(model, INDENT)
    )
}

fn assert_points(got: &ToneCurve, want: &ToneCurve, label: &str) {
    assert_eq!(got.points.len(), want.points.len(), "{label} length");
    for (g, w) in got.points.iter().zip(&want.points) {
        assert!((g.0 - w.0).abs() < 1.0 / 255.0, "{label} x {g:?} vs {w:?}");
        assert!((g.1 - w.1).abs() < 1.0 / 255.0, "{label} y {g:?} vs {w:?}");
    }
}

#[test]
fn the_canonical_block_is_the_serialization_of_a_hue_vs_sat_curve() {
    let model = AdjustmentModel {
        color_curve_hue_vs_sat: ToneCurve::new(canonical_points()),
        ..AdjustmentModel::default()
    };
    assert_eq!(serialize_tone_curves(&model, INDENT), CANONICAL_BLOCK);
}

#[test]
fn every_new_field_round_trips_through_the_sidecar() {
    let model = edited_model();
    let back = parse(&sidecar(&model)).expect("parse");
    assert_points(
        &back.color_curve_hue_vs_hue,
        &model.color_curve_hue_vs_hue,
        "hue vs hue",
    );
    assert_points(
        &back.color_curve_hue_vs_sat,
        &model.color_curve_hue_vs_sat,
        "hue vs sat",
    );
    assert_points(
        &back.color_curve_hue_vs_luma,
        &model.color_curve_hue_vs_luma,
        "hue vs luma",
    );
    assert_points(
        &back.color_curve_luma_vs_sat,
        &model.color_curve_luma_vs_sat,
        "luma vs sat",
    );
    assert_points(
        &back.color_curve_sat_vs_sat,
        &model.color_curve_sat_vs_sat,
        "sat vs sat",
    );
    assert_points(
        &back.color_curve_sat_vs_luma,
        &model.color_curve_sat_vs_luma,
        "sat vs luma",
    );
    assert_eq!(back.color_grade_blending, 40.0);
    assert!((back.color_grade_shadow_edge - 0.3).abs() < 1e-6);
    assert!((back.color_grade_highlight_edge - 0.7).abs() < 1e-6);
}

#[test]
fn tone_curve_mode_parses_from_its_attribute_and_defaults_when_absent() {
    let xml = sidecar(&AdjustmentModel::default());
    assert_eq!(
        parse(&xml).expect("parse").tone_curve_mode,
        ToneCurveMode::PerChannel
    );
    let with_mode = xml.replace(
        r#"crs:Version="11.0""#,
        r#"crs:Version="11.0" papp:ToneCurveMode="RatioPreserving""#,
    );
    assert_eq!(
        parse(&with_mode).expect("parse").tone_curve_mode,
        ToneCurveMode::RatioPreserving
    );
}

#[test]
fn a_default_model_serializes_none_of_the_new_fields() {
    let xml = sidecar(&AdjustmentModel::default());
    for key in NEW_KEYS {
        assert!(!xml.contains(key), "{key} must be omitted at its default");
    }
    assert!(!xml.contains("ToneCurveMode"));
}

#[test]
fn a_sidecar_written_before_the_fields_existed_parses_to_the_defaults() {
    let old = sidecar(&AdjustmentModel {
        brightness: 12.0,
        ..AdjustmentModel::default()
    });
    let model = parse(&old).expect("parse");
    let defaults = AdjustmentModel::default();
    assert_eq!(model.brightness, 12.0);
    for curve in [
        &model.color_curve_hue_vs_hue,
        &model.color_curve_hue_vs_sat,
        &model.color_curve_hue_vs_luma,
        &model.color_curve_luma_vs_sat,
        &model.color_curve_sat_vs_sat,
        &model.color_curve_sat_vs_luma,
    ] {
        assert!(curve.is_identity());
    }
    assert_eq!(model.color_grade_blending, defaults.color_grade_blending);
    assert_eq!(
        model.color_grade_shadow_edge,
        defaults.color_grade_shadow_edge
    );
    assert_eq!(
        model.color_grade_highlight_edge,
        defaults.color_grade_highlight_edge
    );
    assert_eq!(model.tone_curve_mode, defaults.tone_curve_mode);
}

#[test]
fn a_single_edit_emits_only_its_own_new_key() {
    let xml = sidecar(&AdjustmentModel {
        color_grade_blending: 40.0,
        ..AdjustmentModel::default()
    });
    assert!(xml.contains("papp:ColorGradeBlending"));
    for key in NEW_KEYS.iter().filter(|k| **k != "papp:ColorGradeBlending") {
        assert!(!xml.contains(key), "{key} leaked into an unrelated edit");
    }
}
