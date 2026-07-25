//! XMP parser tests — DNG lens-correction section (#376). Split out of
//! the sibling `tests_modes.rs` to keep both files under the 600-LOC hard
//! cap (CONTRIBUTING.md § File-size budget). Covers `crs:LensProfileEnable`
//! and the three `crs:LensProfile*Scale` strengths.

#![cfg(test)]

use super::*;

// -------------------------------------------------------------------------
// DNG lens corrections (#376)
// -------------------------------------------------------------------------

/// A model with no lens-correction attributes applies the DNG's embedded
/// corrections in full — ACR's behaviour when a profile is present, and a
/// no-op on a RAW that carries no `OpcodeList3`.
#[test]
fn defaults_apply_dng_lens_corrections_at_full_strength() {
    let m = AdjustmentModel::default();
    assert_eq!(m.lens_profile_enable, LensProfileEnable::On);
    assert_eq!(m.lens_correction_distortion, 100.0);
    assert_eq!(m.lens_correction_ca, 100.0);
    assert_eq!(m.lens_correction_vignetting, 100.0);
}

/// ACR writes the master switch as "1"/"0"; we also accept the
/// True/False spelling other XMP writers use for boolean `crs:` markers
/// (`crs:HasCrop` is written that way).
#[test]
fn parse_lens_profile_enable_accepts_acr_and_boolean_spellings() {
    let parse_enable = |v: &str| {
        parse(&format!(
            r#"<?xml version="1.0"?><x><rdf:Description xmlns:rdf="x" xmlns:crs="x" crs:LensProfileEnable="{v}"/></x>"#
        ))
    };
    for on in ["1", "true", "True", "On"] {
        assert_eq!(
            parse_enable(on).unwrap().lens_profile_enable,
            LensProfileEnable::On,
            "{on} must parse as On"
        );
    }
    for off in ["0", "false", "False", "Off"] {
        assert_eq!(
            parse_enable(off).unwrap().lens_profile_enable,
            LensProfileEnable::Off,
            "{off} must parse as Off"
        );
    }
    assert!(parse_enable("Maybe").is_err());
}

#[test]
fn parse_lens_correction_scales() {
    let m = parse(
        r#"<?xml version="1.0"?><x><rdf:Description xmlns:rdf="x" xmlns:crs="x"
            crs:LensProfileDistortionScale="80"
            crs:LensProfileChromaticAberrationScale="0"
            crs:LensProfileVignettingScale="55"/></x>"#,
    )
    .unwrap();
    assert_eq!(m.lens_correction_distortion, 80.0);
    assert_eq!(m.lens_correction_ca, 0.0);
    assert_eq!(m.lens_correction_vignetting, 55.0);
    // Absent attributes keep the full-strength default rather than
    // silently disabling the vendor's correction.
    assert_eq!(m.lens_profile_enable, LensProfileEnable::On);
}

#[test]
fn lens_correction_serialize_roundtrip_and_default_omission() {
    let d = AdjustmentModel::default();
    let empty = serialize(&d);
    assert!(
        !empty.contains("crs:LensProfile"),
        "an untouched lens panel must not write any attribute, got: {empty}"
    );

    let m = AdjustmentModel {
        lens_profile_enable: LensProfileEnable::Off,
        lens_correction_distortion: 80.0,
        lens_correction_ca: 0.0,
        lens_correction_vignetting: 55.0,
        ..AdjustmentModel::default()
    };
    let frag = serialize(&m);
    assert!(frag.contains(r#"crs:LensProfileEnable="0""#), "got: {frag}");
    assert!(
        frag.contains(r#"crs:LensProfileDistortionScale="80""#),
        "got: {frag}"
    );
    assert!(
        frag.contains(r#"crs:LensProfileChromaticAberrationScale="0""#),
        "got: {frag}"
    );
    assert!(
        frag.contains(r#"crs:LensProfileVignettingScale="55""#),
        "got: {frag}"
    );

    let xml = format!(
        r#"<?xml version="1.0"?><x><rdf:Description xmlns:rdf="x" xmlns:crs="x"{frag}/></x>"#
    );
    let parsed = parse(&xml).unwrap();
    assert_eq!(parsed.lens_profile_enable, LensProfileEnable::Off);
    assert_eq!(parsed.lens_correction_distortion, 80.0);
    assert_eq!(parsed.lens_correction_ca, 0.0);
    assert_eq!(parsed.lens_correction_vignetting, 55.0);
}
