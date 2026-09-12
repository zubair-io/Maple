use super::*;
use crate::raster_recipe::parse_recipe;
use crate::raster_recipe_exec::{run_recipe, RecipeResult};

// `BlurOp`/`SharpenOp`/`MedianOp`/`ThresholdOp`/`ConvolveOp` come in via
// `super::*` (this file's parent, `raster_recipe_filter.rs`, defines them).

/// Mirrors `raster_recipe_exec.rs`'s own private test helper — duplicated
/// rather than shared because `#[cfg(test)]` sibling modules don't share
/// bindings (same rationale `raster_filter_ops_tests.rs` gives for
/// duplicating its `impulse`/`step_edge` fixtures).
fn run(json: &str, input: &[u8], aux: &[u8]) -> RecipeResult {
    run_recipe(&parse_recipe(json).unwrap(), input, aux).unwrap()
}

// ------------------------------------------------------------------ blur ---

#[test]
fn filter_ops_are_reachable_from_the_recipe() {
    // A single white pixel in a 5x5 black field, box-blurred: 255/9 = 28.
    let mut px = vec![0u8; 5 * 5 * 3];
    px[(2 * 5 + 2) * 3..(2 * 5 + 2) * 3 + 3].copy_from_slice(&[255, 255, 255]);
    let out = run(
        r#"{"v":1,"input":{"kind":"raw","width":5,"height":5,"channels":3},
            "ops":[{"op":"blur"}],"output":{"format":"raw"}}"#,
        &px,
        &[],
    );
    assert_eq!(out.bytes[(2 * 5 + 2) * 3], 28);
}

#[test]
fn blur_with_sigma_runs_through_the_recipe_on_a_4_channel_image() {
    // A flat RGBA field with one bright impulse; the only thing pinned here
    // is that a Gaussian `blur` reaches through the recipe on 4 channels and
    // leaves a fully opaque image fully opaque (no alpha bleed) — the exact
    // colour spread is `raster_filter_tests.rs`'s job to pin, not this file's.
    let mut px: Vec<u8> = (0..9).flat_map(|_| [10u8, 20, 30, 255]).collect();
    px[(4 * 4)..(4 * 4 + 4)].copy_from_slice(&[250, 250, 250, 255]);
    let out = run(
        r#"{"v":1,"input":{"kind":"raw","width":3,"height":3,"channels":4},
            "ops":[{"op":"blur","sigma":1.5}],"output":{"format":"raw"}}"#,
        &px,
        &[],
    );
    assert_eq!(out.bytes.len(), 9 * 4);
    assert!(
        (0..9).all(|i| out.bytes[i * 4 + 3] == 255),
        "an opaque source stays opaque"
    );
}

#[test]
fn an_out_of_range_blur_sigma_is_named() {
    let recipe = parse_recipe(
        r#"{"v":1,"input":{"kind":"raw","width":3,"height":3,"channels":3},
            "ops":[{"op":"blur","sigma":5000.0}],"output":{"format":"raw"}}"#,
    )
    .unwrap();
    let err = run_recipe(&recipe, &vec![0u8; 27], &[]).unwrap_err();
    assert!(format!("{err}").contains("5000"), "got: {err}");
}

// --------------------------------------------------------------- sharpen ---

#[test]
fn sharpen_runs_through_the_recipe() {
    // A flat field is invariant under both the fast no-argument kernel and
    // the mask-based unsharp transfer — there's no local contrast to boost.
    let flat = vec![80u8; 3 * 3 * 3];
    let out = run(
        r#"{"v":1,"input":{"kind":"raw","width":3,"height":3,"channels":3},
            "ops":[{"op":"sharpen"}],"output":{"format":"raw"}}"#,
        &flat,
        &[],
    );
    assert!(out.bytes.iter().all(|&v| v == 80));
}

#[test]
fn sharpen_with_sigma_runs_through_the_recipe_on_a_4_channel_image() {
    let flat: Vec<u8> = (0..9).flat_map(|_| [80u8, 80, 80, 200]).collect();
    let out = run(
        r#"{"v":1,"input":{"kind":"raw","width":3,"height":3,"channels":4},
            "ops":[{"op":"sharpen","sigma":2.0}],"output":{"format":"raw"}}"#,
        &flat,
        &[],
    );
    assert!(
        (0..9).all(|i| out.bytes[i * 4 + 3] == 200),
        "sharpen never touches alpha"
    );
    assert!(
        (0..9).all(|i| out.bytes[i * 4..i * 4 + 3] == [80, 80, 80]),
        "a flat field has no local contrast to boost"
    );
}

#[test]
fn an_out_of_range_sharpen_sigma_is_named() {
    let recipe = parse_recipe(
        r#"{"v":1,"input":{"kind":"raw","width":3,"height":3,"channels":3},
            "ops":[{"op":"sharpen","sigma":50.0}],"output":{"format":"raw"}}"#,
    )
    .unwrap();
    let err = run_recipe(&recipe, &vec![0u8; 27], &[]).unwrap_err();
    assert!(format!("{err}").contains("50"), "got: {err}");
}

// ---------------------------------------------------------------- median ---

#[test]
fn median_runs_through_the_recipe() {
    let mut px = vec![100u8; 5 * 5 * 3];
    let centre = ((2 * 5 + 2) * 3) as usize;
    px[centre..centre + 3].copy_from_slice(&[255, 255, 255]);
    let out = run(
        r#"{"v":1,"input":{"kind":"raw","width":5,"height":5,"channels":3},
            "ops":[{"op":"median","size":3}],"output":{"format":"raw"}}"#,
        &px,
        &[],
    );
    assert_eq!(out.bytes[centre], 100);
}

#[test]
fn median_runs_through_the_recipe_on_a_4_channel_image() {
    let data: Vec<u8> = (0..8u32)
        .flat_map(|x| [90u8, 90, 90, if x == 4 { 0 } else { 255 }])
        .collect();
    let out = run(
        r#"{"v":1,"input":{"kind":"raw","width":8,"height":1,"channels":4},
            "ops":[{"op":"median","size":3}],"output":{"format":"raw"}}"#,
        &data,
        &[],
    );
    assert_eq!(
        out.bytes[4 * 4 + 3],
        255,
        "the lone transparent pixel is a speck"
    );
}

#[test]
fn a_bad_median_window_is_reported() {
    // #3504 task E5 controller ruling (c): `size` is no longer odd-only
    // (sharp/`vips_rank` accepts even windows — see `RasterImage::median`'s
    // doc comment), so the value that actually fails now is one over the
    // sharp-matching [1, 1000] ceiling, not an even number.
    let recipe = parse_recipe(
        r#"{"v":1,"input":{"kind":"raw","width":3,"height":3,"channels":3},
            "ops":[{"op":"median","size":1001}],"output":{"format":"raw"}}"#,
    )
    .unwrap();
    let err = run_recipe(&recipe, &vec![0u8; 27], &[]).unwrap_err();
    assert!(format!("{err}").contains("1001"), "got: {err}");
}

#[test]
fn an_even_median_window_reaches_the_recipe() {
    // Companion to `a_bad_median_window_is_reported`: an even `size` must
    // now succeed through the full recipe, not just at the `RasterImage`
    // layer (`median_size_2_matches_sharps_asymmetric_window` in
    // `raster_filter_ops_tests.rs` pins the actual sharp-matching value).
    let mut px = vec![100u8; 5 * 5 * 3];
    let centre = ((2 * 5 + 2) * 3) as usize;
    px[centre..centre + 3].copy_from_slice(&[255, 255, 255]);
    let out = run(
        r#"{"v":1,"input":{"kind":"raw","width":5,"height":5,"channels":3},
            "ops":[{"op":"median","size":2}],"output":{"format":"raw"}}"#,
        &px,
        &[],
    );
    assert_eq!(out.bytes.len(), px.len());
}

// ------------------------------------------------------------- threshold ---

#[test]
fn threshold_and_convolve_reach_the_recipe() {
    let out = run(
        r#"{"v":1,"input":{"kind":"raw","width":2,"height":1,"channels":3},
            "ops":[{"op":"threshold","value":128}],"output":{"format":"raw"}}"#,
        &[255, 0, 0, 0, 255, 0],
        &[],
    );
    assert_eq!(out.bytes, vec![0, 0, 0, 255, 255, 255]);

    let identity = run(
        r#"{"v":1,"input":{"kind":"raw","width":3,"height":3,"channels":3},
            "ops":[{"op":"convolve","width":3,"height":3,
                    "kernel":[0,0,0,0,1,0,0,0,0],"scale":1,"offset":0}],
            "output":{"format":"raw"}}"#,
        &vec![77u8; 27],
        &[],
    );
    assert_eq!(identity.bytes, vec![77u8; 27]);
}

#[test]
fn threshold_runs_through_the_recipe_on_a_4_channel_image() {
    let out = run(
        r#"{"v":1,"input":{"kind":"raw","width":1,"height":1,"channels":4},
            "ops":[{"op":"threshold","value":128}],"output":{"format":"raw"}}"#,
        &[255, 255, 255, 64],
        &[],
    );
    assert_eq!(out.bytes[3], 0, "alpha is thresholded too");
}

// -------------------------------------------------------------- convolve ---

#[test]
fn convolve_runs_through_the_recipe_on_a_4_channel_image() {
    // A flat 80-valued RGBA field, alpha included, is NOT bit-exact
    // invariant under a normalised box kernel once colour is premultiplied
    // by (a non-255) alpha before convolving and truncated (not rounded)
    // both ways: premultiplying truncates 80*80/255=25.098 to 25, and
    // unpremultiplying truncates 25*255/80=79.68 back down to 79, one
    // short of the original 80 — matching sharp 0.34.5's real output on
    // this exact fixture (measured directly: `sharp(flat RGBA
    // 80).convolve({width:3,height:3,kernel:[1x9]})` gives 79/79/79/80 at
    // every pixel). Alpha itself is never premultiplied, so it alone stays
    // exactly 80.
    let flat = vec![80u8; 3 * 3 * 4];
    let out = run(
        r#"{"v":1,"input":{"kind":"raw","width":3,"height":3,"channels":4},
            "ops":[{"op":"convolve","width":3,"height":3,"kernel":[1,1,1,1,1,1,1,1,1]}],
            "output":{"format":"raw"}}"#,
        &flat,
        &[],
    );
    assert!(
        out.bytes.chunks_exact(4).all(|px| px == [79, 79, 79, 80]),
        "got: {:?}",
        &out.bytes[..4]
    );
}

#[test]
fn convolve_scale_explicit_zero_clips_to_one_but_absent_scale_uses_the_kernel_sum() {
    // Same flat 30-valued field either way. `apply_filter_op` (the executor,
    // `raster_recipe_filter.rs`) must keep sharp's "absent scale" and
    // "explicit scale: 0" apart: an absent `scale` falls back to the kernel
    // sum (9 for this box), leaving a flat field flat; an explicit `0` is
    // sharp's own rule to clip to a minimum of 1, which — dividing the same
    // box sum by 1 instead of 9 — blows straight past 255 and clamps there.
    let flat: Vec<u8> = vec![30u8; 5 * 5 * 3];
    let centre = (2 * 5 + 2) * 3;

    let absent = run(
        r#"{"v":1,"input":{"kind":"raw","width":5,"height":5,"channels":3},
            "ops":[{"op":"convolve","width":3,"height":3,"kernel":[1,1,1,1,1,1,1,1,1]}],
            "output":{"format":"raw"}}"#,
        &flat,
        &[],
    );
    assert_eq!(absent.bytes[centre], 30);

    let explicit_zero = run(
        r#"{"v":1,"input":{"kind":"raw","width":5,"height":5,"channels":3},
            "ops":[{"op":"convolve","width":3,"height":3,"kernel":[1,1,1,1,1,1,1,1,1],"scale":0}],
            "output":{"format":"raw"}}"#,
        &flat,
        &[],
    );
    assert_eq!(explicit_zero.bytes[centre], 255);
}

#[test]
fn a_bad_convolve_kernel_dimension_is_named() {
    let recipe = parse_recipe(
        r#"{"v":1,"input":{"kind":"raw","width":3,"height":3,"channels":3},
            "ops":[{"op":"convolve","width":2,"height":2,"kernel":[1,1,1,1]}],
            "output":{"format":"raw"}}"#,
    )
    .unwrap();
    let err = run_recipe(&recipe, &vec![0u8; 27], &[]).unwrap_err();
    assert!(format!("{err}").contains("2x2"), "got: {err}");
}

#[test]
fn a_convolve_kernel_length_mismatch_is_named() {
    let recipe = parse_recipe(
        r#"{"v":1,"input":{"kind":"raw","width":3,"height":3,"channels":3},
            "ops":[{"op":"convolve","width":3,"height":3,"kernel":[1,1,1]}],
            "output":{"format":"raw"}}"#,
    )
    .unwrap();
    let err = run_recipe(&recipe, &vec![0u8; 27], &[]).unwrap_err();
    assert!(format!("{err}").contains("expected 9"), "got: {err}");
}

#[test]
fn a_non_integer_convolve_scale_is_named() {
    // sharp's own `convolve()` (`lib/operation.js`) only honours `scale`
    // when `is.integer()` passes — a non-integer is silently replaced by
    // the kernel's own sum instead of erroring. Measured on sharp 0.34.5:
    // `scale: 4.5` over a flat 30 field with a box-of-9 kernel leaves the
    // field at 30 (scale silently replaced by the kernel sum of 9, not
    // applied as 4.5). Maple rejects rather than silently diverging.
    let recipe = parse_recipe(
        r#"{"v":1,"input":{"kind":"raw","width":5,"height":5,"channels":3},
            "ops":[{"op":"convolve","width":3,"height":3,"kernel":[1,1,1,1,1,1,1,1,1],"scale":4.5}],
            "output":{"format":"raw"}}"#,
    )
    .unwrap();
    let err = run_recipe(&recipe, &vec![30u8; 5 * 5 * 3], &[]).unwrap_err();
    assert!(format!("{err}").contains("scale"), "got: {err}");
}

#[test]
fn a_non_integer_convolve_offset_is_named() {
    let recipe = parse_recipe(
        r#"{"v":1,"input":{"kind":"raw","width":5,"height":5,"channels":3},
            "ops":[{"op":"convolve","width":3,"height":3,"kernel":[1,1,1,1,1,1,1,1,1],"offset":0.5}],
            "output":{"format":"raw"}}"#,
    )
    .unwrap();
    let err = run_recipe(&recipe, &vec![30u8; 5 * 5 * 3], &[]).unwrap_err();
    assert!(format!("{err}").contains("offset"), "got: {err}");
}

#[test]
fn integer_convolve_scale_and_offset_still_work() {
    let recipe = parse_recipe(
        r#"{"v":1,"input":{"kind":"raw","width":5,"height":5,"channels":3},
            "ops":[{"op":"convolve","width":3,"height":3,"kernel":[1,1,1,1,1,1,1,1,1],"scale":9,"offset":0}],
            "output":{"format":"raw"}}"#,
    )
    .unwrap();
    let out = run_recipe(&recipe, &vec![30u8; 5 * 5 * 3], &[]).unwrap();
    assert_eq!(out.bytes[(2 * 5 + 2) * 3], 30);
}

// ------------------------------------------------------- schema defaults ---
//
// Moved here from `raster_recipe.rs`'s own test module to keep that file
// under its 600-line hard budget (#3504 task E4) — these still exercise
// `Op`/`parse_recipe` directly, just from this sibling file.

#[test]
fn sharpen_defaults_match_sharp() {
    let r = parse_recipe(
        r#"{"v":1,"input":{"kind":"encoded"},"ops":[{"op":"sharpen"}],"output":{"format":"png"}}"#,
    )
    .unwrap();
    match &r.ops[0] {
        Op::Sharpen(SharpenOp {
            sigma,
            m1,
            m2,
            x1,
            y2,
            y3,
        }) => {
            assert_eq!(*sigma, None);
            assert_eq!(*m1, 1.0);
            assert_eq!(*m2, 2.0);
            assert_eq!(*x1, 2.0);
            assert_eq!(*y2, 10.0);
            assert_eq!(*y3, 20.0);
        }
        other => panic!("expected a sharpen op, got {other:?}"),
    }
}

#[test]
fn threshold_defaults_match_sharp() {
    let r = parse_recipe(
        r#"{"v":1,"input":{"kind":"encoded"},"ops":[{"op":"threshold"}],"output":{"format":"png"}}"#,
    )
    .unwrap();
    assert!(matches!(
        r.ops[0],
        Op::Threshold(ThresholdOp {
            value: 128,
            greyscale: true
        })
    ));
}

#[test]
fn median_defaults_to_a_3x3_window() {
    let r = parse_recipe(
        r#"{"v":1,"input":{"kind":"encoded"},"ops":[{"op":"median"}],"output":{"format":"png"}}"#,
    )
    .unwrap();
    assert!(matches!(r.ops[0], Op::Median(MedianOp { size: 3 })));
}

#[test]
fn convolve_leaves_an_absent_scale_as_none() {
    // The absent/explicit-0 distinction is load-bearing for the executor
    // (see `Op::Convolve`'s doc comment) — this pins that the schema itself
    // preserves it rather than collapsing both to 0.0.
    let r = parse_recipe(
        r#"{"v":1,"input":{"kind":"encoded"},
            "ops":[{"op":"convolve","width":3,"height":3,"kernel":[1,1,1,1,1,1,1,1,1]}],
            "output":{"format":"png"}}"#,
    )
    .unwrap();
    assert!(matches!(
        r.ops[0],
        Op::Convolve(ConvolveOp {
            scale: None,
            offset,
            ..
        }) if offset == 0.0
    ));

    let explicit = parse_recipe(
        r#"{"v":1,"input":{"kind":"encoded"},
            "ops":[{"op":"convolve","width":3,"height":3,"kernel":[1,1,1,1,1,1,1,1,1],"scale":0}],
            "output":{"format":"png"}}"#,
    )
    .unwrap();
    assert!(matches!(
        explicit.ops[0],
        Op::Convolve(ConvolveOp {
            scale: Some(s), ..
        }) if s == 0.0
    ));
}

#[test]
fn blur_rejects_sharps_precision_option_by_name() {
    // sharp's `blur({precision})` isn't part of this schema — Maple's blur
    // has no separate integer/float precision knob to select, so it must be
    // rejected by `deny_unknown_fields`, named, not silently dropped.
    let err = parse_recipe(
        r#"{"v":1,"input":{"kind":"encoded"},"ops":[{"op":"blur","precision":"integer"}],"output":{"format":"png"}}"#,
    )
    .unwrap_err();
    assert!(format!("{err}").contains("precision"), "got: {err}");
}

#[test]
fn threshold_rejects_the_american_spelling_alias_on_the_wire() {
    // The `grayscale` alias is resolved TS-side (E5), not accepted on this
    // schema — a caller sending it here made a wire-format mistake, not a
    // valid alternate spelling.
    let err = parse_recipe(
        r#"{"v":1,"input":{"kind":"encoded"},"ops":[{"op":"threshold","grayscale":true}],"output":{"format":"png"}}"#,
    )
    .unwrap_err();
    assert!(format!("{err}").contains("grayscale"), "got: {err}");
}
