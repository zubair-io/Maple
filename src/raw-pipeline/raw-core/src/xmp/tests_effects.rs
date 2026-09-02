//! Tests for S5 effects (vignette/grain/split-tone), parametric tone-curve,
//! and crop/straighten XMP parsing. Split out of `tests.rs` to keep both
//! files under the 600-LOC hard cap (PR #1730). Contents moved verbatim.

#![cfg(test)]

use super::*;
use crate::types::adjustment::BlackWhiteMode;

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
/// the matching `parametric_*` model scalars, and (#2320) the three ACR
/// split-point keys parse onto `parametric_{shadow,midtone,highlight}_split`.
#[test]
fn parse_parametric_tone_curve_fields() {
    let xml = r#"<?xml version="1.0"?>
        <x:xmpmeta xmlns:x="adobe:ns:meta/">
          <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
            <rdf:Description xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
              crs:ParametricHighlights="100"
              crs:ParametricLights="-50"
              crs:ParametricDarks="25"
              crs:ParametricShadows="-100"
              crs:ParametricShadowSplit="20"
              crs:ParametricMidtoneSplit="55"
              crs:ParametricHighlightSplit="80"/>
          </rdf:RDF>
        </x:xmpmeta>"#;
    let m = parse(xml).unwrap();
    assert_eq!(m.parametric_highlights, 100.0);
    assert_eq!(m.parametric_lights, -50.0);
    assert_eq!(m.parametric_darks, 25.0);
    assert_eq!(m.parametric_shadows, -100.0);
    assert_eq!(m.parametric_shadow_split, 20.0);
    assert_eq!(m.parametric_midtone_split, 55.0);
    assert_eq!(m.parametric_highlight_split, 80.0);
}

/// Absent parametric attributes round-trip as the identity defaults — 0 for
/// the region sliders, 25/50/75 for the split points.
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
    assert_eq!(m.parametric_shadow_split, d.parametric_shadow_split);
    assert_eq!(m.parametric_midtone_split, d.parametric_midtone_split);
    assert_eq!(m.parametric_highlight_split, d.parametric_highlight_split);
    assert_eq!(d.parametric_shadow_split, 25.0);
    assert_eq!(d.parametric_midtone_split, 50.0);
    assert_eq!(d.parametric_highlight_split, 75.0);
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

// #1943: a NaN / Infinity / -Infinity numeric attribute (from a hand-edited or
// corrupted sidecar) must be rejected at parse time rather than accepted into
// AdjustmentModel, where it would propagate through the render before being
// silently zeroed pixel-by-pixel. `f32::from_str` accepts all of these spellings.
fn nan_inf_xml(value: &str) -> String {
    format!(
        r#"<?xml version="1.0"?><x><rdf:Description xmlns:rdf="x" xmlns:crs="x"
        crs:Exposure2012="{value}"/></x>"#
    )
}

#[test]
fn parse_rejects_non_finite_numeric_values() {
    for value in [
        "NaN",
        "nan",
        "inf",
        "-inf",
        "Infinity",
        "-Infinity",
        "infinity",
    ] {
        let result = parse(&nan_inf_xml(value));
        assert!(
            result.is_err(),
            "expected non-finite crs:Exposure2012={value:?} to be rejected, got {result:?}"
        );
    }
}

#[test]
fn parse_still_accepts_finite_negative_and_fractional_values() {
    // The finite guard must not reject legitimate signed / fractional sliders.
    for value in ["-4.5", "0", "0.0", "5.0", "-0.001"] {
        let m = parse(&nan_inf_xml(value)).unwrap_or_else(|e| {
            panic!("finite crs:Exposure2012={value:?} should parse, got {e:?}")
        });
        assert!(m.exposure.is_finite());
    }
}

/// Parametric region sliders serialize to the four PV2012 `crs:Parametric*`
/// keys and omit at the zero default (#365 — the write half; the parse half
/// landed with #368's prerequisite above). Non-default values round-trip
/// through serialize → parse.
#[test]
fn parametric_serialize_roundtrip_and_default_omission() {
    let mut m = AdjustmentModel::default();
    assert!(
        !serialize(&m).contains("crs:Parametric"),
        "default parametric fields must not be serialized"
    );

    m.parametric_highlights = 100.0;
    m.parametric_lights = -50.0;
    m.parametric_darks = 12.75; // fractional — widget drags are not integer-quantized
    m.parametric_shadows = -100.0;
    let frag = serialize(&m);
    for expected in [
        r#"crs:ParametricHighlights="100""#,
        r#"crs:ParametricLights="-50""#,
        r#"crs:ParametricDarks="12.75""#,
        r#"crs:ParametricShadows="-100""#,
    ] {
        assert!(
            frag.contains(expected),
            "missing {expected} in fragment: {frag}"
        );
    }

    let xml = format!(
        r#"<?xml version="1.0"?>
        <x:xmpmeta xmlns:x="adobe:ns:meta/">
          <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
            <rdf:Description xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"{frag}/>
          </rdf:RDF>
        </x:xmpmeta>"#
    );
    let parsed = parse(&xml).unwrap();
    assert_eq!(parsed.parametric_highlights, 100.0);
    assert_eq!(parsed.parametric_lights, -50.0);
    assert_eq!(parsed.parametric_darks, 12.75);
    assert_eq!(parsed.parametric_shadows, -100.0);
}

/// The omit-on-default test and the emitted value share the canonical
/// 2-decimal wire codec: float-noise that rounds to 0 emits nothing (the
/// raw `!= 0.0` gate would have written `crs:Parametric*="0.004"` while
/// Swift/TS write nothing, churning otherwise-identical sidecars), values
/// round to 2 decimals on the wire, and non-finite values are skipped.
#[test]
fn parametric_serialize_rounds_to_wire_codec() {
    let mut m = AdjustmentModel::default();
    m.parametric_lights = 0.004;
    assert!(
        !serialize(&m).contains("crs:Parametric"),
        "a value that rounds to 0 must be omitted, got: {}",
        serialize(&m)
    );

    m.parametric_lights = 33.333_333;
    let frag = serialize(&m);
    assert!(
        frag.contains(r#"crs:ParametricLights="33.33""#),
        "wire value must round to 2 decimals, got: {frag}"
    );

    m.parametric_lights = f32::NAN;
    assert!(
        !serialize(&m).contains("crs:Parametric"),
        "non-finite values must not reach the sidecar"
    );
}

/// The three ACR split points (#2320) serialize to their `crs:Parametric*
/// Split` keys and omit at their own non-zero defaults (25/50/75) — each
/// compared against its own default, not a shared `!= 0.0` gate. Non-default
/// values round-trip through serialize → parse.
#[test]
fn parametric_split_serialize_roundtrip_and_default_omission() {
    let m = AdjustmentModel::default();
    assert!(
        !serialize(&m).contains("Split"),
        "default split points must not be serialized"
    );

    let mut m = AdjustmentModel::default();
    m.parametric_shadow_split = 10.0;
    m.parametric_midtone_split = 55.25; // fractional — widget drags are not integer-quantized
    m.parametric_highlight_split = 90.0;
    let frag = serialize(&m);
    for expected in [
        r#"crs:ParametricShadowSplit="10""#,
        r#"crs:ParametricMidtoneSplit="55.25""#,
        r#"crs:ParametricHighlightSplit="90""#,
    ] {
        assert!(
            frag.contains(expected),
            "missing {expected} in fragment: {frag}"
        );
    }

    let xml = format!(
        r#"<?xml version="1.0"?>
        <x:xmpmeta xmlns:x="adobe:ns:meta/">
          <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
            <rdf:Description xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"{frag}/>
          </rdf:RDF>
        </x:xmpmeta>"#
    );
    let parsed = parse(&xml).unwrap();
    assert_eq!(parsed.parametric_shadow_split, 10.0);
    assert_eq!(parsed.parametric_midtone_split, 55.25);
    assert_eq!(parsed.parametric_highlight_split, 90.0);
}

/// Same wire-codec convention as the region sliders: a value that rounds to
/// its default at 2 decimals is omitted, values round to 2 decimals, and
/// non-finite values never reach the sidecar.
#[test]
fn parametric_split_serialize_rounds_to_wire_codec() {
    let mut m = AdjustmentModel::default();
    m.parametric_shadow_split = 25.004; // rounds to the 25.0 default
    assert!(
        !serialize(&m).contains("Split"),
        "a value that rounds to the default must be omitted, got: {}",
        serialize(&m)
    );

    m.parametric_shadow_split = 33.333_333;
    let frag = serialize(&m);
    assert!(
        frag.contains(r#"crs:ParametricShadowSplit="33.33""#),
        "wire value must round to 2 decimals, got: {frag}"
    );

    m.parametric_shadow_split = f32::NAN;
    assert!(
        !serialize(&m).contains("Split"),
        "non-finite values must not reach the sidecar"
    );
}

// ── Black & white mix (#276) ────────────────────────────────────────────

/// The B&W mode toggle and the eight gray-mixer weights parse from ACR's
/// `crs:` keys, so a Lightroom sidecar's monochrome conversion arrives
/// intact.
#[test]
fn parse_black_white_mix_fields() {
    let xml = r#"<?xml version="1.0"?>
        <x:xmpmeta xmlns:x="adobe:ns:meta/">
          <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
            <rdf:Description xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
              crs:ConvertToGrayscale="True"
              crs:GrayMixerRed="-40"
              crs:GrayMixerOrange="12"
              crs:GrayMixerYellow="25"
              crs:GrayMixerGreen="-8"
              crs:GrayMixerAqua="60"
              crs:GrayMixerBlue="-100"
              crs:GrayMixerPurple="33"
              crs:GrayMixerMagenta="7"/>
          </rdf:RDF>
        </x:xmpmeta>"#;
    let m = parse(xml).expect("parse");
    assert_eq!(m.black_white, BlackWhiteMode::On);
    assert_eq!(m.gray_mixer_red, -40.0);
    assert_eq!(m.gray_mixer_orange, 12.0);
    assert_eq!(m.gray_mixer_yellow, 25.0);
    assert_eq!(m.gray_mixer_green, -8.0);
    assert_eq!(m.gray_mixer_aqua, 60.0);
    assert_eq!(m.gray_mixer_blue, -100.0);
    assert_eq!(m.gray_mixer_purple, 33.0);
    assert_eq!(m.gray_mixer_magenta, 7.0);
}

/// Defaults: colour render, flat mixer. An absent `crs:ConvertToGrayscale`
/// must not be read as monochrome.
#[test]
fn black_white_defaults_to_off() {
    let m = AdjustmentModel::default();
    assert_eq!(m.black_white, BlackWhiteMode::Off);
    assert_eq!(m.gray_mixer_red, 0.0);
    assert_eq!(m.gray_mixer_magenta, 0.0);

    let xml = r#"<?xml version="1.0"?><x><rdf:Description xmlns:rdf="x"/></x>"#;
    assert_eq!(parse(xml).expect("parse").black_white, BlackWhiteMode::Off);
}

/// A sidecar saying something we don't understand about monochrome is an
/// error, not a silent colour render.
#[test]
fn unknown_convert_to_grayscale_is_an_error() {
    let xml = r#"<?xml version="1.0"?><x><rdf:Description xmlns:rdf="x"
        xmlns:crs="x" crs:ConvertToGrayscale="Maybe"/></x>"#;
    assert!(parse(xml).is_err(), "unknown boolean must not parse");
}

/// Round-trip through raw-core's serializer. Unlike the 24 HSL sliders —
/// which this seed serializer has never emitted — the B&W group is written
/// here, because `black_white` is a mode whose loss would silently
/// re-colour a monochrome render.
#[test]
fn black_white_serialize_roundtrip_and_default_omission() {
    let mut m = AdjustmentModel::default();
    assert!(
        !serialize(&m).contains("crs:ConvertToGrayscale")
            && !serialize(&m).contains("crs:GrayMixer"),
        "defaults must not be serialized, got: {}",
        serialize(&m)
    );

    m.black_white = BlackWhiteMode::On;
    m.gray_mixer_red = -40.0;
    m.gray_mixer_blue = 60.0;
    let frag = serialize(&m);
    assert!(
        frag.contains(r#"crs:ConvertToGrayscale="True""#),
        "toggle must be serialized, got: {frag}"
    );

    let xml = format!(
        r#"<?xml version="1.0"?><x><rdf:Description xmlns:rdf="x" xmlns:crs="x"{frag}/></x>"#
    );
    let back = parse(&xml).expect("parse round-trip");
    assert_eq!(back.black_white, BlackWhiteMode::On);
    assert_eq!(back.gray_mixer_red, -40.0);
    assert_eq!(back.gray_mixer_blue, 60.0);
    assert_eq!(back.gray_mixer_green, 0.0);
}

// ── Film emulation (epic #2683, film design 2026-08-06) ────────────────

/// `film_look` / `film_strength` round-trip through raw-core's serializer:
/// defaults stay silent (matching every other `papp:`-only field this seed
/// serializer writes), non-default values reach the sidecar under their
/// `papp:` keys, and both come back unchanged through `parse`.
#[test]
fn film_fields_round_trip_and_stay_silent_at_defaults() {
    let mut m = AdjustmentModel::default();
    assert_eq!(m.film_look, "");
    assert_eq!(m.film_strength, 100.0);
    let silent = serialize(&m);
    assert!(
        !silent.contains("FilmLook") && !silent.contains("FilmStrength"),
        "default film fields must not be serialized, got: {silent}"
    );

    m.film_look = "color_negative_kodak_portra_400".into();
    m.film_strength = 62.0;
    let xml = serialize(&m);
    assert!(
        xml.contains(r#"papp:FilmLook="color_negative_kodak_portra_400""#),
        "missing FilmLook in fragment: {xml}"
    );
    assert!(
        xml.contains(r#"papp:FilmStrength="62""#),
        "missing FilmStrength in fragment: {xml}"
    );

    let doc = format!(
        r#"<?xml version="1.0"?><x><rdf:Description xmlns:rdf="x" xmlns:papp="x"{xml}/></x>"#
    );
    let back = parse(&doc).expect("parse round-trip");
    assert_eq!(back.film_look, m.film_look);
    assert_eq!(back.film_strength, 62.0);
}

/// `film_look` is free-form text, not a closed enum — unlike every other
/// `papp:` field this serializer writes, it must be XML-attribute-escaped
/// so a catalog id containing quote/angle-bracket/ampersand characters
/// doesn't corrupt the surrounding attribute or the document itself. A
/// real catalog id is a plain snake_case token, but the serializer must not
/// assume that.
#[test]
fn film_look_escapes_xml_special_characters_and_round_trips() {
    let mut m = AdjustmentModel::default();
    m.film_look = "weird\"look'<tag>&amp".to_string();
    let frag = serialize(&m);
    assert!(
        !frag.contains("\"weird\"look"),
        "an unescaped quote would terminate the attribute early: {frag}"
    );
    assert!(
        frag.contains("&quot;") && frag.contains("&lt;") && frag.contains("&amp;"),
        "special characters must be escaped, got: {frag}"
    );

    let doc = format!(
        r#"<?xml version="1.0"?><x><rdf:Description xmlns:rdf="x" xmlns:papp="x"{frag}/></x>"#
    );
    let back = parse(&doc).expect("parse round-trip");
    assert_eq!(back.film_look, m.film_look);
}
