//! Unit tests for [`super`] — the recipe's colour ops (#3503 Task D6),
//! reached through a full parsed recipe rather than by calling
//! `RasterImage` methods directly (those are covered in `raster_colour.rs` /
//! `raster_colour_lab.rs`). `super` is `raster_recipe_colour`.

use super::*;
use crate::raster_recipe::parse_recipe;
use crate::raster_recipe_exec::run_recipe;

fn run(json: &str, input: &[u8], aux: &[u8]) -> crate::raster_recipe_exec::RecipeResult {
    run_recipe(&parse_recipe(json).unwrap(), input, aux).unwrap()
}

#[test]
fn colour_ops_are_reachable_from_the_recipe() {
    // 127/220/76 — Rec.709 luma in LINEAR light (#3503 controller ruling),
    // not the encoded-values 54/182/18 the pre-ruling brief expected.
    let out = run(
        r#"{"v":1,"input":{"kind":"raw","width":1,"height":1,"channels":3},
            "ops":[{"op":"greyscale"}],"output":{"format":"raw"}}"#,
        &[255, 0, 0],
        &[],
    );
    assert_eq!(out.bytes, vec![127, 127, 127]);
}

#[test]
fn gamma_is_reachable_from_the_recipe() {
    let out = run(
        r#"{"v":1,"input":{"kind":"raw","width":1,"height":1,"channels":3},
            "ops":[{"op":"gamma","exponent":2.0}],"output":{"format":"raw"}}"#,
        &[128, 255, 0],
        &[],
    );
    assert_eq!(out.bytes, vec![64, 255, 0]);
}

#[test]
fn linear_is_reachable_from_the_recipe() {
    let out = run(
        r#"{"v":1,"input":{"kind":"raw","width":1,"height":1,"channels":3},
            "ops":[{"op":"linear","a":[0.5,1.0,2.0],"b":[10,0,-50]}],"output":{"format":"raw"}}"#,
        &[100, 100, 100],
        &[],
    );
    assert_eq!(out.bytes, vec![60, 100, 150]);
}

#[test]
fn negate_is_reachable_from_the_recipe() {
    let out = run(
        r#"{"v":1,"input":{"kind":"raw","width":1,"height":1,"channels":4},
            "ops":[{"op":"negate","alpha":false}],"output":{"format":"raw"}}"#,
        &[0, 100, 255, 200],
        &[],
    );
    assert_eq!(out.bytes, vec![255, 155, 0, 200]);
}

#[test]
fn modulate_is_reachable_from_the_recipe() {
    let out = run(
        r#"{"v":1,"input":{"kind":"raw","width":1,"height":1,"channels":3},
            "ops":[{"op":"modulate","saturation":0}],"output":{"format":"raw"}}"#,
        &[200, 40, 40],
        &[],
    );
    assert!((out.bytes[0] as i32 - out.bytes[1] as i32).abs() <= 1);
    assert!((out.bytes[1] as i32 - out.bytes[2] as i32).abs() <= 1);
}

#[test]
fn tint_is_reachable_from_the_recipe() {
    // Grey tint(128,128,128) on (200,40,40) -> 105 grey, measured against
    // real sharp 0.34.5 (#3503 controller ruling B: tint reduces to
    // luminance in LINEAR light via `bw_luma`, the same reduction
    // `greyscale()` uses, not a matrix on the encoded samples). ±1 for the
    // same de-gamma/re-gamma rounding slack every other closed-form
    // assertion in this file allows.
    let out = run(
        r#"{"v":1,"input":{"kind":"raw","width":1,"height":1,"channels":3},
            "ops":[{"op":"tint","rgb":[128,128,128]}],"output":{"format":"raw"}}"#,
        &[200, 40, 40],
        &[],
    );
    for got in &out.bytes {
        assert!(got.abs_diff(105) <= 1, "got {:?}", out.bytes);
    }
}

#[test]
fn a_chromatic_tint_is_reachable_from_the_recipe() {
    // sharp 0.34.5 `.tint({r:255,g:0,b:0})` on solid mid-grey (100,100,100)
    // -> (216, 0, 0).
    let out = run(
        r#"{"v":1,"input":{"kind":"raw","width":1,"height":1,"channels":3},
            "ops":[{"op":"tint","rgb":[255,0,0]}],"output":{"format":"raw"}}"#,
        &[100, 100, 100],
        &[],
    );
    assert!(
        (out.bytes[0] as i32 - 216).abs() <= 1,
        "got {:?}",
        out.bytes
    );
    assert!((out.bytes[1] as i32 - 0).abs() <= 1, "got {:?}", out.bytes);
    assert!((out.bytes[2] as i32 - 0).abs() <= 1, "got {:?}", out.bytes);
}

#[test]
fn normalise_is_reachable_from_the_recipe() {
    // Same compressed-ramp fixture and tolerance as
    // `raster_colour_lab::tests::normalise_stretches_the_luminance_to_the_full_range`
    // — sharp does not nudge the percentile bounds to force an exact touch
    // of both ends.
    let ramp: Vec<u8> = (0..129u32)
        .flat_map(|i| {
            let v = (64 + i / 2) as u8;
            [v, v, v]
        })
        .collect();
    let out = run(
        r#"{"v":1,"input":{"kind":"raw","width":129,"height":1,"channels":3},
            "ops":[{"op":"normalise","lower":0,"upper":100}],"output":{"format":"raw"}}"#,
        &ramp,
        &[],
    );
    assert!(out.bytes[0] <= 1, "got {}", out.bytes[0]);
    assert!(
        out.bytes[out.bytes.len() - 1] >= 254,
        "got {}",
        out.bytes[out.bytes.len() - 1]
    );
}

#[test]
fn a_to_colourspace_op_changes_the_embedded_profile() {
    let recipe = |space: &str| {
        format!(
            r#"{{"v":1,"input":{{"kind":"raw","width":4,"height":4,"channels":3}},
                "ops":[{{"op":"toColourspace","space":"{space}"}}],
                "output":{{"format":"jpeg","quality":90}}}}"#
        )
    };
    let px = vec![100u8; 48];
    let srgb = run(&recipe("srgb"), &px, &[]);
    let p3 = run(&recipe("display-p3"), &px, &[]);
    assert_ne!(srgb.bytes, p3.bytes);
    assert!(p3.bytes.windows(12).any(|w| w == b"ICC_PROFILE\0"));
}

#[test]
fn an_unknown_colourspace_is_named() {
    let recipe = parse_recipe(
        r#"{"v":1,"input":{"kind":"raw","width":1,"height":1,"channels":3},
            "ops":[{"op":"toColourspace","space":"cmyk"}],"output":{"format":"raw"}}"#,
    )
    .unwrap();
    let err = run_recipe(&recipe, &[1, 2, 3], &[]).unwrap_err();
    assert!(format!("{err}").contains("cmyk"), "got: {err}");
}

#[test]
fn p3_is_the_output_primaries_of_the_last_tocolourspace_op() {
    let recipe = parse_recipe(
        r#"{"v":1,"input":{"kind":"raw","width":1,"height":1,"channels":3},
            "ops":[{"op":"toColourspace","space":"display-p3"},
                   {"op":"toColourspace","space":"srgb"}],"output":{"format":"raw"}}"#,
    )
    .unwrap();
    assert_eq!(output_primaries(&recipe).unwrap(), TargetPrimaries::Srgb);
}

#[test]
fn a_non_finite_gamma_exponent_is_named() {
    let recipe = parse_recipe(
        r#"{"v":1,"input":{"kind":"raw","width":1,"height":1,"channels":3},
            "ops":[{"op":"gamma","exponent":null}],"output":{"format":"raw"}}"#,
    );
    // `null` fails to deserialize as f64 before validation even runs — this
    // pins that a non-numeric exponent is rejected at parse time.
    assert!(recipe.is_err());

    let img = RasterImage::new_rgb(1, 1, vec![10, 10, 10]);
    let err = apply_colour_op(img, &Op::Gamma { exponent: f64::NAN }).unwrap_err();
    assert!(format!("{err}").contains("gamma exponent"), "got: {err}");
}

#[test]
fn non_finite_linear_coefficients_are_named() {
    let img = RasterImage::new_rgb(1, 1, vec![10, 10, 10]);
    let err = apply_colour_op(
        img,
        &Op::Linear {
            a: [1.0, f64::INFINITY, 1.0],
            b: [0.0, 0.0, 0.0],
        },
    )
    .unwrap_err();
    assert!(format!("{err}").contains("linear a[1]"), "got: {err}");
}

#[test]
fn normalise_bounds_out_of_0_100_are_rejected() {
    let img = RasterImage::new_rgb(1, 1, vec![10, 10, 10]);
    let err = apply_colour_op(
        img,
        &Op::Normalise {
            lower: -1.0,
            upper: 100.0,
        },
    )
    .unwrap_err();
    assert!(format!("{err}").contains("lower=-1"), "got: {err}");
}

#[test]
fn normalise_lower_must_be_below_upper() {
    let img = RasterImage::new_rgb(1, 1, vec![10, 10, 10]);
    let err = apply_colour_op(
        img,
        &Op::Normalise {
            lower: 50.0,
            upper: 50.0,
        },
    )
    .unwrap_err();
    assert!(format!("{err}").contains("lower < upper"), "got: {err}");
}

#[test]
fn modulate_rejects_a_negative_brightness() {
    let img = RasterImage::new_rgb(1, 1, vec![10, 10, 10]);
    let err = apply_colour_op(
        img,
        &Op::Modulate {
            brightness: -0.5,
            saturation: 1.0,
            hue: 0.0,
            lightness: 0.0,
        },
    )
    .unwrap_err();
    assert!(format!("{err}").contains("brightness"), "got: {err}");
}

#[test]
fn modulate_rejects_a_negative_saturation() {
    let img = RasterImage::new_rgb(1, 1, vec![10, 10, 10]);
    let err = apply_colour_op(
        img,
        &Op::Modulate {
            brightness: 1.0,
            saturation: -0.5,
            hue: 0.0,
            lightness: 0.0,
        },
    )
    .unwrap_err();
    assert!(format!("{err}").contains("saturation"), "got: {err}");
}
