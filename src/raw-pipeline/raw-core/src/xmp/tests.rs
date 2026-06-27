//! Tests for the XMP sidecar parser. Split out of `mod.rs` to keep both
//! files under the 600-LOC hard cap (per CONTRIBUTING.md). No production
//! code needed to be touched: the parser's only public surface is
//! `parse()` plus the re-exported schema types, and both are reachable
//! from this sibling module via `super::*`.

#![cfg(test)]

use super::*;

/// Read a sidecar fixture under `test-fixtures/references/` (gitignored).
/// Panics when absent — callers are `#[cfg_attr(not(feature = "fixtures"),
/// ignore)]`, so the panic only fires when fixtures were explicitly
/// requested and the tree turned out to be incomplete (#1082).
fn load_fixture(rel: &str) -> String {
    let path = crate::test_support::fixtures::require_reference(rel);
    std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("read fixture {}: {}", path.display(), e))
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
#[cfg_attr(not(feature = "fixtures"), ignore)]
fn parse_baseline_is_reference_defaults() {
    let xml = load_fixture("test_0002/xmp/baseline.xmp");
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
#[cfg_attr(not(feature = "fixtures"), ignore)]
fn parse_exposure_max() {
    let xml = load_fixture("test_0002/xmp/exposure_max.xmp");
    let m = parse(&xml).unwrap();
    assert!(m.exposure > 0.5, "exposure was {}", m.exposure);
    assert_eq!(m.dehaze, 0.0);
}

#[test]
#[cfg_attr(not(feature = "fixtures"), ignore)]
fn parse_dehaze_max() {
    let xml = load_fixture("test_0002/xmp/dehaze_max.xmp");
    let m = parse(&xml).unwrap();
    assert_eq!(m.dehaze, 100.0);
}

#[test]
#[cfg_attr(not(feature = "fixtures"), ignore)]
fn parse_wb_daylight_uses_preset() {
    let xml = load_fixture("test_0002/xmp/wb_daylight.xmp");
    let m = parse(&xml).unwrap();
    assert!((m.temperature - 5500.0).abs() < 1.0,
        "expected 5500K from Daylight preset, got {}", m.temperature);
}

#[test]
#[cfg_attr(not(feature = "fixtures"), ignore)]
fn parse_wb_tungsten_uses_preset() {
    let xml = load_fixture("test_0002/xmp/wb_tungsten.xmp");
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
#[cfg_attr(not(feature = "fixtures"), ignore)]
fn parse_contrast_max() {
    let xml = load_fixture("test_0002/xmp/contrast_max.xmp");
    let m = parse(&xml).unwrap();
    assert_eq!(m.contrast, 100.0);
}

#[test]
#[cfg_attr(not(feature = "fixtures"), ignore)]
fn parse_highlights_min() {
    let xml = load_fixture("test_0002/xmp/highlights_min.xmp");
    let m = parse(&xml).unwrap();
    assert_eq!(m.highlights, -100.0);
}

#[test]
#[cfg_attr(not(feature = "fixtures"), ignore)]
fn parse_shadows_max() {
    let xml = load_fixture("test_0002/xmp/shadows_max.xmp");
    let m = parse(&xml).unwrap();
    assert_eq!(m.shadows, 100.0);
}

#[test]
#[cfg_attr(not(feature = "fixtures"), ignore)]
fn parse_whites_max() {
    let xml = load_fixture("test_0002/xmp/whites_max.xmp");
    let m = parse(&xml).unwrap();
    assert_eq!(m.whites, 100.0);
}

#[test]
#[cfg_attr(not(feature = "fixtures"), ignore)]
fn parse_blacks_min() {
    let xml = load_fixture("test_0002/xmp/blacks_min.xmp");
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
#[cfg_attr(not(feature = "fixtures"), ignore)]
fn parse_vibrance_max() {
    let xml = load_fixture("test_0002/xmp/vibrance_max.xmp");
    let m = parse(&xml).unwrap();
    assert_eq!(m.vibrance, 100.0);
}

#[test]
#[cfg_attr(not(feature = "fixtures"), ignore)]
fn parse_saturation_min() {
    let xml = load_fixture("test_0002/xmp/saturation_min.xmp");
    let m = parse(&xml).unwrap();
    assert_eq!(m.saturation, -100.0);
}

#[test]
#[cfg_attr(not(feature = "fixtures"), ignore)]
fn parse_clarity_max() {
    let xml = load_fixture("test_0002/xmp/clarity_max.xmp");
    let m = parse(&xml).unwrap();
    assert_eq!(m.clarity, 100.0);
}

#[test]
#[cfg_attr(not(feature = "fixtures"), ignore)]
fn parse_texture_min() {
    let xml = load_fixture("test_0002/xmp/texture_min.xmp");
    let m = parse(&xml).unwrap();
    assert_eq!(m.texture, -100.0);
}

/// Brightness (#1102): parses from the Maple-proprietary `papp:Brightness`
/// key. The legacy ACR PV2010 `crs:Brightness` key is deliberately NOT
/// mapped — different semantics (default +50, removed in PV2012); a
/// sidecar carrying it must leave the model at the default.
#[test]
fn parse_brightness() {
    let xml = r#"<?xml version="1.0"?>
        <x:xmpmeta xmlns:x="adobe:ns:meta/">
          <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
            <rdf:Description xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
              xmlns:papp="http://ns.justmaple.app/1.0/"
              papp:Brightness="-35"/>
          </rdf:RDF>
        </x:xmpmeta>"#;
    let m = parse(xml).unwrap();
    assert_eq!(m.brightness, -35.0);
}

/// PV2010 `crs:Brightness` must NOT be read into the Maple brightness
/// field (semantics mismatch — see `papp:Brightness` docs).
#[test]
fn crs_brightness_pv2010_is_ignored() {
    let xml = r#"<?xml version="1.0"?>
        <x:xmpmeta xmlns:x="adobe:ns:meta/">
          <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
            <rdf:Description xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
              crs:Brightness="50"/>
          </rdf:RDF>
        </x:xmpmeta>"#;
    let m = parse(xml).unwrap();
    assert_eq!(m.brightness, 0.0, "crs:Brightness (PV2010) must not map onto papp brightness");
}

/// Absent `papp:Brightness` leaves the default (0 — stage no-op), and the
/// serializer omits the attribute at the default so a default model writes
/// no `papp:Brightness` at all. Non-default values round-trip through
/// serialize → parse.
#[test]
fn brightness_serialize_roundtrip_and_default_omission() {
    let mut m = AdjustmentModel::default();
    assert!(!serialize(&m).contains("papp:Brightness"),
        "default brightness must not be serialized");

    m.brightness = 42.0;
    let frag = serialize(&m);
    assert!(frag.contains(r#"papp:Brightness="42""#), "got fragment: {}", frag);

    let xml = format!(
        r#"<?xml version="1.0"?>
        <x:xmpmeta xmlns:x="adobe:ns:meta/">
          <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
            <rdf:Description xmlns:papp="http://ns.justmaple.app/1.0/"{frag}/>
          </rdf:RDF>
        </x:xmpmeta>"#
    );
    let parsed = parse(&xml).unwrap();
    assert_eq!(parsed.brightness, 42.0);
}

/// Chroma pre-filter (#1104): parses from the Maple-proprietary
/// `papp:ChromaPrefilter` key. Deliberately distinct from ACR's
/// `crs:ColorNoiseReduction` (which maps onto the late-chain `nr_color`
/// NLM) — this stage runs inside the decode product.
#[test]
fn parse_chroma_prefilter() {
    let xml = r#"<?xml version="1.0"?>
        <x:xmpmeta xmlns:x="adobe:ns:meta/">
          <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
            <rdf:Description xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
              xmlns:papp="http://ns.justmaple.app/1.0/"
              papp:ChromaPrefilter="35"/>
          </rdf:RDF>
        </x:xmpmeta>"#;
    let m = parse(xml).unwrap();
    assert_eq!(m.chroma_prefilter, 35.0);
    // The decode-key field must not leak onto the NLM slider or vice versa.
    assert_eq!(m.nr_color, 25.0, "nr_color must stay at its default");
}

/// Absent `papp:ChromaPrefilter` leaves the default (0 — bit-identical
/// stage skip), the serializer omits the attribute at the default, and
/// non-default values round-trip through serialize → parse.
#[test]
fn chroma_prefilter_serialize_roundtrip_and_default_omission() {
    let mut m = AdjustmentModel::default();
    assert!(!serialize(&m).contains("papp:ChromaPrefilter"),
        "default chroma_prefilter must not be serialized");

    m.chroma_prefilter = 35.0;
    let frag = serialize(&m);
    assert!(frag.contains(r#"papp:ChromaPrefilter="35""#), "got fragment: {}", frag);

    let xml = format!(
        r#"<?xml version="1.0"?>
        <x:xmpmeta xmlns:x="adobe:ns:meta/">
          <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
            <rdf:Description xmlns:papp="http://ns.justmaple.app/1.0/"{frag}/>
          </rdf:RDF>
        </x:xmpmeta>"#
    );
    let parsed = parse(&xml).unwrap();
    assert_eq!(parsed.chroma_prefilter, 35.0);
}

/// BM3D deep denoise (#1105): parses from the Maple-proprietary
/// `papp:DeepDenoise` key; absent → default 0 (bit-identical skip); the
/// serializer omits the attribute at the default; non-default values
/// round-trip serialize → parse.
#[test]
fn deep_denoise_parse_serialize_roundtrip_and_default_omission() {
    let xml = r#"<?xml version="1.0"?>
        <x:xmpmeta xmlns:x="adobe:ns:meta/">
          <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
            <rdf:Description xmlns:papp="http://ns.justmaple.app/1.0/"
              papp:DeepDenoise="70"/>
          </rdf:RDF>
        </x:xmpmeta>"#;
    let m = parse(xml).unwrap();
    assert_eq!(m.deep_denoise, 70.0);

    let mut m = AdjustmentModel::default();
    assert!(!serialize(&m).contains("papp:DeepDenoise"),
        "default deep_denoise must not be serialized");
    m.deep_denoise = 70.0;
    let frag = serialize(&m);
    assert!(frag.contains(r#"papp:DeepDenoise="70""#), "got fragment: {}", frag);
    let xml = format!(
        r#"<?xml version="1.0"?><x><rdf:Description xmlns:rdf="x" xmlns:papp="x"{frag}/></x>"#
    );
    let parsed = parse(&xml).unwrap();
    assert_eq!(parsed.deep_denoise, 70.0);
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

// -----------------------------------------------------------------------
// Batch Metadata field tolerance (ticket #1581 / epic #1575)
// -----------------------------------------------------------------------

/// A sidecar carrying all 17 Batch Metadata simple attributes + the 5 managed
/// nested elements (dc:title, dc:creator, dc:description, dc:rights,
/// xmpRights:UsageTerms) must parse to an `AdjustmentModel` that is
/// **identical to the default** — none of the metadata fields live in the
/// adjustment model, and the Rust parser's `_ => {}` catch-all arm must
/// silently ignore them without returning an error.
///
/// This is the "Rust tolerance" gate from the M0b spec (spec 2026-06-26).
#[test]
fn parse_ignores_batch_metadata_fields() {
    let xml = r#"<?xml version="1.0"?>
        <x:xmpmeta xmlns:x="adobe:ns:meta/">
          <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
            <rdf:Description
              xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
              xmlns:papp="http://ns.justmaple.app/1.0/"
              xmlns:exif="http://ns.adobe.com/exif/1.0/"
              xmlns:photoshop="http://ns.adobe.com/photoshop/1.0/"
              xmlns:Iptc4xmpCore="http://iptc.org/std/Iptc4xmpCore/1.0/xmlns/"
              xmlns:dc="http://purl.org/dc/elements/1.1/"
              xmlns:xmpRights="http://ns.adobe.com/xap/1.0/rights/"
              crs:Exposure2012="1.5"
              exif:GPSLatitude="48,51.3960N"
              exif:GPSLongitude="2,21.1320E"
              exif:GPSAltitude="35000/1000"
              exif:GPSAltitudeRef="0"
              exif:DateTimeOriginal="2026-06-26T18:40:00+02:00"
              papp:TimeZone="Europe/Paris"
              Iptc4xmpCore:Location="Rue Vignon"
              photoshop:City="Paris"
              photoshop:State="Ile-de-France"
              photoshop:Country="France"
              Iptc4xmpCore:CountryCode="FR"
              photoshop:Headline="Trip"
              photoshop:Instructions="Embargo until July"
              photoshop:AuthorsPosition="Photographer"
              photoshop:Credit="Z. Lawrence"
              photoshop:Source="Maple"
              xmpRights:Marked="True">
              <dc:title>
                <rdf:Alt>
                  <rdf:li xml:lang="x-default">Sunset</rdf:li>
                </rdf:Alt>
              </dc:title>
              <dc:creator>
                <rdf:Seq>
                  <rdf:li>Ansel Adams</rdf:li>
                </rdf:Seq>
              </dc:creator>
              <dc:description>
                <rdf:Alt>
                  <rdf:li xml:lang="x-default">Notes here</rdf:li>
                </rdf:Alt>
              </dc:description>
              <dc:rights>
                <rdf:Alt>
                  <rdf:li xml:lang="x-default">All rights reserved</rdf:li>
                </rdf:Alt>
              </dc:rights>
              <xmpRights:UsageTerms>
                <rdf:Alt>
                  <rdf:li xml:lang="x-default">Usage terms here</rdf:li>
                </rdf:Alt>
              </xmpRights:UsageTerms>
            </rdf:Description>
          </rdf:RDF>
        </x:xmpmeta>"#;

    // Must parse without error.
    let m = parse(xml).expect("metadata-carrying sidecar must parse without error");

    // The known adjustment field (crs:Exposure2012) must be parsed correctly.
    assert!(
        (m.exposure - 1.5).abs() < 1e-4,
        "crs:Exposure2012 must be parsed: expected 1.5, got {}",
        m.exposure
    );

    // All other fields must remain at their defaults — the metadata attrs/nodes
    // must be silently ignored, not corrupt or reject the parse.
    let d = AdjustmentModel::default();
    assert_eq!(m.temperature, d.temperature, "temperature must stay default");
    assert_eq!(m.contrast, d.contrast, "contrast must stay default");
    assert_eq!(m.highlights, d.highlights, "highlights must stay default");
    assert_eq!(m.crop.is_identity(), true, "crop must stay identity");
}
