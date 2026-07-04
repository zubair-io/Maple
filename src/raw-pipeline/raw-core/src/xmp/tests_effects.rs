//! Tests for S5 effects (vignette/grain/split-tone), parametric tone-curve,
//! and crop/straighten XMP parsing. Split out of `tests.rs` to keep both
//! files under the 600-LOC hard cap (PR #1730). Contents moved verbatim.

#![cfg(test)]

use super::*;

/// S5 effects fields (ticket #643): vignette / grain / split-tone scalars
/// parse from Lightroom-compatible `crs:` keys (PostCropVignette*, Grain*,
/// SplitToning*). `crs:GrainFrequency` lands on `grain_roughness` — Maple's
/// name for LR's third grain knob.
#[test]
fn parse_s5_effects_fields() {
    let xml = r#"<?xml version="1.0"?>
        <x:xmpmeta xmlns:x="adobe:ns:meta/">
          <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
            <rdf:Description xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
              crs:PostCropVignetteAmount="-40"
              crs:PostCropVignetteFeather="70"
              crs:GrainAmount="35"
              crs:GrainSize="40"
              crs:GrainFrequency="55"
              crs:SplitToningShadowHue="220"
              crs:SplitToningShadowSaturation="30"
              crs:SplitToningHighlightHue="40"
              crs:SplitToningHighlightSaturation="25"
              crs:SplitToningBalance="-15"/>
          </rdf:RDF>
        </x:xmpmeta>"#;
    let m = parse(xml).unwrap();
    assert_eq!(m.vignette_amount, -40.0);
    assert_eq!(m.vignette_feather, 70.0);
    assert_eq!(m.grain_amount, 35.0);
    assert_eq!(m.grain_size, 40.0);
    assert_eq!(m.grain_roughness, 55.0);
    assert_eq!(m.split_tone_shadow_hue, 220.0);
    assert_eq!(m.split_tone_shadow_saturation, 30.0);
    assert_eq!(m.split_tone_highlight_hue, 40.0);
    assert_eq!(m.split_tone_highlight_saturation, 25.0);
    assert_eq!(m.split_tone_balance, -15.0);
}

/// Parametric tone-curve region sliders (prerequisite for #368): the four
/// PV2012 `crs:Parametric{Highlights,Lights,Darks,Shadows}` keys parse onto
/// the matching `parametric_*` model scalars. ACR's split-point keys are
/// intentionally unmapped — the model has no split-point fields (the knots
/// are fixed at 0.25/0.5/0.75 in `build_parametric_knots`).
#[test]
fn parse_parametric_tone_curve_fields() {
    let xml = r#"<?xml version="1.0"?>
        <x:xmpmeta xmlns:x="adobe:ns:meta/">
          <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
            <rdf:Description xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
              crs:ParametricHighlights="100"
              crs:ParametricLights="-50"
              crs:ParametricDarks="25"
              crs:ParametricShadows="-100"/>
          </rdf:RDF>
        </x:xmpmeta>"#;
    let m = parse(xml).unwrap();
    assert_eq!(m.parametric_highlights, 100.0);
    assert_eq!(m.parametric_lights, -50.0);
    assert_eq!(m.parametric_darks, 25.0);
    assert_eq!(m.parametric_shadows, -100.0);
}

/// Absent parametric attributes round-trip as the zero (identity) defaults.
#[test]
fn parse_no_parametric_attrs_leaves_defaults() {
    let xml = r#"<?xml version="1.0"?>
        <x:xmpmeta xmlns:x="adobe:ns:meta/">
          <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
            <rdf:Description xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/" crs:Exposure2012="0"/>
          </rdf:RDF>
        </x:xmpmeta>"#;
    let m = parse(xml).unwrap();
    let d = AdjustmentModel::default();
    assert_eq!(m.parametric_highlights, d.parametric_highlights);
    assert_eq!(m.parametric_lights, d.parametric_lights);
    assert_eq!(m.parametric_darks, d.parametric_darks);
    assert_eq!(m.parametric_shadows, d.parametric_shadows);
}

/// Absent S5 effects attributes round-trip as the identity-stub defaults
/// — vignetteFeather=50, grainSize=25, grainRoughness=50, everything else
/// 0. Guards the "default-shaped sidecar produces the canonical default
/// model" invariant.
#[test]
fn parse_no_s5_attrs_leaves_defaults() {
    let xml = r#"<?xml version="1.0"?>
        <x:xmpmeta xmlns:x="adobe:ns:meta/">
          <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
            <rdf:Description xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/" crs:Exposure2012="0"/>
          </rdf:RDF>
        </x:xmpmeta>"#;
    let m = parse(xml).unwrap();
    let d = AdjustmentModel::default();
    assert_eq!(m.vignette_amount, d.vignette_amount);
    assert_eq!(m.vignette_feather, d.vignette_feather);
    assert_eq!(m.grain_amount, d.grain_amount);
    assert_eq!(m.grain_size, d.grain_size);
    assert_eq!(m.grain_roughness, d.grain_roughness);
    assert_eq!(m.split_tone_shadow_hue, d.split_tone_shadow_hue);
    assert_eq!(
        m.split_tone_shadow_saturation,
        d.split_tone_shadow_saturation
    );
    assert_eq!(m.split_tone_highlight_hue, d.split_tone_highlight_hue);
    assert_eq!(
        m.split_tone_highlight_saturation,
        d.split_tone_highlight_saturation
    );
    assert_eq!(m.split_tone_balance, d.split_tone_balance);
}

// -----------------------------------------------------------------------
// Crop / straighten (spec § 3.12, ticket #277)
// -----------------------------------------------------------------------

#[test]
fn defaults_crop_is_identity() {
    let m = AdjustmentModel::default();
    assert!(m.crop.is_identity());
    assert_eq!(m.crop.top, 0.0);
    assert_eq!(m.crop.left, 0.0);
    assert_eq!(m.crop.bottom, 1.0);
    assert_eq!(m.crop.right, 1.0);
    assert_eq!(m.crop.angle, 0.0);
}

#[test]
fn parse_crop_with_has_crop_true_applies_rect() {
    let xml = r#"<?xml version="1.0"?><x><rdf:Description xmlns:rdf="x" xmlns:crs="x"
        crs:HasCrop="True"
        crs:CropTop="0.1" crs:CropLeft="0.2"
        crs:CropBottom="0.9" crs:CropRight="0.8"/></x>"#;
    let m = parse(xml).unwrap();
    assert!((m.crop.top - 0.1).abs() < 1e-6);
    assert!((m.crop.left - 0.2).abs() < 1e-6);
    assert!((m.crop.bottom - 0.9).abs() < 1e-6);
    assert!((m.crop.right - 0.8).abs() < 1e-6);
    assert_eq!(m.crop.angle, 0.0);
}

#[test]
fn parse_crop_without_has_crop_leaves_identity() {
    // Stale crop fields without HasCrop=True must be ignored, matching
    // ACR's behaviour. The angle field is independent and would still
    // pass through, so this case carries no angle.
    let xml = r#"<?xml version="1.0"?><x><rdf:Description xmlns:rdf="x" xmlns:crs="x"
        crs:CropTop="0.5" crs:CropLeft="0.5"
        crs:CropBottom="0.9" crs:CropRight="0.9"/></x>"#;
    let m = parse(xml).unwrap();
    assert!(
        m.crop.is_identity(),
        "crop without HasCrop=True should stay identity, got {:?}",
        m.crop
    );
}

#[test]
fn parse_crop_has_crop_false_leaves_identity() {
    let xml = r#"<?xml version="1.0"?><x><rdf:Description xmlns:rdf="x" xmlns:crs="x"
        crs:HasCrop="False"
        crs:CropTop="0.5" crs:CropLeft="0.5"
        crs:CropBottom="0.9" crs:CropRight="0.9"/></x>"#;
    let m = parse(xml).unwrap();
    assert!(m.crop.is_identity());
}

#[test]
fn parse_crop_angle_without_rect_applies_pure_straighten() {
    // `crs:CropAngle` is independent of `crs:HasCrop` per spec § 01
    // invariant 3 — a pure rotation can be emitted alone.
    let xml = r#"<?xml version="1.0"?><x><rdf:Description xmlns:rdf="x" xmlns:crs="x"
        crs:CropAngle="-2.5"/></x>"#;
    let m = parse(xml).unwrap();
    assert_eq!(m.crop.top, 0.0);
    assert_eq!(m.crop.left, 0.0);
    assert_eq!(m.crop.bottom, 1.0);
    assert_eq!(m.crop.right, 1.0);
    assert!((m.crop.angle - (-2.5)).abs() < 1e-6);
    assert!(!m.crop.is_identity());
}

#[test]
fn parse_crop_with_angle_and_rect_round_trips() {
    let xml = r#"<?xml version="1.0"?><x><rdf:Description xmlns:rdf="x" xmlns:crs="x"
        crs:HasCrop="True"
        crs:CropTop="0.05" crs:CropLeft="0.0"
        crs:CropBottom="0.95" crs:CropRight="1.0"
        crs:CropAngle="3.75"/></x>"#;
    let m = parse(xml).unwrap();
    assert!((m.crop.top - 0.05).abs() < 1e-6);
    assert!((m.crop.bottom - 0.95).abs() < 1e-6);
    assert!((m.crop.angle - 3.75).abs() < 1e-6);
}

#[test]
fn parse_crop_constrain_to_warp_is_silently_accepted() {
    let xml = r#"<?xml version="1.0"?><x><rdf:Description xmlns:rdf="x" xmlns:crs="x"
        crs:HasCrop="True"
        crs:CropTop="0.1" crs:CropLeft="0.1"
        crs:CropBottom="0.9" crs:CropRight="0.9"
        crs:CropConstrainToWarp="0"/></x>"#;
    assert!(parse(xml).is_ok());
}
