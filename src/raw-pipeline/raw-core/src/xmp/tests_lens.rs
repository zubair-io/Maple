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

// -------------------------------------------------------------------------
// Profile-free lateral CA + defringe (#3411)
// -------------------------------------------------------------------------

/// An untouched model matches ACR's own out-of-the-box state: the "Remove
/// Chromatic Aberration" checkbox unticked, both Defringe amounts at zero,
/// and ACR's 30/70 and 40/60 hue bands preloaded.
#[test]
fn defaults_match_acrs_defringe_panel() {
    let m = AdjustmentModel::default();
    assert_eq!(m.auto_lateral_ca, AutoLateralCa::Off);
    assert_eq!(m.defringe_purple_amount, 0.0);
    assert_eq!(m.defringe_purple_hue_lo, 30.0);
    assert_eq!(m.defringe_purple_hue_hi, 70.0);
    assert_eq!(m.defringe_green_amount, 0.0);
    assert_eq!(m.defringe_green_hue_lo, 40.0);
    assert_eq!(m.defringe_green_hue_hi, 60.0);
}

#[test]
fn parse_auto_lateral_ca_accepts_acr_and_boolean_spellings() {
    let parse_flag = |v: &str| {
        parse(&format!(
            r#"<?xml version="1.0"?><x><rdf:Description xmlns:rdf="x" xmlns:crs="x" crs:AutoLateralCA="{v}"/></x>"#
        ))
    };
    for on in ["1", "true", "True", "On"] {
        assert_eq!(
            parse_flag(on).unwrap().auto_lateral_ca,
            AutoLateralCa::On,
            "{on} must parse as On"
        );
    }
    for off in ["0", "false", "False", "Off"] {
        assert_eq!(
            parse_flag(off).unwrap().auto_lateral_ca,
            AutoLateralCa::Off,
            "{off} must parse as Off"
        );
    }
    assert!(parse_flag("Maybe").is_err());
}

#[test]
fn defringe_serialize_roundtrip_and_default_omission() {
    let empty = serialize(&AdjustmentModel::default());
    assert!(
        !empty.contains("crs:Defringe") && !empty.contains("crs:AutoLateralCA"),
        "an untouched defringe panel must not write any attribute, got: {empty}"
    );

    let m = AdjustmentModel {
        auto_lateral_ca: AutoLateralCa::On,
        defringe_purple_amount: 12.0,
        defringe_purple_hue_lo: 25.0,
        defringe_purple_hue_hi: 80.0,
        defringe_green_amount: 7.0,
        defringe_green_hue_lo: 35.0,
        defringe_green_hue_hi: 65.0,
        ..AdjustmentModel::default()
    };
    let frag = serialize(&m);
    for expected in [
        r#"crs:AutoLateralCA="1""#,
        r#"crs:DefringePurpleAmount="12""#,
        r#"crs:DefringePurpleHueLo="25""#,
        r#"crs:DefringePurpleHueHi="80""#,
        r#"crs:DefringeGreenAmount="7""#,
        r#"crs:DefringeGreenHueLo="35""#,
        r#"crs:DefringeGreenHueHi="65""#,
    ] {
        assert!(frag.contains(expected), "missing {expected} in: {frag}");
    }

    let xml = format!(
        r#"<?xml version="1.0"?><x><rdf:Description xmlns:rdf="x" xmlns:crs="x"{frag}/></x>"#
    );
    let parsed = parse(&xml).unwrap();
    assert_eq!(parsed.auto_lateral_ca, AutoLateralCa::On);
    assert_eq!(parsed.defringe_purple_amount, 12.0);
    assert_eq!(parsed.defringe_purple_hue_lo, 25.0);
    assert_eq!(parsed.defringe_purple_hue_hi, 80.0);
    assert_eq!(parsed.defringe_green_amount, 7.0);
    assert_eq!(parsed.defringe_green_hue_lo, 35.0);
    assert_eq!(parsed.defringe_green_hue_hi, 65.0);
}

/// A partially-authored panel writes only what moved: a purple amount with
/// ACR's default band emits the amount alone.
#[test]
fn defringe_omits_hue_bands_left_at_their_defaults() {
    let frag = serialize(&AdjustmentModel {
        defringe_purple_amount: 5.0,
        ..AdjustmentModel::default()
    });
    assert!(
        frag.contains(r#"crs:DefringePurpleAmount="5""#),
        "got: {frag}"
    );
    assert!(!frag.contains("crs:DefringePurpleHue"), "got: {frag}");
    assert!(!frag.contains("crs:DefringeGreen"), "got: {frag}");
}
