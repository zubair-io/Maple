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

fn run_err(json: &str, input: &[u8], aux: &[u8]) -> crate::error::Error {
    run_recipe(&parse_recipe(json).unwrap(), input, aux).unwrap_err()
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

// ---- metadata (#3507) ----
//
// Every fixture below is a baseline JPEG from `crate::jpeg::encode` with an
// APP1 `Exif\0\0` and/or a single-chunk APP2 `ICC_PROFILE\0` segment
// hand-spliced in right after the SOI marker, mirroring the pattern
// `raster_meta_tests.rs`/`raster_recipe_meta.rs`'s own fixtures use.

const EXIF_TIFF: &[u8] = b"II\x2a\x00\x08\x00\x00\x00\x00\x00";

fn jpeg_source(icc: Option<&[u8]>, exif: Option<&[u8]>) -> Vec<u8> {
    let base = crate::jpeg::encode(4, 4, &vec![90u8; 4 * 4 * 3], 90).unwrap();
    let mut extra = Vec::new();
    if let Some(exif) = exif {
        let mut payload = b"Exif\0\0".to_vec();
        payload.extend_from_slice(exif);
        extra.push(0xFFu8);
        extra.push(0xE1);
        extra.extend_from_slice(&((payload.len() + 2) as u16).to_be_bytes());
        extra.extend_from_slice(&payload);
    }
    if let Some(icc) = icc {
        let mut payload = b"ICC_PROFILE\0".to_vec();
        payload.push(1); // sequence
        payload.push(1); // count
        payload.extend_from_slice(icc);
        extra.push(0xFFu8);
        extra.push(0xE2);
        extra.extend_from_slice(&((payload.len() + 2) as u16).to_be_bytes());
        extra.extend_from_slice(&payload);
    }
    let mut out = base[..2].to_vec();
    out.extend_from_slice(&extra);
    out.extend_from_slice(&base[2..]);
    out
}

fn p3_icc() -> Vec<u8> {
    crate::icc::profile_for(crate::view::encode::TargetPrimaries::P3)
}

#[test]
fn keep_metadata_copies_the_input_blocks_to_the_output() {
    let icc = p3_icc();
    let source = jpeg_source(Some(&icc), Some(EXIF_TIFF));
    let out = run(
        r#"{"v":1,"input":{"kind":"encoded"},"ops":[],
            "output":{"format":"jpeg","quality":85},
            "metadata":{"keep":true}}"#,
        &source,
        &[],
    );
    let found = crate::raster_meta::read_sidecars(&out.bytes);
    assert!(found.exif.is_some(), "EXIF was dropped");
    assert_eq!(found.icc.as_deref(), Some(icc.as_slice()));
}

#[test]
fn metadata_is_stripped_by_default() {
    let icc = p3_icc();
    let source = jpeg_source(Some(&icc), Some(EXIF_TIFF));
    let out = run(
        r#"{"v":1,"input":{"kind":"encoded"},"ops":[],"output":{"format":"jpeg","quality":85}}"#,
        &source,
        &[],
    );
    assert!(crate::raster_meta::read_sidecars(&out.bytes).exif.is_none());
}

#[test]
fn an_explicit_orientation_is_written_into_the_exif_block() {
    let source = jpeg_source(None, None);
    let out = run(
        r#"{"v":1,"input":{"kind":"encoded"},"ops":[],
            "output":{"format":"jpeg","quality":85},
            "metadata":{"orientation":6}}"#,
        &source,
        &[],
    );
    let found = crate::raster_meta::read_sidecars(&out.bytes);
    let orientation = found
        .exif
        .as_deref()
        .and_then(crate::raster::exif_orientation_from_block);
    assert_eq!(orientation, Some(6));
}

#[test]
fn a_supplied_icc_from_aux_is_embedded() {
    let icc = p3_icc();
    let recipe = format!(
        r#"{{"v":1,"input":{{"kind":"raw","width":8,"height":8,"channels":3}},"ops":[],
            "output":{{"format":"png"}},
            "metadata":{{"icc":{{"off":0,"len":{}}}}}}}"#,
        icc.len()
    );
    let out = run(&recipe, &vec![120u8; 8 * 8 * 3], &icc);
    assert_eq!(
        crate::raster_meta::read_sidecars(&out.bytes).icc.as_deref(),
        Some(icc.as_slice())
    );
}

#[test]
fn an_orientation_rewrite_survives_a_kept_exif_block() {
    let source = jpeg_source(None, Some(EXIF_TIFF));
    let out = run(
        r#"{"v":1,"input":{"kind":"encoded"},"ops":[],
            "output":{"format":"jpeg","quality":85},
            "metadata":{"keep":true,"orientation":8}}"#,
        &source,
        &[],
    );
    let found = crate::raster_meta::read_sidecars(&out.bytes);
    let orientation = found
        .exif
        .as_deref()
        .and_then(crate::raster::exif_orientation_from_block);
    assert_eq!(orientation, Some(8));
}

#[test]
fn metadata_survives_an_op_and_a_format_change() {
    // The input is a JPEG (can't carry alpha); the output is a resized
    // PNG. `keep` must still surface the JPEG's own EXIF/ICC in the PNG.
    let icc = p3_icc();
    let source = jpeg_source(Some(&icc), Some(EXIF_TIFF));
    let out = run(
        r#"{"v":1,"input":{"kind":"encoded"},
            "ops":[{"op":"resize","width":2,"height":2,"fit":"fill"}],
            "output":{"format":"png"},
            "metadata":{"keep":true}}"#,
        &source,
        &[],
    );
    let found = crate::raster_meta::read_sidecars(&out.bytes);
    assert!(found.exif.is_some(), "EXIF was dropped across the resize");
    assert_eq!(found.icc.as_deref(), Some(icc.as_slice()));
}

// ---- fix-round-1, item 1: unsupported-but-requested metadata errors ----

/// `avif`-gated: Maple's WebP encoder lives in the `raster_encode_avif`
/// module, so a WebP output is a named error without the feature (#3506 F6)
/// — the capability question this test is about only arises once there IS
/// an encoder to reach.
#[cfg(feature = "avif")]
#[test]
fn keep_with_no_xmp_in_the_input_is_fine_for_webp() {
    // "For keep: true, only fields that are actually PRESENT in the
    // input count as requested" — this JPEG source carries no XMP, so a
    // WebP output (which can't carry XMP at all) must still succeed.
    let icc = p3_icc();
    let source = jpeg_source(Some(&icc), Some(EXIF_TIFF));
    let out = run(
        r#"{"v":1,"input":{"kind":"encoded"},"ops":[],
            "output":{"format":"webp"},
            "metadata":{"keep":true}}"#,
        &source,
        &[],
    );
    assert_eq!(
        crate::raster_meta::read_sidecars(&out.bytes).icc.as_deref(),
        Some(icc.as_slice())
    );
}

#[test]
fn a_supplied_xmp_to_webp_is_a_named_error() {
    let xmp = b"<x:xmpmeta/>".to_vec();
    let err = run_err(
        &format!(
            r#"{{"v":1,"input":{{"kind":"encoded"}},"ops":[],
                "output":{{"format":"webp"}},
                "metadata":{{"xmp":{{"off":0,"len":{}}}}}}}"#,
            xmp.len()
        ),
        &jpeg_source(None, None),
        &xmp,
    );
    assert!(
        format!("{err}").contains("WebP cannot embed XMP"),
        "got: {err}"
    );
}

#[test]
fn a_density_request_to_tiff_is_a_named_error() {
    let err = run_err(
        r#"{"v":1,"input":{"kind":"encoded"},"ops":[],
            "output":{"format":"tiff"},
            "metadata":{"density":300.0}}"#,
        &jpeg_source(None, None),
        &[],
    );
    assert!(
        format!("{err}").contains("TIFF cannot embed a pixel density"),
        "got: {err}"
    );
}

#[test]
fn a_kept_exif_block_sent_to_tiff_is_dropped_silently() {
    // `keep` sweeps up every block the input carries, so holding the target
    // container to one the caller never named turned a call sharp completes
    // into an error naming a field nobody mentioned (#3507 final fix wave,
    // item 6; measured: sharp's own `keepMetadata().tiff()` on this shape
    // of source succeeds, writing ICC and XMP and no EXIF). The TIFF
    // encoder here has no EXIF setter at all, so the block is dropped.
    let out = run(
        r#"{"v":1,"input":{"kind":"encoded"},"ops":[],
            "output":{"format":"tiff"},
            "metadata":{"keep":true}}"#,
        &jpeg_source(None, Some(EXIF_TIFF)),
        &[],
    );
    assert!(crate::raster_meta::read_sidecars(&out.bytes).exif.is_none());
}

#[test]
fn an_explicitly_supplied_exif_block_sent_to_tiff_is_still_a_named_error() {
    let recipe = format!(
        r#"{{"v":1,"input":{{"kind":"encoded"}},"ops":[],
            "output":{{"format":"tiff"}},
            "metadata":{{"exif":{{"off":0,"len":{}}}}}}}"#,
        EXIF_TIFF.len()
    );
    let err = run_err(&recipe, &jpeg_source(None, None), EXIF_TIFF);
    assert!(
        format!("{err}").contains("TIFF cannot embed EXIF"),
        "got: {err}"
    );
}

#[test]
fn an_orientation_only_metadata_block_reaches_tiff_without_erroring() {
    // `withMetadata({orientation:5})` synthesises an EXIF block to carry
    // the value, which is not a named EXIF request either — sharp writes
    // the orientation into the TIFF's own IFD and succeeds, so erroring
    // here would fail a call that works everywhere else.
    let out = run(
        r#"{"v":1,"input":{"kind":"encoded"},"ops":[],
            "output":{"format":"tiff"},
            "metadata":{"keep":true,"orientation":5}}"#,
        &jpeg_source(None, Some(EXIF_TIFF)),
        &[],
    );
    assert!(!out.bytes.is_empty());
}

// ---- fix-round-1, item 3: autoOrient neutralises a kept Orientation ----

/// A JPEG with `exif` spliced in, mirroring `jpeg_source` but with a
/// non-empty pixel grid so a 90-degree autoOrient rotation is visible.
fn oriented_jpeg_source(width: u32, height: u32, exif: &[u8]) -> Vec<u8> {
    let base = crate::jpeg::encode(
        width,
        height,
        &vec![90u8; (width * height * 3) as usize],
        90,
    )
    .unwrap();
    let mut payload = b"Exif\0\0".to_vec();
    payload.extend_from_slice(exif);
    let mut segment = vec![0xFFu8, 0xE1];
    segment.extend_from_slice(&((payload.len() + 2) as u16).to_be_bytes());
    segment.extend_from_slice(&payload);
    let mut out = base[..2].to_vec();
    out.extend_from_slice(&segment);
    out.extend_from_slice(&base[2..]);
    out
}

/// A minimal IFD0 with a single Orientation entry set to `value`.
fn exif_with_orientation(value: u16) -> Vec<u8> {
    let mut tiff = vec![0u8; 26];
    tiff[..2].copy_from_slice(b"II");
    tiff[2..4].copy_from_slice(&42u16.to_le_bytes());
    tiff[4..8].copy_from_slice(&8u32.to_le_bytes());
    tiff[8..10].copy_from_slice(&1u16.to_le_bytes());
    tiff[10..12].copy_from_slice(&0x0112u16.to_le_bytes());
    tiff[12..14].copy_from_slice(&3u16.to_le_bytes());
    tiff[14..18].copy_from_slice(&1u32.to_le_bytes());
    tiff[18..20].copy_from_slice(&value.to_le_bytes());
    tiff
}

#[test]
fn auto_orient_neutralises_a_kept_orientation_end_to_end() {
    // Measured against sharp: sharp(oriented6).rotate().withMetadata()
    // .jpeg() -> metadata().orientation === 1 (not undefined — the EXIF
    // block itself survives).
    let source = oriented_jpeg_source(8, 4, &exif_with_orientation(6));
    let out = run(
        r#"{"v":1,"input":{"kind":"encoded"},
            "ops":[{"op":"autoOrient"}],
            "output":{"format":"jpeg","quality":85},
            "metadata":{"keep":true}}"#,
        &source,
        &[],
    );
    let found = crate::raster_meta::read_sidecars(&out.bytes);
    assert!(found.exif.is_some(), "the EXIF block itself must survive");
    let orientation = found
        .exif
        .as_deref()
        .and_then(crate::raster::exif_orientation_from_block);
    assert_eq!(orientation, Some(1));
    // A 90-degree rotation (Orientation 6) really did run: the pixel
    // dimensions are swapped from the source's own 8x4.
    assert_eq!((out.width, out.height), (4, 8));
}

#[test]
fn an_explicit_orientation_still_wins_after_auto_orient_end_to_end() {
    // Measured: sharp(oriented6).rotate().withMetadata({orientation:6})
    // .jpeg() -> metadata().orientation === 6.
    let source = oriented_jpeg_source(8, 4, &exif_with_orientation(6));
    let out = run(
        r#"{"v":1,"input":{"kind":"encoded"},
            "ops":[{"op":"autoOrient"}],
            "output":{"format":"jpeg","quality":85},
            "metadata":{"keep":true,"orientation":6}}"#,
        &source,
        &[],
    );
    let found = crate::raster_meta::read_sidecars(&out.bytes);
    let orientation = found
        .exif
        .as_deref()
        .and_then(crate::raster::exif_orientation_from_block);
    assert_eq!(orientation, Some(6));
}

// ---- fix-round-2: keep's default-fill ICC is not a "request" on AVIF ----

#[cfg(feature = "avif")]
#[test]
fn keep_with_no_input_icc_succeeds_on_avif_with_no_icc_embedded() {
    // Ruling: the sRGB default-fill `keep: true` adds when the input has no
    // ICC is a convenience, not a caller request — on AVIF (which this
    // crate's encoder can't tag with ICC at all, #3580) that default must be
    // skipped silently, matching sharp: keep-metadata on a no-ICC source
    // converted to AVIF still succeeds.
    let source = jpeg_source(None, None); // no ICC in the input at all
    let out = run(
        r#"{"v":1,"input":{"kind":"encoded"},"ops":[],
            "output":{"format":"avif","quality":60,"effort":8},
            "metadata":{"keep":true}}"#,
        &source,
        &[],
    );
    assert!(
        crate::raster_meta::read_sidecars(&out.bytes).icc.is_none(),
        "AVIF has no ICC box to read back — the default fill must not have \
         been forced in some other way"
    );
}

/// `avif`-gated: without the feature `output_from_wire` rejects an AVIF
/// output before the capability gate ever runs (#3506 F5), so the error
/// names the missing feature rather than the ICC box.
#[cfg(feature = "avif")]
#[test]
fn keep_with_a_real_input_icc_to_avif_drops_it_silently() {
    // Swept up by `keep`, not named by the caller — so on AVIF (which this
    // crate's encoder can't tag with ICC at all, #3580) it goes the same
    // way as the default fill above: dropped, not an error. sharp's own
    // `keepMetadata().avif()` on this source succeeds (#3507 final fix
    // wave, item 6).
    let icc = p3_icc();
    let source = jpeg_source(Some(&icc), None);
    let out = run(
        r#"{"v":1,"input":{"kind":"encoded"},"ops":[],
            "output":{"format":"avif","quality":60,"effort":8},
            "metadata":{"keep":true}}"#,
        &source,
        &[],
    );
    assert!(crate::raster_meta::read_sidecars(&out.bytes).icc.is_none());
}

/// `avif`-gated: without the feature `output_from_wire` rejects an AVIF
/// output before the capability gate ever runs (#3506 F5), so the error
/// names the missing feature rather than the ICC box.
#[cfg(feature = "avif")]
#[test]
fn an_explicit_icc_to_avif_is_a_named_error() {
    let icc = p3_icc();
    let source = jpeg_source(None, None);
    let recipe = format!(
        r#"{{"v":1,"input":{{"kind":"encoded"}},"ops":[],
            "output":{{"format":"avif","quality":60,"effort":8}},
            "metadata":{{"icc":{{"off":0,"len":{}}}}}}}"#,
        icc.len()
    );
    let err = run_err(&recipe, &source, &icc);
    assert!(
        format!("{err}").contains("AVIF cannot embed an ICC profile"),
        "got: {err}"
    );
}
