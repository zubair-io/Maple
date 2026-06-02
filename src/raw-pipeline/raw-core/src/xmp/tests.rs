//! Tests for the XMP sidecar parser. Split out of `mod.rs` to keep both
//! files under the 600-LOC hard cap (per CONTRIBUTING.md). No production
//! code needed to be touched: the parser's only public surface is
//! `parse()` plus the re-exported schema types, and both are reachable
//! from this sibling module via `super::*`.

#![cfg(test)]

use super::*;

fn load_fixture(rel: &str) -> Option<String> {
    let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../test-fixtures/references").join(rel);
    std::fs::read_to_string(path).ok()
}

#[test]
fn defaults() {
    let m = AdjustmentModel::default();
    assert_eq!(m.temperature, 6500.0);
    assert_eq!(m.tint, 0.0);
    assert_eq!(m.exposure, 0.0);
    assert_eq!(m.contrast, 0.0);
    assert_eq!(m.highlights, 0.0);
    assert_eq!(m.shadows, 0.0);
    assert_eq!(m.whites, 0.0);
    assert_eq!(m.blacks, 0.0);
    assert_eq!(m.dehaze, 0.0);
}

#[test]
fn parse_baseline_is_reference_defaults() {
    let xml = match load_fixture("test_0002/xmp/baseline.xmp") {
        Some(x) => x, None => return,
    };
    let m = parse(&xml).unwrap();
    // baseline.xmp is the camera's default reference-renderer sidecar,
    // which records the reference renderer's user-visible defaults
    // (Sharpness=40, SharpenRadius=1.0). As of #326,
    // `AdjustmentModel::default()` already encodes the reference-
    // renderer import baseline, so the explicit overrides below are
    // no-ops — we keep them spelled out to document what the test is
    // asserting and to fail loudly if a future commit shifts the
    // canonical defaults away from the reference renderer.
    let reference_defaults = AdjustmentModel {
        sharpen_amount: 40.0,
        sharpen_radius: 1.0,
        ..AdjustmentModel::default()
    };
    assert_eq!(m, reference_defaults);
}

#[test]
fn parse_exposure_max() {
    let xml = match load_fixture("test_0002/xmp/exposure_max.xmp") {
        Some(x) => x, None => return,
    };
    let m = parse(&xml).unwrap();
    assert!(m.exposure > 0.5, "exposure was {}", m.exposure);
    assert_eq!(m.dehaze, 0.0);
}

#[test]
fn parse_dehaze_max() {
    let xml = match load_fixture("test_0002/xmp/dehaze_max.xmp") {
        Some(x) => x, None => return,
    };
    let m = parse(&xml).unwrap();
    assert_eq!(m.dehaze, 100.0);
}

#[test]
fn parse_wb_daylight_uses_preset() {
    let xml = match load_fixture("test_0002/xmp/wb_daylight.xmp") {
        Some(x) => x, None => return,
    };
    let m = parse(&xml).unwrap();
    assert!((m.temperature - 5500.0).abs() < 1.0,
        "expected 5500K from Daylight preset, got {}", m.temperature);
}

#[test]
fn parse_wb_tungsten_uses_preset() {
    let xml = match load_fixture("test_0002/xmp/wb_tungsten.xmp") {
        Some(x) => x, None => return,
    };
    let m = parse(&xml).unwrap();
    assert!((m.temperature - 2850.0).abs() < 1.0,
        "expected 2850K from Tungsten preset, got {}", m.temperature);
}

#[test]
fn explicit_temperature_overrides_preset() {
    // If both WhiteBalance and Temperature are present, explicit wins.
    let xml = r#"<?xml version="1.0"?><x><rdf:Description xmlns:rdf="x" xmlns:crs="x"
        crs:WhiteBalance="Daylight" crs:Temperature="3200"/></x>"#;
    let m = parse(xml).unwrap();
    assert!((m.temperature - 3200.0).abs() < 1.0);
}

#[test]
fn unknown_wb_preset_leaves_defaults() {
    let xml = r#"<?xml version="1.0"?><x><rdf:Description xmlns:rdf="x" xmlns:crs="x"
        crs:WhiteBalance="As Shot"/></x>"#;
    let m = parse(xml).unwrap();
    assert_eq!(m.temperature, 6500.0);
    assert_eq!(m.tint, 0.0);
}

#[test]
fn unknown_fields_are_ignored() {
    let xml = r#"<?xml version="1.0"?><x><rdf:Description xmlns:rdf="x" xmlns:crs="x"
        crs:Exposure2012="1.5" crs:SomeFutureField="99"/></x>"#;
    let m = parse(xml).unwrap();
    assert_eq!(m.exposure, 1.5);
}

#[test]
fn defaults_includes_new_slice2_fields() {
    let m = AdjustmentModel::default();
    assert_eq!(m.contrast, 0.0);
    assert_eq!(m.highlights, 0.0);
    assert_eq!(m.shadows, 0.0);
    assert_eq!(m.whites, 0.0);
    assert_eq!(m.blacks, 0.0);
}

#[test]
fn parse_contrast_max() {
    let xml = match load_fixture("test_0002/xmp/contrast_max.xmp") {
        Some(x) => x, None => return,
    };
    let m = parse(&xml).unwrap();
    assert_eq!(m.contrast, 100.0);
}

#[test]
fn parse_highlights_min() {
    let xml = match load_fixture("test_0002/xmp/highlights_min.xmp") {
        Some(x) => x, None => return,
    };
    let m = parse(&xml).unwrap();
    assert_eq!(m.highlights, -100.0);
}

#[test]
fn parse_shadows_max() {
    let xml = match load_fixture("test_0002/xmp/shadows_max.xmp") {
        Some(x) => x, None => return,
    };
    let m = parse(&xml).unwrap();
    assert_eq!(m.shadows, 100.0);
}

#[test]
fn parse_whites_max() {
    let xml = match load_fixture("test_0002/xmp/whites_max.xmp") {
        Some(x) => x, None => return,
    };
    let m = parse(&xml).unwrap();
    assert_eq!(m.whites, 100.0);
}

#[test]
fn parse_blacks_min() {
    let xml = match load_fixture("test_0002/xmp/blacks_min.xmp") {
        Some(x) => x, None => return,
    };
    let m = parse(&xml).unwrap();
    assert_eq!(m.blacks, -100.0);
}

#[test]
fn defaults_includes_slice3_presence_fields() {
    let m = AdjustmentModel::default();
    assert_eq!(m.vibrance, 0.0);
    assert_eq!(m.saturation, 0.0);
    assert_eq!(m.clarity, 0.0);
    assert_eq!(m.texture, 0.0);
}

#[test]
fn parse_vibrance_max() {
    let xml = match load_fixture("test_0002/xmp/vibrance_max.xmp") {
        Some(x) => x, None => return,
    };
    let m = parse(&xml).unwrap();
    assert_eq!(m.vibrance, 100.0);
}

#[test]
fn parse_saturation_min() {
    let xml = match load_fixture("test_0002/xmp/saturation_min.xmp") {
        Some(x) => x, None => return,
    };
    let m = parse(&xml).unwrap();
    assert_eq!(m.saturation, -100.0);
}

#[test]
fn parse_clarity_max() {
    let xml = match load_fixture("test_0002/xmp/clarity_max.xmp") {
        Some(x) => x, None => return,
    };
    let m = parse(&xml).unwrap();
    assert_eq!(m.clarity, 100.0);
}

#[test]
fn parse_texture_min() {
    let xml = match load_fixture("test_0002/xmp/texture_min.xmp") {
        Some(x) => x, None => return,
    };
    let m = parse(&xml).unwrap();
    assert_eq!(m.texture, -100.0);
}

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
    assert_eq!(m.split_tone_shadow_saturation, d.split_tone_shadow_saturation);
    assert_eq!(m.split_tone_highlight_hue, d.split_tone_highlight_hue);
    assert_eq!(m.split_tone_highlight_saturation, d.split_tone_highlight_saturation);
    assert_eq!(m.split_tone_balance, d.split_tone_balance);
}
