//! XMP parser tests — render-mode / look variants section. Extracted from
//! the sibling `tests.rs` in #477 (review-follow-up) to keep both files
//! under the 600-LOC hard cap (per CONTRIBUTING.md). Covers:
//!   * `HighlightRecoveryMode` (tickets #335, #471)
//!   * `DisplayLookCurve` / `Look` (ticket #371)
//!   * `ToneCurveMode` (ticket #436)
//!   * `AutoExposureMode` (ticket #429)
//!   * `HotPixelSuppressionMode` (ticket #1106)
//!
//! Subjects that moved out again for the same budget reason: the
//! Detail-panel scalars and `CaptureSharpening` live in `tests_detail.rs`
//! and the JSON-payload attributes in `tests_payloads.rs` (both #376);
//! `papp:Profile` and the legacy `papp:Look` migration (ticket #536) live
//! in `tests_profile.rs` (#2312).

#![cfg(test)]

use super::*;

#[test]
fn defaults_highlight_recovery_is_chromatic_adaptation() {
    // #335 flipped the default to `ChromaticAdaptation` after re-measuring
    // the parity harness: per-case Off-vs-CA diff shows the algorithm is
    // a near-noop on baseline fixtures (ΔΔE ≤ 0.001). Users can opt out
    // per-image via `papp:HighlightRecoveryMode="Off"` in the XMP sidecar.
    let m = AdjustmentModel::default();
    assert_eq!(
        m.highlight_recovery,
        HighlightRecoveryMode::ChromaticAdaptation
    );
}

#[test]
fn parse_highlight_recovery_chromatic_adaptation() {
    let xml = r#"<?xml version="1.0"?><x><rdf:Description xmlns:rdf="x" xmlns:papp="x"
        papp:HighlightRecoveryMode="ChromaticAdaptation"/></x>"#;
    let m = parse(xml).unwrap();
    assert_eq!(
        m.highlight_recovery,
        HighlightRecoveryMode::ChromaticAdaptation
    );
}

#[test]
fn parse_highlight_recovery_blend() {
    let xml = r#"<?xml version="1.0"?><x><rdf:Description xmlns:rdf="x" xmlns:papp="x"
        papp:HighlightRecoveryMode="blend"/></x>"#;
    let m = parse(xml).unwrap();
    assert_eq!(m.highlight_recovery, HighlightRecoveryMode::Blend);
}

#[test]
fn parse_highlight_recovery_luminance() {
    let xml = r#"<?xml version="1.0"?><x><rdf:Description xmlns:rdf="x" xmlns:papp="x"
        papp:HighlightRecoveryMode="Luminance"/></x>"#;
    let m = parse(xml).unwrap();
    assert_eq!(m.highlight_recovery, HighlightRecoveryMode::Luminance);
}

#[test]
fn parse_highlight_recovery_off_explicit() {
    let xml = r#"<?xml version="1.0"?><x><rdf:Description xmlns:rdf="x" xmlns:papp="x"
        papp:HighlightRecoveryMode="off"/></x>"#;
    let m = parse(xml).unwrap();
    assert_eq!(m.highlight_recovery, HighlightRecoveryMode::Off);
}

#[test]
fn parse_highlight_recovery_invalid_is_error() {
    let xml = r#"<?xml version="1.0"?><x><rdf:Description xmlns:rdf="x" xmlns:papp="x"
        papp:HighlightRecoveryMode="typo"/></x>"#;
    assert!(parse(xml).is_err());
}

#[test]
fn parses_papp_highlight_recovery_mode_oklab_chroma_reduction() {
    // Ticket #471: post-DCP Oklab chroma reduction is an opt-in variant.
    // Verify the XMP parser accepts both the canonical PascalCase token and
    // its lowercase alias, matching the convention used for the other
    // variants above.
    let xml = r#"<?xml version="1.0"?><x><rdf:Description xmlns:rdf="x" xmlns:papp="x"
        papp:HighlightRecoveryMode="OklabChromaReduction"/></x>"#;
    let m = parse(xml).unwrap();
    assert_eq!(
        m.highlight_recovery,
        HighlightRecoveryMode::OklabChromaReduction
    );

    let xml_lower = r#"<?xml version="1.0"?><x><rdf:Description xmlns:rdf="x" xmlns:papp="x"
        papp:HighlightRecoveryMode="oklabchromareduction"/></x>"#;
    let m = parse(xml_lower).unwrap();
    assert_eq!(
        m.highlight_recovery,
        HighlightRecoveryMode::OklabChromaReduction
    );
}

// -----------------------------------------------------------------
// DisplayLookCurve (ticket #371).
// -----------------------------------------------------------------

#[test]
fn defaults_look_is_default() {
    // Per #371: new users get the empirical Look, not Neutral. This
    // mirrors the assertion in `types::adjustment::tests` — duplicated
    // here so the XMP module's defaults invariant is self-contained.
    let m = AdjustmentModel::default();
    assert_eq!(m.look, Look::Default);
}

#[test]
fn parse_look_neutral() {
    let xml = r#"<?xml version="1.0"?><x><rdf:Description xmlns:rdf="x" xmlns:papp="x"
        papp:Look="Neutral"/></x>"#;
    let m = parse(xml).unwrap();
    assert_eq!(m.look, Look::Neutral);
}

#[test]
fn parse_look_default_explicit() {
    let xml = r#"<?xml version="1.0"?><x><rdf:Description xmlns:rdf="x" xmlns:papp="x"
        papp:Look="Default"/></x>"#;
    let m = parse(xml).unwrap();
    assert_eq!(m.look, Look::Default);
}

#[test]
fn parse_look_lowercase() {
    // Case-insensitive parse mirrors the HighlightRecoveryMode pattern
    // so sidecars produced by either capitalization round-trip cleanly.
    let xml = r#"<?xml version="1.0"?><x><rdf:Description xmlns:rdf="x" xmlns:papp="x"
        papp:Look="neutral"/></x>"#;
    let m = parse(xml).unwrap();
    assert_eq!(m.look, Look::Neutral);
}

#[test]
fn parse_look_absent_defaults_to_default() {
    // Existing sidecars produced before #371 don't carry `papp:Look` —
    // they must pick up the empirical Look automatically (the "default
    // for new users" criterion in the ticket). Verifies the parser
    // does NOT reset `look` to Neutral when the attribute is missing.
    let xml = r#"<?xml version="1.0"?><x><rdf:Description xmlns:rdf="x" xmlns:papp="x"
        papp:HighlightRecoveryMode="Off"/></x>"#;
    let m = parse(xml).unwrap();
    assert_eq!(m.look, Look::Default);
}

#[test]
fn parse_look_invalid_is_error() {
    let xml = r#"<?xml version="1.0"?><x><rdf:Description xmlns:rdf="x" xmlns:papp="x"
        papp:Look="Vivid"/></x>"#;
    assert!(parse(xml).is_err());
}

// -----------------------------------------------------------------
// ToneCurveMode (ticket #436).
// -----------------------------------------------------------------

#[test]
fn defaults_tone_curve_mode_is_per_channel() {
    // Per #436: `PerChannel` is the pre-existing behavior. Absent
    // attribute on existing sidecars must keep the current pipeline
    // output bit-identical.
    let m = AdjustmentModel::default();
    assert_eq!(m.tone_curve_mode, ToneCurveMode::PerChannel);
}

#[test]
fn parse_tone_curve_mode_ratio_preserving() {
    let xml = r#"<?xml version="1.0"?><x><rdf:Description xmlns:rdf="x" xmlns:papp="x"
        papp:ToneCurveMode="RatioPreserving"/></x>"#;
    let m = parse(xml).unwrap();
    assert_eq!(m.tone_curve_mode, ToneCurveMode::RatioPreserving);
}

#[test]
fn parse_tone_curve_mode_per_channel_explicit() {
    let xml = r#"<?xml version="1.0"?><x><rdf:Description xmlns:rdf="x" xmlns:papp="x"
        papp:ToneCurveMode="PerChannel"/></x>"#;
    let m = parse(xml).unwrap();
    assert_eq!(m.tone_curve_mode, ToneCurveMode::PerChannel);
}

#[test]
fn parse_tone_curve_mode_lowercase() {
    // Case-insensitive mirror of the `papp:Look` /
    // `papp:HighlightRecoveryMode` patterns.
    let xml = r#"<?xml version="1.0"?><x><rdf:Description xmlns:rdf="x" xmlns:papp="x"
        papp:ToneCurveMode="ratiopreserving"/></x>"#;
    let m = parse(xml).unwrap();
    assert_eq!(m.tone_curve_mode, ToneCurveMode::RatioPreserving);
}

#[test]
fn parse_tone_curve_mode_absent_defaults_to_per_channel() {
    // Existing sidecars produced before #436 don't carry
    // `papp:ToneCurveMode`. They must read back as `PerChannel` so the
    // pipeline output is bit-identical to the pre-#436 baseline.
    let xml = r#"<?xml version="1.0"?><x><rdf:Description xmlns:rdf="x" xmlns:crs="x"
        crs:Exposure2012="1.5"/></x>"#;
    let m = parse(xml).unwrap();
    assert_eq!(m.tone_curve_mode, ToneCurveMode::PerChannel);
}

#[test]
fn parse_tone_curve_mode_invalid_is_error() {
    let xml = r#"<?xml version="1.0"?><x><rdf:Description xmlns:rdf="x" xmlns:papp="x"
        papp:ToneCurveMode="Hue"/></x>"#;
    assert!(parse(xml).is_err());
}

// AutoExposure (ticket #429). Sidecars predating the PR have no
// `papp:AutoExposure` and must pick up `On` automatically.
#[test]
fn parse_auto_exposure_modes() {
    fn mode(v: &str) -> AutoExposureMode {
        let x = format!(
            r#"<?xml version="1.0"?><x><rdf:Description xmlns:rdf="x" xmlns:papp="x" papp:AutoExposure="{v}"/></x>"#
        );
        parse(&x).unwrap().auto_exposure
    }
    assert_eq!(mode("Off"), AutoExposureMode::Off);
    assert_eq!(mode("on"), AutoExposureMode::On);
    let absent = r#"<?xml version="1.0"?><x><rdf:Description xmlns:rdf="x" xmlns:crs="x" crs:Exposure2012="0.5"/></x>"#;
    assert_eq!(parse(absent).unwrap().auto_exposure, AutoExposureMode::On);
    let bad = r#"<?xml version="1.0"?><x><rdf:Description xmlns:rdf="x" xmlns:papp="x" papp:AutoExposure="auto"/></x>"#;
    assert!(parse(bad).is_err());
}

// ---- Hot/dead-pixel suppression (#1106) ----

/// `papp:HotPixelSuppression="On"` parses onto the model; absent
/// attribute leaves the default `Off` (bit-identical decode), and the
/// serializer omits the attribute at the default so pre-#1106 sidecars
/// stay byte-identical. Non-default round-trips serialize → parse.
#[test]
fn parse_hot_pixel_suppression_modes() {
    let m = parse(r#"<?xml version="1.0"?><x><rdf:Description xmlns:rdf="x" xmlns:papp="x" papp:HotPixelSuppression="On"/></x>"#).unwrap();
    assert_eq!(m.hot_pixel_suppression, HotPixelSuppressionMode::On);

    let m = parse(r#"<?xml version="1.0"?><x><rdf:Description xmlns:rdf="x" xmlns:papp="x" papp:HotPixelSuppression="off"/></x>"#).unwrap();
    assert_eq!(m.hot_pixel_suppression, HotPixelSuppressionMode::Off);

    let m = parse(r#"<?xml version="1.0"?><x><rdf:Description xmlns:rdf="x" xmlns:papp="x" papp:HotPixelSuppression="on"/></x>"#).unwrap();
    assert_eq!(m.hot_pixel_suppression, HotPixelSuppressionMode::On);

    let m = parse(r#"<?xml version="1.0"?><x><rdf:Description xmlns:rdf="x" xmlns:crs="x" crs:Exposure2012="1.0"/></x>"#).unwrap();
    assert_eq!(m.hot_pixel_suppression, HotPixelSuppressionMode::Off);

    assert!(parse(r#"<?xml version="1.0"?><x><rdf:Description xmlns:rdf="x" xmlns:papp="x" papp:HotPixelSuppression="Maybe"/></x>"#).is_err());
}

#[test]
fn hot_pixel_suppression_serialize_roundtrip_and_default_omission() {
    let mut m = AdjustmentModel::default();
    assert!(
        !serialize(&m).contains("papp:HotPixelSuppression"),
        "default Off must not be serialized"
    );
    m.hot_pixel_suppression = HotPixelSuppressionMode::On;
    let frag = serialize(&m);
    assert!(
        frag.contains(r#"papp:HotPixelSuppression="On""#),
        "got: {frag}"
    );
    let xml = format!(
        r#"<?xml version="1.0"?><x><rdf:Description xmlns:rdf="x" xmlns:papp="x"{frag}/></x>"#
    );
    let parsed = parse(&xml).unwrap();
    assert_eq!(parsed.hot_pixel_suppression, HotPixelSuppressionMode::On);
}
