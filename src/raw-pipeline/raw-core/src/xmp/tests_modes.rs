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
/// production code. Kept verbatim so load semantics (`None` when the
/// gitignored fixture tree is absent) match `tests.rs`.
fn load_fixture(rel: &str) -> Option<String> {
    let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../test-fixtures/references")
        .join(rel);
    std::fs::read_to_string(path).ok()
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
fn parse_sharpen_amount_max() {
    let xml = match load_fixture("test_0002/xmp/sharpen_amount_max.xmp") {
        Some(x) => x, None => return,
    };
    let m = parse(&xml).unwrap();
    assert!(m.sharpen_amount >= 100.0, "sharpen_amount = {}", m.sharpen_amount);
}

#[test]
fn parse_sharpen_radius_max() {
    let xml = match load_fixture("test_0002/xmp/sharpen_radius_max.xmp") {
        Some(x) => x, None => return,
    };
    let m = parse(&xml).unwrap();
    assert!(m.sharpen_radius >= 2.9, "sharpen_radius = {}", m.sharpen_radius);
}

#[test]
fn parse_sharpen_detail_min() {
    let xml = match load_fixture("test_0002/xmp/sharpen_detail_min.xmp") {
        Some(x) => x, None => return,
    };
    let m = parse(&xml).unwrap();
    assert!(m.sharpen_detail <= 0.5);
}

#[test]
fn parse_sharpen_masking_max() {
    let xml = match load_fixture("test_0002/xmp/sharpen_masking_max.xmp") {
        Some(x) => x, None => return,
    };
    let m = parse(&xml).unwrap();
    assert_eq!(m.sharpen_masking, 100.0);
}

#[test]
fn parse_nr_luminance_max() {
    let xml = match load_fixture("test_0002/xmp/nr_luminance_max.xmp") {
        Some(x) => x, None => return,
    };
    let m = parse(&xml).unwrap();
    assert_eq!(m.nr_luminance, 100.0);
}

#[test]
fn parse_nr_color_max() {
    let xml = match load_fixture("test_0002/xmp/nr_color_max.xmp") {
        Some(x) => x, None => return,
    };
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
