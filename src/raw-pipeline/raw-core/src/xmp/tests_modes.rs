//! XMP parser tests — render-mode / look variants section. Extracted from
//! the sibling `tests.rs` in #477 (review-follow-up) to keep both files
//! under the 600-LOC hard cap (per CONTRIBUTING.md). Covers:
//!   * `HighlightRecoveryMode` (tickets #335, #471)
//!   * `DisplayLookCurve` / `Look` (ticket #371)
//!   * `ToneCurveMode` (ticket #436)
//!   * `CaptureSharpening` round-trip (ticket #455)

#![cfg(test)]

use super::*;

/// Duplicate of `tests::load_fixture` — the sibling `mod tests`
/// is a private cousin we can't import without leaking the helper into
/// production code. Kept verbatim so load semantics (panic when the
/// gitignored fixture tree is incomplete, #1082) match `tests.rs`;
/// callers are `#[cfg_attr(not(feature = "fixtures"), ignore)]`.
fn load_fixture(rel: &str) -> String {
    let path = crate::test_support::fixtures::require_reference(rel);
    std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("read fixture {}: {}", path.display(), e))
}

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

#[test]
fn defaults_includes_slice5_detail_fields() {
    // Sharpen defaults match the reference renderer's fresh-import baseline per #326.
    let m = AdjustmentModel::default();
    assert_eq!(m.sharpen_amount, 40.0);
    assert_eq!(m.sharpen_radius, 1.0);
    assert_eq!(m.sharpen_detail, 25.0);
    assert_eq!(m.sharpen_masking, 0.0);
    assert_eq!(m.nr_luminance, 0.0);
    assert_eq!(m.nr_color, 25.0);
}

#[test]
#[cfg_attr(not(feature = "fixtures"), ignore)]
fn parse_sharpen_amount_max() {
    let xml = load_fixture("test_0002/xmp/sharpen_amount_max.xmp");
    let m = parse(&xml).unwrap();
    assert!(
        m.sharpen_amount >= 100.0,
        "sharpen_amount = {}",
        m.sharpen_amount
    );
}

#[test]
#[cfg_attr(not(feature = "fixtures"), ignore)]
fn parse_sharpen_radius_max() {
    let xml = load_fixture("test_0002/xmp/sharpen_radius_max.xmp");
    let m = parse(&xml).unwrap();
    assert!(
        m.sharpen_radius >= 2.9,
        "sharpen_radius = {}",
        m.sharpen_radius
    );
}

#[test]
#[cfg_attr(not(feature = "fixtures"), ignore)]
fn parse_sharpen_detail_min() {
    let xml = load_fixture("test_0002/xmp/sharpen_detail_min.xmp");
    let m = parse(&xml).unwrap();
    assert!(m.sharpen_detail <= 0.5);
}

#[test]
#[cfg_attr(not(feature = "fixtures"), ignore)]
fn parse_sharpen_masking_max() {
    let xml = load_fixture("test_0002/xmp/sharpen_masking_max.xmp");
    let m = parse(&xml).unwrap();
    assert_eq!(m.sharpen_masking, 100.0);
}

#[test]
#[cfg_attr(not(feature = "fixtures"), ignore)]
fn parse_nr_luminance_max() {
    let xml = load_fixture("test_0002/xmp/nr_luminance_max.xmp");
    let m = parse(&xml).unwrap();
    assert_eq!(m.nr_luminance, 100.0);
}

#[test]
#[cfg_attr(not(feature = "fixtures"), ignore)]
fn parse_nr_color_max() {
    let xml = load_fixture("test_0002/xmp/nr_color_max.xmp");
    let m = parse(&xml).unwrap();
    assert_eq!(m.nr_color, 100.0);
}

#[test]
#[allow(deprecated)]
fn defaults_capture_sharpening_is_off() {
    let m = AdjustmentModel::default();
    assert_eq!(m.capture_sharpening_amount, 0.0);
    assert_eq!(m.capture_sharpening_sigma, 1.0);
    // Deprecated alias keeps the same default so existing struct-literal
    // callers (built before #456) still produce an equivalent model.
    assert_eq!(m.capture_sharpening_radius, 1.0);
}

#[test]
fn default_local_adjustments_is_empty() {
    let m = AdjustmentModel::default();
    assert!(m.local_adjustments.is_empty());
}

#[test]
fn parse_local_adjustments_linear_round_trips() {
    use crate::types::local_adjustment::{
        encode_local_adjustments, LocalAdjustment, Mask, PartialAdjustments, Point2,
    };
    let layers = vec![LocalAdjustment {
        mask: Mask::Linear {
            start: Point2::new(0.0, 0.5),
            end: Point2::new(1.0, 0.5),
            feather: 0.5,
        },
        adjustments: PartialAdjustments {
            exposure: Some(1.0),
            ..Default::default()
        },
    }];
    let attr = encode_local_adjustments(&layers);
    // The attribute embeds JSON containing double-quotes; escape them
    // for the XML literal here.
    let escaped = attr.replace('"', "&quot;");
    let xml = format!(
        r#"<?xml version="1.0"?><x><rdf:Description xmlns:rdf="x" xmlns:papp="x"
            papp:LocalAdjustments="{escaped}"/></x>"#
    );
    let m = parse(&xml).expect("parse");
    assert_eq!(m.local_adjustments, layers);
}

#[test]
fn parse_local_adjustments_malformed_errors() {
    let xml = r#"<?xml version="1.0"?><x><rdf:Description xmlns:rdf="x" xmlns:papp="x"
        papp:LocalAdjustments="{not json}"/></x>"#;
    assert!(parse(xml).is_err());
}

// -----------------------------------------------------------------
// Inpaint removals (ticket #1486).
// -----------------------------------------------------------------

#[test]
fn default_inpaint_removals_is_empty() {
    let m = AdjustmentModel::default();
    assert!(m.inpaint_removals.is_empty());
}

#[test]
fn parse_inpaint_removals_round_trips() {
    use crate::types::inpaint::{encode_removals, BakeGrade, Removal};
    let removals = vec![Removal {
        region: [0.25, 0.1, 0.5, 0.4],
        patch_ref: "blake3:deadbeef".to_string(),
        model_version: "lama-bigl-1".to_string(),
        bake: BakeGrade {
            temperature: 5500.0,
            tint: 4.0,
            exposure: 0.3,
        },
    }];
    let attr = encode_removals(&removals);
    let escaped = attr.replace('"', "&quot;");
    let xml = format!(
        r#"<?xml version="1.0"?><x><rdf:Description xmlns:rdf="x" xmlns:papp="x"
            papp:InpaintRemovals="{escaped}"/></x>"#
    );
    let m = parse(&xml).expect("parse");
    assert_eq!(m.inpaint_removals, removals);
}

#[test]
fn parse_inpaint_removals_malformed_errors() {
    let xml = r#"<?xml version="1.0"?><x><rdf:Description xmlns:rdf="x" xmlns:papp="x"
        papp:InpaintRemovals="{not json}"/></x>"#;
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

#[test]
fn parse_capture_sharpening_attributes_legacy_radius() {
    // #456: legacy sidecars carry only `papp:CaptureSharpeningRadius` —
    // PR #452 silently changed the semantic from integer radius to float
    // Gaussian sigma. The parser must route the legacy attribute into the
    // new `capture_sharpening_sigma` field unchanged (no rescale), because
    // no shipping sidecar carries a non-zero amount and rescaling would
    // be a guess.
    let xml = r#"<?xml version="1.0"?><x><rdf:Description xmlns:rdf="x" xmlns:papp="x"
        papp:CaptureSharpeningAmount="65" papp:CaptureSharpeningRadius="2.5"/></x>"#;
    let m = parse(xml).unwrap();
    assert_eq!(m.capture_sharpening_amount, 65.0);
    assert!(
        (m.capture_sharpening_sigma - 2.5).abs() < 1e-6,
        "legacy radius=2.5 must land in sigma unchanged, got {}",
        m.capture_sharpening_sigma
    );
}

#[test]
fn parse_capture_sharpening_sigma_new_key() {
    // #456: new sidecars carry `papp:CaptureSharpeningSigma`. It writes to
    // the canonical `capture_sharpening_sigma` field directly.
    let xml = r#"<?xml version="1.0"?><x><rdf:Description xmlns:rdf="x" xmlns:papp="x"
        papp:CaptureSharpeningAmount="65" papp:CaptureSharpeningSigma="1.5"/></x>"#;
    let m = parse(xml).unwrap();
    assert_eq!(m.capture_sharpening_amount, 65.0);
    assert!((m.capture_sharpening_sigma - 1.5).abs() < 1e-6);
}

#[test]
fn parse_capture_sharpening_sigma_wins_over_radius() {
    // Both attributes present: `Sigma` always wins, regardless of document
    // order. The parser tracks a `sigma_seen` flag so it can route
    // `Radius` to `sigma` only when `Sigma` has not yet been seen — and
    // any later `Sigma` overrides anything `Radius` wrote earlier.
    let xml_sigma_first = r#"<?xml version="1.0"?><x><rdf:Description xmlns:rdf="x" xmlns:papp="x"
        papp:CaptureSharpeningSigma="0.8" papp:CaptureSharpeningRadius="2.0"/></x>"#;
    let m = parse(xml_sigma_first).unwrap();
    assert!(
        (m.capture_sharpening_sigma - 0.8).abs() < 1e-6,
        "Sigma must win when it appears first, got {}",
        m.capture_sharpening_sigma
    );

    let xml_radius_first = r#"<?xml version="1.0"?><x><rdf:Description xmlns:rdf="x" xmlns:papp="x"
        papp:CaptureSharpeningRadius="2.0" papp:CaptureSharpeningSigma="0.8"/></x>"#;
    let m = parse(xml_radius_first).unwrap();
    assert!(
        (m.capture_sharpening_sigma - 0.8).abs() < 1e-6,
        "Sigma must win when it appears second, got {}",
        m.capture_sharpening_sigma
    );
}

#[test]
fn parse_capture_sharpening_sigma_seen_does_not_leak_across_elements() {
    // PR #463 review: `sigma_seen` must not leak across elements. Two
    // `rdf:Description`s — the first carries only `Sigma`, the second only
    // `Radius`. Because each element has its own attribute set, the second
    // Description's `Radius` has no Sigma to defer to and must write to
    // `capture_sharpening_sigma` (last writer wins, which is the codebase's
    // accumulation contract for multi-Description sidecars).
    //
    // Bug behavior before the fix: a single stream-scoped `sigma_seen` flag
    // remembered the first Description's `Sigma` and silently dropped the
    // second's `Radius`.
    let xml = r#"<?xml version="1.0"?><x xmlns:rdf="x" xmlns:papp="x">
        <rdf:Description papp:CaptureSharpeningSigma="0.8"/>
        <rdf:Description papp:CaptureSharpeningRadius="2.0"/>
    </x>"#;
    let m = parse(xml).unwrap();
    assert!(
        (m.capture_sharpening_sigma - 2.0).abs() < 1e-6,
        "second Description's Radius must apply (its own attribute set has \
         no Sigma); got capture_sharpening_sigma = {}",
        m.capture_sharpening_sigma
    );
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

// Profile (Auto / Neutral). Auto Profile Phase 1 (#536): the new
// `papp:Profile` attribute selects the view-transform branch.
// Default is `Auto`; legacy `papp:Look` ("Default" / "Neutral") migrates
// in via the parser when `papp:Profile` is absent. The serializer (a
// minimal seed living in `crate::xmp::serialize`) only emits attributes
// that differ from defaults.

#[test]
fn papp_profile_auto_parses_to_profile_auto() {
    let xmp = r#"<x:xmpmeta xmlns:x="adobe:ns:meta/" xmlns:papp="http://ns.justmaple.app/papp/1.0/">
        <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
            <rdf:Description papp:Profile="Auto"/>
        </rdf:RDF>
    </x:xmpmeta>"#;
    let model = crate::xmp::parse(xmp).expect("parses");
    assert_eq!(model.profile, crate::types::adjustment::Profile::Auto);
}

#[test]
fn papp_profile_neutral_parses_to_profile_neutral() {
    let xmp = r#"<x:xmpmeta xmlns:x="adobe:ns:meta/" xmlns:papp="http://ns.justmaple.app/papp/1.0/">
        <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
            <rdf:Description papp:Profile="Neutral"/>
        </rdf:RDF>
    </x:xmpmeta>"#;
    let model = crate::xmp::parse(xmp).expect("parses");
    assert_eq!(model.profile, crate::types::adjustment::Profile::Neutral);
}

#[test]
fn legacy_papp_look_default_migrates_to_profile_auto() {
    let xmp = r#"<x:xmpmeta xmlns:x="adobe:ns:meta/" xmlns:papp="http://ns.justmaple.app/papp/1.0/">
        <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
            <rdf:Description papp:Look="Default"/>
        </rdf:RDF>
    </x:xmpmeta>"#;
    let model = crate::xmp::parse(xmp).expect("parses");
    assert_eq!(model.profile, crate::types::adjustment::Profile::Auto);
}

#[test]
fn legacy_papp_look_neutral_migrates_to_profile_neutral() {
    let xmp = r#"<x:xmpmeta xmlns:x="adobe:ns:meta/" xmlns:papp="http://ns.justmaple.app/papp/1.0/">
        <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
            <rdf:Description papp:Look="Neutral"/>
        </rdf:RDF>
    </x:xmpmeta>"#;
    let model = crate::xmp::parse(xmp).expect("parses");
    assert_eq!(model.profile, crate::types::adjustment::Profile::Neutral);
}

#[test]
fn profile_auto_is_default_and_omitted_from_serialized_output() {
    let mut model = crate::types::adjustment::AdjustmentModel::default();
    assert_eq!(model.profile, crate::types::adjustment::Profile::Auto);
    let xmp = crate::xmp::serialize(&model);
    assert!(
        !xmp.contains("papp:Profile"),
        "default Auto should not serialize"
    );
    model.profile = crate::types::adjustment::Profile::Neutral;
    let xmp = crate::xmp::serialize(&model);
    assert!(
        xmp.contains(r#"papp:Profile="Neutral""#),
        "Neutral must serialize, got:\n{xmp}"
    );
}

#[test]
fn papp_profile_wins_over_legacy_papp_look() {
    let xmp = r#"<x:xmpmeta xmlns:x="adobe:ns:meta/" xmlns:papp="http://ns.justmaple.app/papp/1.0/">
        <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
            <rdf:Description papp:Look="Neutral" papp:Profile="Auto"/>
        </rdf:RDF>
    </x:xmpmeta>"#;
    let model = crate::xmp::parse(xmp).expect("parses");
    assert_eq!(model.profile, crate::types::adjustment::Profile::Auto);
}

// ---- Hot/dead-pixel suppression (#1106) ----

/// `papp:HotPixelSuppression="On"` parses onto the model; absent
/// attribute leaves the default `Off` (bit-identical decode), and the
/// serializer omits the attribute at the default so pre-#1106 sidecars
/// stay byte-identical. Non-default round-trips serialize → parse.
#[test]
fn parse_hot_pixel_suppression_on() {
    let xml = r#"<?xml version="1.0"?><x><rdf:Description xmlns:rdf="x" xmlns:papp="x"
        papp:HotPixelSuppression="On"/></x>"#;
    let m = parse(xml).unwrap();
    assert_eq!(m.hot_pixel_suppression, HotPixelSuppressionMode::On);
}

#[test]
fn parse_hot_pixel_suppression_off_explicit_and_lowercase() {
    let xml = r#"<?xml version="1.0"?><x><rdf:Description xmlns:rdf="x" xmlns:papp="x"
        papp:HotPixelSuppression="off"/></x>"#;
    let m = parse(xml).unwrap();
    assert_eq!(m.hot_pixel_suppression, HotPixelSuppressionMode::Off);
    let xml = r#"<?xml version="1.0"?><x><rdf:Description xmlns:rdf="x" xmlns:papp="x"
        papp:HotPixelSuppression="on"/></x>"#;
    let m = parse(xml).unwrap();
    assert_eq!(m.hot_pixel_suppression, HotPixelSuppressionMode::On);
}

#[test]
fn parse_hot_pixel_suppression_absent_defaults_to_off() {
    let xml = r#"<?xml version="1.0"?><x><rdf:Description xmlns:rdf="x" xmlns:crs="x"
        crs:Exposure2012="1.0"/></x>"#;
    let m = parse(xml).unwrap();
    assert_eq!(m.hot_pixel_suppression, HotPixelSuppressionMode::Off);
}

#[test]
fn parse_hot_pixel_suppression_invalid_is_error() {
    let xml = r#"<?xml version="1.0"?><x><rdf:Description xmlns:rdf="x" xmlns:papp="x"
        papp:HotPixelSuppression="Maybe"/></x>"#;
    assert!(parse(xml).is_err());
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
