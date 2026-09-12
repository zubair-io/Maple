//! Unit tests for [`super`] — the recipe executor's op sequencing, output
//! routing and ICC binding. Split out of `raster_recipe_exec.rs` under the
//! 600-line hard file-size budget (#3506's ICC-binding wiring pushed it
//! over); same `#[path]` sibling pattern `raster_recipe.rs`/
//! `raster_recipe_tests.rs` and `view/encode.rs` use. Contents moved
//! verbatim, `super` is `raster_recipe_exec`.

use super::*;
use crate::raster_recipe::parse_recipe;

fn run(json: &str, input: &[u8], aux: &[u8]) -> RecipeResult {
    run_recipe(&parse_recipe(json).unwrap(), input, aux).unwrap()
}

/// 4x2 solid RGBA red, as a raw pixel buffer.
fn red_rgba() -> Vec<u8> {
    (0..8).flat_map(|_| [255u8, 0, 0, 255]).collect()
}

#[test]
fn raw_in_raw_out_is_a_round_trip() {
    let out = run(
        r#"{"v":1,"input":{"kind":"raw","width":4,"height":2,"channels":4},"ops":[],"output":{"format":"raw"}}"#,
        &red_rgba(),
        &[],
    );
    assert_eq!((out.width, out.height, out.channels), (4, 2, 4));
    assert_eq!(out.bytes, red_rgba());
}

#[test]
fn a_png_encode_keeps_the_alpha_channel() {
    let transparent: Vec<u8> = (0..4).flat_map(|_| [0u8, 255, 0, 0]).collect();
    let out = run(
        r#"{"v":1,"input":{"kind":"raw","width":2,"height":2,"channels":4},"ops":[],"output":{"format":"png"}}"#,
        &transparent,
        &[],
    );
    let decoded = crate::raster::decode_raster(&out.bytes, Some("png")).unwrap();
    assert_eq!(decoded.channels, 4);
    assert_eq!(decoded.data[3], 0);
}

#[test]
fn reported_channels_reflect_what_the_container_actually_wrote() {
    // An opaque RGBA source encoded to JPEG (no alpha channel in the
    // container) must report 3, not the source's 4 — JPEG silently
    // flattened it. The same source to PNG (alpha-capable) reports 4.
    let rgba = red_rgba();
    let jpeg = run(
        r#"{"v":1,"input":{"kind":"raw","width":4,"height":2,"channels":4},"ops":[],"output":{"format":"jpeg","quality":90}}"#,
        &rgba,
        &[],
    );
    assert_eq!(jpeg.channels, 3);
    let png = run(
        r#"{"v":1,"input":{"kind":"raw","width":4,"height":2,"channels":4},"ops":[],"output":{"format":"png"}}"#,
        &rgba,
        &[],
    );
    assert_eq!(png.channels, 4);
}

/// #3545's RGBA TIFF was unreachable from the recipe: the `Tiff` arm
/// composited over black before `encode_tiff_opts` ever saw the alpha,
/// so a correct encoder shipped behind a call site that flattened. The
/// file must now declare 4 samples with `ExtraSamples` = 2 (unassociated
/// alpha — the same value `sharp().tiff()` writes), and `channels` must
/// report the 4 the container really carries.
#[test]
fn a_tiff_encode_keeps_the_alpha_channel() {
    // Half-transparent green: a composite over black would turn the RGB
    // samples into (0, 128, 0) and drop the 4th sample entirely.
    let translucent: Vec<u8> = (0..4).flat_map(|_| [0u8, 255, 0, 128]).collect();
    let out = run(
        r#"{"v":1,"input":{"kind":"raw","width":2,"height":2,"channels":4},"ops":[],
            "output":{"format":"tiff","compression":"none"}}"#,
        &translucent,
        &[],
    );
    assert_eq!(out.channels, 4, "the recipe reported a flattened TIFF");
    let mut decoder = tiff::decoder::Decoder::new(std::io::Cursor::new(&out.bytes)).unwrap();
    assert_eq!(decoder.colortype().unwrap(), tiff::ColorType::RGBA(8));
    assert_eq!(
        decoder
            .get_tag_u16_vec(tiff::tags::Tag::ExtraSamples)
            .unwrap(),
        vec![2],
        "tag 338 must declare unassociated (straight) alpha"
    );
    match decoder.read_image().unwrap() {
        tiff::decoder::DecodingResult::U8(decoded) => assert_eq!(decoded, translucent),
        other => panic!("expected an 8-bit decode result, got {other:?}"),
    }
}

#[test]
fn ops_run_in_the_order_given() {
    // flatten-then-ensureAlpha leaves an OPAQUE alpha channel;
    // ensureAlpha-then-flatten would leave three channels.
    let src: Vec<u8> = (0..4).flat_map(|_| [200u8, 0, 0, 0]).collect();
    let out = run(
        r#"{"v":1,"input":{"kind":"raw","width":2,"height":2,"channels":4},
            "ops":[{"op":"flatten","background":[0,0,255,255]},{"op":"ensureAlpha","alpha":1.0}],
            "output":{"format":"raw"}}"#,
        &src,
        &[],
    );
    assert_eq!(out.channels, 4);
    assert_eq!(&out.bytes[..4], &[0, 0, 255, 255]);
}

#[test]
fn extend_with_a_transparent_background_composites_over_black_for_jpeg() {
    // 2x2 opaque black source; extend left by 2 with a fully-transparent
    // red background. The padded pixel is [255,0,0,0] pre-encode; JPEG
    // has no alpha, so it must composite over black before encoding —
    // this recipe path (raster_recipe_exec::encode -> encode_raster_opts)
    // already did, but pins it alongside the raw-ffi regression fixed
    // for #3501 (raster_v2's render_into took a different, alpha-dropping
    // path to the same JPEG encoder).
    let src: Vec<u8> = (0..4).flat_map(|_| [0u8, 0, 0, 255]).collect();
    let out = run(
        r#"{"v":1,"input":{"kind":"raw","width":2,"height":2,"channels":4},
            "ops":[{"op":"extend","left":2,"background":[255,0,0,0]}],
            "output":{"format":"jpeg","quality":95}}"#,
        &src,
        &[],
    );
    let decoded = crate::raster::decode_raster(&out.bytes, Some("jpeg")).unwrap();
    let (r, g, b) = (decoded.data[0], decoded.data[1], decoded.data[2]);
    assert!(
        r < 24 && g < 24 && b < 24,
        "padded transparent-red pixel encoded as ({r},{g},{b}), expected near-black"
    );
}

#[test]
fn resize_runs_through_the_recipe() {
    let out = run(
        r#"{"v":1,"input":{"kind":"raw","width":4,"height":2,"channels":4},
            "ops":[{"op":"resize","width":2,"height":1,"fit":"fill"}],
            "output":{"format":"raw"}}"#,
        &red_rgba(),
        &[],
    );
    assert_eq!((out.width, out.height), (2, 1));
}

#[test]
fn a_composite_layer_reads_its_pixels_from_aux() {
    let overlay: Vec<u8> = vec![0, 0, 255, 255];
    let out = run(
        r#"{"v":1,"input":{"kind":"raw","width":2,"height":1,"channels":4},
            "ops":[{"op":"composite","layers":[{"aux":{"off":0,"len":4},
                    "raw":{"width":1,"height":1,"channels":4},"left":1,"top":0}]}],
            "output":{"format":"raw"}}"#,
        &[255, 0, 0, 255, 255, 0, 0, 255],
        &overlay,
    );
    assert_eq!(&out.bytes[..4], &[255, 0, 0, 255]);
    assert_eq!(&out.bytes[4..8], &[0, 0, 255, 255]);
}

#[test]
fn an_out_of_range_aux_reference_is_rejected() {
    let recipe = parse_recipe(
        r#"{"v":1,"input":{"kind":"raw","width":1,"height":1,"channels":4},
            "ops":[{"op":"composite","layers":[{"aux":{"off":0,"len":99}}]}],
            "output":{"format":"raw"}}"#,
    )
    .unwrap();
    // Like `an_unknown_blend_mode_is_named` below, the error must name the
    // offending values, not just fail generically — here the requested
    // window and the actual aux buffer size.
    let err = run_recipe(&recipe, &[0, 0, 0, 255], &[1, 2, 3]).unwrap_err();
    let message = format!("{err}");
    assert!(message.contains("99"), "got: {message}");
    assert!(message.contains("3-byte"), "got: {message}");
}

#[test]
fn an_unknown_blend_mode_is_named() {
    let recipe = parse_recipe(
        r#"{"v":1,"input":{"kind":"raw","width":1,"height":1,"channels":4},
            "ops":[{"op":"composite","layers":[{"aux":{"off":0,"len":4},
                    "raw":{"width":1,"height":1,"channels":4},"blend":"soft-light"}]}],
            "output":{"format":"raw"}}"#,
    )
    .unwrap();
    let err = run_recipe(&recipe, &[0, 0, 0, 255], &[9, 9, 9, 255]).unwrap_err();
    assert!(format!("{err}").contains("soft-light"), "got: {err}");
}

#[test]
fn contain_letterboxes_through_the_recipe() {
    let out = run(
        r#"{"v":1,"input":{"kind":"raw","width":4,"height":2,"channels":4},
            "ops":[{"op":"resize","width":4,"height":4,"fit":"contain",
                    "background":[0,0,255,255],"kernel":"nearest"}],
            "output":{"format":"raw"}}"#,
        &red_rgba(),
        &[],
    );
    assert_eq!((out.width, out.height), (4, 4));
    assert_eq!(
        &out.bytes[..4],
        &[0, 0, 255, 255],
        "top row must be letterbox"
    );
}

#[test]
fn position_moves_the_cover_crop() {
    // 4x2 where the left half is red and the right half is green; a 2x2
    // cover crop at 'west' keeps red, at 'east' keeps green.
    let src: Vec<u8> = (0..2u32)
        .flat_map(|_| {
            (0..4u32).flat_map(|x| {
                if x < 2 {
                    [255u8, 0, 0, 255]
                } else {
                    [0, 255, 0, 255]
                }
            })
        })
        .collect();
    let recipe = |position: &str| {
        format!(
            r#"{{"v":1,"input":{{"kind":"raw","width":4,"height":2,"channels":4}},
                "ops":[{{"op":"resize","width":2,"height":2,"fit":"cover",
                         "position":"{position}","kernel":"nearest"}}],
                "output":{{"format":"raw"}}}}"#
        )
    };
    let west = run(&recipe("west"), &src, &[]);
    let east = run(&recipe("east"), &src, &[]);
    assert_eq!(&west.bytes[..4], &[255, 0, 0, 255]);
    assert_eq!(&east.bytes[..4], &[0, 255, 0, 255]);
}

#[test]
fn an_unsupported_fit_or_kernel_is_named() {
    for (json, needle) in [
        (r#"{"op":"resize","width":2,"fit":"squash"}"#, "squash"),
        (r#"{"op":"resize","width":2,"kernel":"mks2013"}"#, "mks2013"),
        (
            r#"{"op":"resize","width":2,"fit":"cover","position":"entropy"}"#,
            "entropy",
        ),
    ] {
        let recipe = parse_recipe(&format!(
            r#"{{"v":1,"input":{{"kind":"raw","width":2,"height":2,"channels":3}},
                 "ops":[{json}],"output":{{"format":"raw"}}}}"#
        ))
        .unwrap();
        let err = run_recipe(&recipe, &[0u8; 12], &[]).unwrap_err();
        assert!(
            format!("{err}").contains(needle),
            "expected {needle}, got: {err}"
        );
    }
}

/// A `toColourspace('display-p3')` recipe must tag its JPEG output with
/// Maple's own Display P3 ICC profile — not merely SOME profile, and not
/// sharp's (`withIccProfile('p3')` embeds Apple's/ICC.org's canonical P3
/// profile bytes; Maple generates its own from `icc::profile_for`, so the
/// oracle only ever compares presence/`hasProfile`, never a byte match).
/// `icc::profile_for` writes the description into a `desc` tag as plain
/// ASCII (see `raster_encode.rs`'s equivalent pin for the non-recipe
/// path), so a byte search for it is a direct check that the RIGHT
/// profile landed in the container, not just that the JPEG has an
/// `ICC_PROFILE` marker at all.
#[test]
fn a_p3_recipe_tags_its_jpeg_output_with_the_display_p3_profile() {
    let out = run(
        r#"{"v":1,"input":{"kind":"raw","width":4,"height":2,"channels":3},
            "ops":[{"op":"toColourspace","space":"display-p3"}],
            "output":{"format":"jpeg","quality":90}}"#,
        &vec![128u8; 24],
        &[],
    );
    assert!(
        out.bytes.windows(12).any(|w| w == b"ICC_PROFILE\0"),
        "P3 recipe JPEG is missing its embedded ICC profile"
    );
    assert!(
        out.bytes
            .windows(b"Display P3".len())
            .any(|w| w == b"Display P3"),
        "P3 recipe JPEG's embedded ICC profile does not name Display P3"
    );
}

/// The default (no `toColourspace`) recipe path stays UNTAGGED, unlike
/// the non-recipe `encode_raster_opts` path (which always embeds a
/// profile, sRGB included). This is deliberate, not an inconsistency:
/// the cross-decoder oracle (`test/oracle.test.ts`) measured that
/// tagging a default sRGB recipe output makes sharp colour-manage on
/// decode — a 12,008-of-12,288-byte mismatch on a 64x64 RGB PNG, not a
/// rounding difference — breaking every "byte-exact through sharp" pin
/// for the common case. Only a genuine `toColourspace` rotation embeds a
/// profile here; see `the_p3_recipe_...` tests above.
#[test]
fn a_default_recipe_leaves_its_jpeg_output_untagged() {
    let out = run(
        r#"{"v":1,"input":{"kind":"raw","width":4,"height":2,"channels":3},
            "ops":[],"output":{"format":"jpeg","quality":90}}"#,
        &vec![128u8; 24],
        &[],
    );
    assert!(
        !out.bytes.windows(12).any(|w| w == b"ICC_PROFILE\0"),
        "default recipe JPEG must not embed an ICC profile (oracle byte-exactness)"
    );
}

/// AVIF has no ICC/CICP tag yet (#3503) — a recipe asking for a P3 AVIF
/// must fail by name through this path too, matching
/// `export::encode_raster_rgb`'s gate on the non-recipe path (#3506
/// rebase: this path skipped the gate entirely before the ICC binding
/// was wired up).
#[test]
fn a_p3_recipe_rejects_avif_output_by_name() {
    let recipe = parse_recipe(
        r#"{"v":1,"input":{"kind":"raw","width":2,"height":2,"channels":3},
            "ops":[{"op":"toColourspace","space":"display-p3"}],
            "output":{"format":"avif"}}"#,
    )
    .unwrap();
    let err = run_recipe(&recipe, &vec![128u8; 12], &[]).unwrap_err();
    assert!(
        format!("{err}").to_lowercase().contains("avif"),
        "expected the AVIF/P3 combination to be named in the error, got: {err}"
    );
}
