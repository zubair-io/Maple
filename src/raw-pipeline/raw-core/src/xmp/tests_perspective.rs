//! XMP tests — manual geometry (#3410). Adobe's `crs:Perspective*` seven,
//! in their own file for the same 600-LOC reason as the sibling
//! `tests_lens.rs` (CONTRIBUTING.md § File-size budget).

#![cfg(test)]

use super::*;

/// The acceptance criterion from the ticket, in the smallest form that can
/// fail: a Lightroom-authored sidecar carrying nothing but a vertical
/// keystone loads that keystone, unrescaled, and leaves the other six alone.
#[test]
fn a_lightroom_vertical_keystone_loads_at_the_authored_value() {
    let m = parse(
        r#"<?xml version="1.0"?><x><rdf:Description xmlns:rdf="x" xmlns:crs="x"
            crs:PerspectiveVertical="-20"/></x>"#,
    )
    .expect("parses");
    assert_eq!(m.perspective_vertical, -20.0);
    assert_eq!(m.perspective_horizontal, 0.0);
    assert_eq!(m.perspective_scale, 100.0);
}

#[test]
fn all_seven_keys_parse_into_their_own_fields() {
    let m = parse(
        r#"<?xml version="1.0"?><x><rdf:Description xmlns:rdf="x" xmlns:crs="x"
            crs:PerspectiveVertical="-20"
            crs:PerspectiveHorizontal="12.5"
            crs:PerspectiveRotate="-3.5"
            crs:PerspectiveScale="110"
            crs:PerspectiveAspect="-35"
            crs:PerspectiveX="8"
            crs:PerspectiveY="-6"/></x>"#,
    )
    .expect("parses");
    assert_eq!(m.perspective_vertical, -20.0);
    assert_eq!(m.perspective_horizontal, 12.5);
    assert_eq!(m.perspective_rotate, -3.5);
    assert_eq!(m.perspective_scale, 110.0);
    assert_eq!(m.perspective_aspect, -35.0);
    assert_eq!(m.perspective_x, 8.0);
    assert_eq!(m.perspective_y, -6.0);
}

#[test]
fn a_sidecar_without_the_keys_leaves_geometry_neutral() {
    let m = AdjustmentModel::default();
    assert_eq!(m.perspective_vertical, 0.0);
    assert_eq!(m.perspective_horizontal, 0.0);
    assert_eq!(m.perspective_rotate, 0.0);
    assert_eq!(m.perspective_scale, 100.0);
    assert_eq!(m.perspective_aspect, 0.0);
    assert_eq!(m.perspective_x, 0.0);
    assert_eq!(m.perspective_y, 0.0);
}

/// Omit-on-default, the invariant that keeps a sidecar for an untouched
/// Geometry panel byte-identical to what a build without the tool produced.
#[test]
fn defaults_emit_no_perspective_attributes() {
    let out = serialize(&AdjustmentModel::default());
    assert!(
        !out.contains("crs:Perspective"),
        "default model emitted a geometry attribute: {out}"
    );
}

#[test]
fn non_default_values_round_trip_through_the_serializer() {
    let mut m = AdjustmentModel::default();
    m.perspective_vertical = -20.0;
    m.perspective_horizontal = 12.5;
    m.perspective_rotate = -3.5;
    m.perspective_scale = 110.0;
    m.perspective_aspect = -35.0;
    m.perspective_x = 8.0;
    m.perspective_y = -6.0;
    let out = serialize(&m);
    for expected in [
        r#"crs:PerspectiveVertical="-20""#,
        r#"crs:PerspectiveHorizontal="12.5""#,
        r#"crs:PerspectiveRotate="-3.5""#,
        r#"crs:PerspectiveScale="110""#,
        r#"crs:PerspectiveAspect="-35""#,
        r#"crs:PerspectiveX="8""#,
        r#"crs:PerspectiveY="-6""#,
    ] {
        assert!(out.contains(expected), "missing {expected} in {out}");
    }
    let back = parse(&format!(
        r#"<?xml version="1.0"?><x><rdf:Description xmlns:rdf="x" xmlns:crs="x" xmlns:papp="x"{out}/></x>"#
    ))
    .expect("re-parses");
    assert_eq!(back.perspective_vertical, m.perspective_vertical);
    assert_eq!(back.perspective_horizontal, m.perspective_horizontal);
    assert_eq!(back.perspective_rotate, m.perspective_rotate);
    assert_eq!(back.perspective_scale, m.perspective_scale);
    assert_eq!(back.perspective_aspect, m.perspective_aspect);
    assert_eq!(back.perspective_x, m.perspective_x);
    assert_eq!(back.perspective_y, m.perspective_y);
}

/// A scale of exactly 100 is the default and must be omitted even when every
/// sibling is authored — the omit test is per-field, not per-group.
#[test]
fn a_default_scale_is_omitted_alongside_authored_siblings() {
    let mut m = AdjustmentModel::default();
    m.perspective_vertical = -20.0;
    let out = serialize(&m);
    assert!(out.contains(r#"crs:PerspectiveVertical="-20""#));
    assert!(!out.contains("crs:PerspectiveScale"), "{out}");
}

/// raw-core is the strict reader: a non-numeric or non-finite geometry value
/// fails the parse rather than putting a NaN through a whole render (#1943).
#[test]
fn a_non_numeric_geometry_value_is_rejected() {
    for bad in ["level", "NaN", "Infinity"] {
        let out = parse(&format!(
            r#"<?xml version="1.0"?><x><rdf:Description xmlns:rdf="x" xmlns:crs="x" crs:PerspectiveRotate="{bad}"/></x>"#
        ));
        assert!(out.is_err(), "{bad} should not parse");
    }
}
