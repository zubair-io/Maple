//! Tests for `raster_recipe`'s schema/parsing — split out of `raster_recipe.rs`
//! to keep that file under budget, same pattern as `raster.rs` /
//! `raster_tests.rs`.

use super::*;

#[test]
fn parses_a_minimal_encoded_to_jpeg_recipe() {
    let r = parse_recipe(
        r#"{"v":1,"input":{"kind":"encoded"},"ops":[],"output":{"format":"jpeg","quality":82}}"#,
    )
    .unwrap();
    assert_eq!(r.v, 1);
    assert!(matches!(r.input, RecipeInput::Encoded {}));
    assert!(r.ops.is_empty());
    assert!(matches!(r.output, Output::Jpeg { quality: 82 }));
}

#[test]
fn parses_raw_input_dimensions() {
    let r = parse_recipe(
        r#"{"v":1,"input":{"kind":"raw","width":4,"height":2,"channels":4},"ops":[],"output":{"format":"png"}}"#,
    )
    .unwrap();
    assert!(matches!(
        r.input,
        RecipeInput::Raw {
            width: 4,
            height: 2,
            channels: 4
        }
    ));
}

#[test]
fn resize_defaults_match_sharp() {
    let r = parse_recipe(
        r#"{"v":1,"input":{"kind":"encoded"},"ops":[{"op":"resize","width":10,"height":10}],"output":{"format":"png"}}"#,
    )
    .unwrap();
    match &r.ops[0] {
        Op::Resize {
            fit,
            position,
            kernel,
            without_enlargement,
            without_reduction,
            background,
            ..
        } => {
            assert_eq!(fit, "cover");
            assert_eq!(position, "centre");
            assert_eq!(kernel, "lanczos3");
            assert!(!without_enlargement);
            assert!(!without_reduction);
            assert_eq!(background, &[0, 0, 0, 255]);
        }
        other => panic!("expected a resize op, got {other:?}"),
    }
}

#[test]
fn extend_and_trim_defaults_match_sharp() {
    let r = parse_recipe(
        r#"{"v":1,"input":{"kind":"encoded"},
            "ops":[{"op":"extend","left":1},{"op":"trim"}],"output":{"format":"png"}}"#,
    )
    .unwrap();
    match &r.ops[0] {
        Op::Extend {
            extend_with,
            background,
            ..
        } => {
            assert_eq!(extend_with, "background");
            assert_eq!(*background, [0, 0, 0, 255]);
        }
        other => panic!("expected an extend op, got {other:?}"),
    }
    match &r.ops[1] {
        Op::Trim {
            background,
            threshold,
            margin,
            line_art,
        } => {
            assert_eq!(*background, None);
            assert_eq!(*threshold, 10.0);
            assert_eq!(*margin, 0);
            assert!(!line_art);
        }
        other => panic!("expected a trim op, got {other:?}"),
    }
}

#[test]
fn a_typo_d_field_is_named_in_the_error() {
    let err = parse_recipe(
        r#"{"v":1,"input":{"kind":"encoded"},"ops":[{"op":"resize","wdth":10}],"output":{"format":"png"}}"#,
    )
    .unwrap_err();
    assert!(format!("{err}").contains("wdth"), "got: {err}");
}

#[test]
fn parses_a_composite_layer_with_an_aux_reference() {
    let r = parse_recipe(
        r#"{"v":1,"input":{"kind":"encoded"},"ops":[{"op":"composite","layers":[
             {"aux":{"off":0,"len":16},"raw":{"width":2,"height":2,"channels":4},"left":3,"top":4,"blend":"multiply"}]}],
           "output":{"format":"png"}}"#,
    )
    .unwrap();
    let Op::Composite { layers } = &r.ops[0] else {
        panic!("expected a composite op");
    };
    assert_eq!(layers[0].aux.len, 16);
    assert_eq!(layers[0].left, Some(3));
    assert_eq!(layers[0].blend, "multiply");
    assert_eq!(layers[0].gravity, "centre");
    assert!(!layers[0].tile);
}

#[test]
fn an_unknown_op_is_named_in_the_error() {
    let err = parse_recipe(
        r#"{"v":1,"input":{"kind":"encoded"},"ops":[{"op":"posterise"}],"output":{"format":"png"}}"#,
    )
    .unwrap_err();
    assert!(format!("{err}").contains("posterise"), "got: {err}");
}

#[test]
fn a_future_schema_version_is_rejected() {
    let err =
        parse_recipe(r#"{"v":2,"input":{"kind":"encoded"},"ops":[],"output":{"format":"png"}}"#)
            .unwrap_err();
    assert!(format!("{err}").contains("version 2"), "got: {err}");
}

/// Every variant of `RecipeInput`, `Op` and `Output` — unit and
/// struct-like alike — must reject a stray key. A unit variant that
/// stays a bare `Ident` (rather than `Ident {}`) silently accepts one,
/// because serde only enforces `deny_unknown_fields` on the
/// struct-variant deserialization path (#3505 fix-round-2, caught by
/// review after the fix-round-1 claim that the enum-level attribute
/// alone was enough — it wasn't, for unit variants). Table-driven so a
/// future variant added back as a bare unit is caught by this same test
/// without anyone remembering to add a case for it by hand.
#[test]
fn every_variant_of_every_recipe_enum_rejects_a_stray_key() {
    // (wire name, full recipe JSON with "zzzStray" spliced into that
    // variant's own object).
    let cases: &[(&str, &str)] = &[
        // RecipeInput
        (
            "input:encoded",
            r#"{"v":1,"input":{"kind":"encoded","zzzStray":1},"ops":[],"output":{"format":"png"}}"#,
        ),
        (
            "input:raw",
            r#"{"v":1,"input":{"kind":"raw","width":1,"height":1,"channels":3,"zzzStray":1},"ops":[],"output":{"format":"png"}}"#,
        ),
        // Op
        (
            "op:autoOrient",
            r#"{"v":1,"input":{"kind":"encoded"},"ops":[{"op":"autoOrient","zzzStray":1}],"output":{"format":"png"}}"#,
        ),
        (
            "op:resize",
            r#"{"v":1,"input":{"kind":"encoded"},"ops":[{"op":"resize","zzzStray":1}],"output":{"format":"png"}}"#,
        ),
        (
            "op:flatten",
            r#"{"v":1,"input":{"kind":"encoded"},"ops":[{"op":"flatten","zzzStray":1}],"output":{"format":"png"}}"#,
        ),
        (
            "op:ensureAlpha",
            r#"{"v":1,"input":{"kind":"encoded"},"ops":[{"op":"ensureAlpha","zzzStray":1}],"output":{"format":"png"}}"#,
        ),
        (
            "op:removeAlpha",
            r#"{"v":1,"input":{"kind":"encoded"},"ops":[{"op":"removeAlpha","zzzStray":1}],"output":{"format":"png"}}"#,
        ),
        (
            "op:composite",
            r#"{"v":1,"input":{"kind":"encoded"},"ops":[{"op":"composite","layers":[],"zzzStray":1}],"output":{"format":"png"}}"#,
        ),
        (
            "op:extract",
            r#"{"v":1,"input":{"kind":"encoded"},"ops":[{"op":"extract","left":0,"top":0,"width":1,"height":1,"zzzStray":1}],"output":{"format":"png"}}"#,
        ),
        (
            "op:extend",
            r#"{"v":1,"input":{"kind":"encoded"},"ops":[{"op":"extend","zzzStray":1}],"output":{"format":"png"}}"#,
        ),
        (
            "op:rotate",
            r#"{"v":1,"input":{"kind":"encoded"},"ops":[{"op":"rotate","angle":90,"zzzStray":1}],"output":{"format":"png"}}"#,
        ),
        (
            "op:flip",
            r#"{"v":1,"input":{"kind":"encoded"},"ops":[{"op":"flip","zzzStray":1}],"output":{"format":"png"}}"#,
        ),
        (
            "op:flop",
            r#"{"v":1,"input":{"kind":"encoded"},"ops":[{"op":"flop","zzzStray":1}],"output":{"format":"png"}}"#,
        ),
        (
            "op:trim",
            r#"{"v":1,"input":{"kind":"encoded"},"ops":[{"op":"trim","zzzStray":1}],"output":{"format":"png"}}"#,
        ),
        // Output
        (
            "output:jpeg",
            r#"{"v":1,"input":{"kind":"encoded"},"ops":[],"output":{"format":"jpeg","zzzStray":1}}"#,
        ),
        (
            "output:png",
            r#"{"v":1,"input":{"kind":"encoded"},"ops":[],"output":{"format":"png","zzzStray":1}}"#,
        ),
        (
            "output:webp",
            r#"{"v":1,"input":{"kind":"encoded"},"ops":[],"output":{"format":"webp","zzzStray":1}}"#,
        ),
        (
            "output:avif",
            r#"{"v":1,"input":{"kind":"encoded"},"ops":[],"output":{"format":"avif","zzzStray":1}}"#,
        ),
        (
            "output:tiff",
            r#"{"v":1,"input":{"kind":"encoded"},"ops":[],"output":{"format":"tiff","zzzStray":1}}"#,
        ),
        (
            "output:raw",
            r#"{"v":1,"input":{"kind":"encoded"},"ops":[],"output":{"format":"raw","zzzStray":1}}"#,
        ),
    ];
    for (variant, json) in cases {
        let err = match parse_recipe(json) {
            Err(e) => e,
            Ok(_) => panic!("{variant} silently accepted a stray key"),
        };
        assert!(
            format!("{err}").contains("zzzStray"),
            "{variant}: expected the error to name zzzStray, got: {err}"
        );
    }
}
