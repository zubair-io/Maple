//! XMP parser tests — Detail panel section. Split out of the sibling
//! `tests_modes.rs` (#376) to keep both files under the 600-LOC hard cap
//! (CONTRIBUTING.md § File-size budget). Covers the sharpening / noise
//! reduction scalars (#326) and the `CaptureSharpening` legacy-radius →
//! sigma migration (#455, #456, #463).

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
