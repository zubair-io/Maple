//! XMP parser tests — `papp:Profile` section. Extracted from the sibling
//! `tests_modes.rs` in #2312, which the retired-`AcrMatch` migration tests
//! pushed past the 600-LOC hard cap (per CONTRIBUTING.md) — the same split
//! `tests_modes.rs` itself came from in #477. Covers:
//!   * `Profile` parse / serialize (Auto Profile Phase 1, ticket #536)
//!   * legacy `papp:Look` → `Profile` migration (ticket #536)
//!   * retired `papp:Profile="AcrMatch"` → `Auto` migration (#1722, #2312)

#![cfg(test)]

// Profile (Auto / Neutral). Auto Profile Phase 1 (#536): the new
// `papp:Profile` attribute selects the view-transform branch.
// Default is `Auto`; legacy `papp:Look` ("Default" / "Neutral") migrates
// in via the parser when `papp:Profile` is absent. The serializer (a
// minimal seed living in `crate::xmp::serialize`) always writes the profile
// so the saved intent is explicit, including Auto (#2441).

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
fn profile_auto_is_default_and_explicit_in_serialized_output() {
    let mut model = crate::types::adjustment::AdjustmentModel::default();
    assert_eq!(model.profile, crate::types::adjustment::Profile::Auto);
    let xmp = crate::xmp::serialize(&model);
    assert!(
        xmp.contains(r#"papp:Profile="Auto""#),
        "default Auto must serialize explicitly"
    );
    model.profile = crate::types::adjustment::Profile::Neutral;
    let xmp = crate::xmp::serialize(&model);
    assert!(
        xmp.contains(r#"papp:Profile="Neutral""#),
        "Neutral must serialize, got:\n{xmp}"
    );
}

#[test]
fn legacy_profile_intent_is_explicit_and_stable_after_resaving() {
    for (attrs, expected) in [
        ("", "Auto"),
        (r#"papp:Look="Default""#, "Auto"),
        (r#"papp:Look="Neutral""#, "Neutral"),
        (r#"papp:Profile="AcrMatch""#, "Auto"),
    ] {
        let document = |attrs: &str| format!("<rdf:Description {attrs}/>");
        let model = crate::xmp::parse(&document(attrs)).expect("legacy sidecar");
        let saved = crate::xmp::serialize(&model);
        assert!(saved.contains(&format!("papp:Profile=\"{expected}\"")));
        let reopened = crate::xmp::parse(&document(&saved)).expect("saved sidecar");
        assert_eq!(model.profile, reopened.profile);
        assert_eq!(saved, crate::xmp::serialize(&reopened));
    }
}

/// Legacy `papp:Profile="AcrMatch"` (#1722, retired in #2312) migrates to
/// `Auto` — the profile that superseded it. Sidecars carrying the retired
/// value were produced by `maple-cli --profile acr-match` and by hand, so
/// they must keep parsing rather than failing the whole sidecar.
#[test]
fn legacy_papp_profile_acr_match_migrates_to_profile_auto() {
    let xmp = r#"<x:xmpmeta xmlns:x="adobe:ns:meta/" xmlns:papp="http://ns.justmaple.app/papp/1.0/">
        <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
            <rdf:Description papp:Profile="AcrMatch"/>
        </rdf:RDF>
    </x:xmpmeta>"#;
    let model = crate::xmp::parse(xmp).expect("legacy AcrMatch sidecar must still parse");
    assert_eq!(model.profile, crate::types::adjustment::Profile::Auto);
}

/// The `AcrMatch` migration arm is specific, not a catch-all: a genuinely
/// unknown `papp:Profile` value still fails the parse, so a typo or a
/// newer-schema value is never silently swallowed as `Auto`.
#[test]
fn unknown_papp_profile_value_still_errors() {
    let xmp = r#"<x:xmpmeta xmlns:x="adobe:ns:meta/" xmlns:papp="http://ns.justmaple.app/papp/1.0/">
        <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
            <rdf:Description papp:Profile="WarpDrive"/>
        </rdf:RDF>
    </x:xmpmeta>"#;
    assert!(crate::xmp::parse(xmp).is_err());
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
