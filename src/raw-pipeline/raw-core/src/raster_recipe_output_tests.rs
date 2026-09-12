//! Tests for [`super`]'s wire `Output` schema and its translation into
//! `raster_encode::RasterOutput`, in a sibling file (the `#[path]` pattern
//! `raster_encode_jpeg.rs`/`raster_encode_png.rs`/`raster_encode_tiff.rs`/
//! `raster_encode_avif.rs` already use) so the schema module itself stays
//! inside the file-size budget.

use super::*;
use crate::raster_recipe::parse_recipe;

fn output_json(body: &str) -> String {
    format!(r#"{{"v":1,"input":{{"kind":"encoded"}},"ops":[],"output":{body}}}"#)
}

#[test]
fn jpeg_defaults_match_sharp() {
    let r = parse_recipe(&output_json(r#"{"format":"jpeg"}"#)).unwrap();
    match r.output {
        Output::Jpeg {
            quality,
            progressive,
            chroma_subsampling,
            optimise_coding,
        } => {
            assert_eq!(quality, 80);
            assert!(!progressive);
            assert_eq!(chroma_subsampling, "4:2:0");
            assert!(optimise_coding);
        }
        other => panic!("expected a jpeg output, got {other:?}"),
    }
}

#[test]
fn png_defaults_match_sharp() {
    let r = parse_recipe(&output_json(r#"{"format":"png"}"#)).unwrap();
    match r.output {
        Output::Png {
            compression_level,
            adaptive_filtering,
            palette,
            colours,
            dither,
        } => {
            assert_eq!(compression_level, 6);
            assert!(!adaptive_filtering);
            assert!(!palette);
            assert_eq!(colours, 256);
            assert_eq!(dither, 1.0);
        }
        other => panic!("expected a png output, got {other:?}"),
    }
}

#[test]
fn avif_defaults_match_sharp() {
    let r = parse_recipe(&output_json(r#"{"format":"avif"}"#)).unwrap();
    match r.output {
        Output::Avif {
            quality,
            effort,
            lossless,
            chroma_subsampling,
            bitdepth,
        } => {
            assert_eq!(quality, 50);
            assert_eq!(effort, 4);
            assert!(!lossless);
            assert_eq!(chroma_subsampling, "4:4:4");
            // 8, not ravif's own `BitDepth::Auto` (= 10): a 10-bit AVIF
            // is undecodable by libheif's prebuilt decoders, and 8 is
            // sharp's `heif()` default too.
            assert_eq!(bitdepth, 8);
        }
        other => panic!("expected an avif output, got {other:?}"),
    }
}

#[test]
fn tiff_defaults_match_sharp() {
    let r = parse_recipe(&output_json(r#"{"format":"tiff"}"#)).unwrap();
    match r.output {
        Output::Tiff {
            compression,
            bitdepth,
            predictor,
        } => {
            assert_eq!(compression, "lzw");
            assert_eq!(bitdepth, 8);
            assert_eq!(predictor, "horizontal");
        }
        other => panic!("expected a tiff output, got {other:?}"),
    }
}

/// `output_from_wire` must translate both real sharp predictor strings
/// into the encoder's bool, in each direction — not just accept the
/// default.
#[test]
fn tiff_predictor_horizontal_and_none_translate_to_the_encoders_bool() {
    for (wire, expected) in [("horizontal", true), ("none", false)] {
        let r = parse_recipe(&output_json(&format!(
            r#"{{"format":"tiff","predictor":"{wire}"}}"#
        )))
        .unwrap();
        match output_from_wire(&r.output).unwrap() {
            RasterOutput::Tiff(opts) => {
                assert_eq!(opts.predictor, expected, "predictor '{wire}'");
            }
            other => panic!("expected a tiff RasterOutput, got {other:?}"),
        }
    }
}

/// `"float"` is a real sharp predictor value the `tiff` crate's encoder
/// cannot produce (see `raster_encode_tiff.rs`'s module doc) — it must be
/// a named rejection, not silently mapped to `horizontal` or `none`.
#[test]
fn an_unsupported_tiff_predictor_is_named() {
    let r = parse_recipe(&output_json(r#"{"format":"tiff","predictor":"float"}"#)).unwrap();
    let err = output_from_wire(&r.output).unwrap_err();
    assert!(format!("{err}").contains("float"), "got: {err}");
}

/// sharp defaults TIFF `compression` to `'jpeg'`, which Maple has no
/// encoder for (no JPEG-in-TIFF path — see the README's parity note).
/// F5 already rejects it via the generic "not one of the four
/// supported compressors" path; this pins that `'jpeg'` specifically
/// stays a named rejection rather than silently falling back to `lzw`.
#[test]
fn tiff_compression_jpeg_is_a_named_rejection() {
    let r = parse_recipe(&output_json(r#"{"format":"tiff","compression":"jpeg"}"#)).unwrap();
    let err = output_from_wire(&r.output).unwrap_err();
    assert!(format!("{err}").contains("jpeg"), "got: {err}");
}

/// End-to-end through `run_recipe`: the wire predictor string must
/// actually flip tag 317 in the encoded bytes, not just translate
/// correctly at the `output_from_wire` layer.
#[test]
fn tiff_predictor_wire_string_reaches_tag_317() {
    use crate::raster_recipe_exec::run_recipe;

    let pixels: Vec<u8> = (0..(8 * 8 * 3)).map(|i| (i % 251) as u8).collect();
    for (wire, expected_tag) in [("horizontal", 2u16), ("none", 1u16)] {
        let recipe = parse_recipe(&format!(
            r#"{{"v":1,"input":{{"kind":"raw","width":8,"height":8,"channels":3}},"ops":[],"output":{{"format":"tiff","predictor":"{wire}"}}}}"#
        ))
        .unwrap();
        let result = run_recipe(&recipe, &pixels, &[]).unwrap();
        let mut decoder = tiff::decoder::Decoder::new(std::io::Cursor::new(&result.bytes)).unwrap();
        let tag: u16 = decoder
            .get_tag_unsigned(tiff::tags::Tag::Predictor)
            .unwrap();
        assert_eq!(
            tag, expected_tag,
            "predictor '{wire}' wrote the wrong tag 317"
        );
    }
}

#[test]
fn webp_defaults_to_lossless() {
    let r = parse_recipe(&output_json(r#"{"format":"webp"}"#)).unwrap();
    assert!(matches!(r.output, Output::Webp { lossless: true }));
}

/// Every variant of `Output` — the empty-struct `Raw` included — must
/// reject a stray key, mirroring `raster_recipe`'s own table for `Op`
/// and `RecipeInput` (#3505 fix-round-2's rule applies to every recipe
/// enum, not just the ones that existed when that fix landed).
#[test]
fn every_output_variant_rejects_a_stray_key() {
    let cases: &[(&str, &str)] = &[
        ("jpeg", r#"{"format":"jpeg","zzzStray":1}"#),
        ("png", r#"{"format":"png","zzzStray":1}"#),
        ("webp", r#"{"format":"webp","zzzStray":1}"#),
        ("avif", r#"{"format":"avif","zzzStray":1}"#),
        ("tiff", r#"{"format":"tiff","zzzStray":1}"#),
        ("raw", r#"{"format":"raw","zzzStray":1}"#),
    ];
    for (variant, body) in cases {
        let err = match parse_recipe(&output_json(body)) {
            Err(e) => e,
            Ok(_) => panic!("output:{variant} silently accepted a stray key"),
        };
        assert!(
            format!("{err}").contains("zzzStray"),
            "output:{variant}: expected the error to name zzzStray, got: {err}"
        );
    }
}

/// Out-of-range numerics must name the option and its range, the way sharp's
/// own `is.invalidParameterError` does. The wire fields are `u16` — wider
/// than the `u8` the encoders take — precisely so `quality: 500` reaches this
/// check rather than producing serde's "invalid value: integer 500, expected
/// u8 at line 1 column 186", which names neither the option nor a bound.
#[test]
fn out_of_range_numerics_are_named_with_their_range() {
    let cases: &[(&str, &str, &str)] = &[
        (
            r#"{"format":"jpeg","quality":0}"#,
            "quality",
            "between 1 and 100",
        ),
        (
            r#"{"format":"jpeg","quality":500}"#,
            "quality",
            "between 1 and 100",
        ),
        (
            r#"{"format":"png","compressionLevel":42}"#,
            "compressionLevel",
            "between 0 and 9",
        ),
        (
            r#"{"format":"png","colours":999}"#,
            "colours",
            "between 2 and 256",
        ),
        (
            r#"{"format":"png","colours":1}"#,
            "colours",
            "between 2 and 256",
        ),
    ];
    for (body, field, range) in cases {
        let recipe = parse_recipe(&output_json(body)).unwrap();
        let err =
            output_from_wire(&recipe.output).expect_err(&format!("{body} was silently accepted"));
        let message = format!("{err}");
        assert!(message.contains(field), "{body}: got {message}");
        assert!(message.contains(range), "{body}: got {message}");
    }
}

/// AVIF's two numerics live behind the feature gate, so they get their own
/// case rather than sitting in the table above.
#[cfg(feature = "avif")]
#[test]
fn out_of_range_avif_numerics_are_named() {
    for (body, field) in [
        (r#"{"format":"avif","effort":99}"#, "effort"),
        (r#"{"format":"avif","quality":0}"#, "quality"),
    ] {
        let recipe = parse_recipe(&output_json(body)).unwrap();
        let err = output_from_wire(&recipe.output).expect_err(&format!("{body} was accepted"));
        assert!(format!("{err}").contains(field), "{body}: got {err}");
    }
}

#[test]
fn an_unsupported_jpeg_chroma_subsampling_is_named() {
    let r = parse_recipe(&output_json(
        r#"{"format":"jpeg","chromaSubsampling":"4:1:1"}"#,
    ))
    .unwrap();
    let err = output_from_wire(&r.output).unwrap_err();
    assert!(format!("{err}").contains("4:1:1"), "got: {err}");
}

#[test]
fn an_unsupported_tiff_compression_is_named() {
    let r = parse_recipe(&output_json(r#"{"format":"tiff","compression":"zstd"}"#)).unwrap();
    let err = output_from_wire(&r.output).unwrap_err();
    assert!(format!("{err}").contains("zstd"), "got: {err}");
}

/// `bitdepth` is checked inside `encode_tiff_opts`/`bit_depth_for`, not by
/// `output_from_wire` (the comment on the `Output::Tiff` arm explains why:
/// 8/16 has a gap a range check would have to allow), so this has to run the
/// full recipe rather than call `output_from_wire` directly.
///
/// `bitdepth` is `u16` on the wire specifically so a value outside `u8`'s
/// range reaches that "not supported (8 or 16)" message intact. Before
/// widening the field all the way through, `output_from_wire` narrowed it
/// with `u8::try_from(300).unwrap_or(u8::MAX)`, so the message quoted 255 —
/// a value the caller never sent — instead of 300.
#[test]
fn an_out_of_range_tiff_bitdepth_names_the_value_the_caller_sent() {
    use crate::raster_recipe_exec::run_recipe;

    let pixels: Vec<u8> = (0..(4 * 4 * 3)).map(|i| (i % 251) as u8).collect();
    let recipe = parse_recipe(&format!(
        r#"{{"v":1,"input":{{"kind":"raw","width":4,"height":4,"channels":3}},"ops":[],"output":{{"format":"tiff","bitdepth":300}}}}"#
    ))
    .unwrap();
    let err = run_recipe(&recipe, &pixels, &[]).unwrap_err();
    let message = format!("{err}");
    assert!(message.contains("300"), "got: {message}");
    assert!(!message.contains("255"), "got: {message}");
}

/// AVIF's equivalent of the TIFF case above — same
/// `u8::try_from(..).unwrap_or(u8::MAX)` bug (in `bit_depth_for`'s caller),
/// same fix (`bitdepth: u16` all the way from the wire schema through
/// `AvifOptions` to `bit_depth_for`).
#[cfg(feature = "avif")]
#[test]
fn an_out_of_range_avif_bitdepth_names_the_value_the_caller_sent() {
    use crate::raster_recipe_exec::run_recipe;

    let pixels: Vec<u8> = (0..(4 * 4 * 3)).map(|i| (i % 251) as u8).collect();
    let recipe = parse_recipe(&format!(
        r#"{{"v":1,"input":{{"kind":"raw","width":4,"height":4,"channels":3}},"ops":[],"output":{{"format":"avif","bitdepth":300}}}}"#
    ))
    .unwrap();
    let err = run_recipe(&recipe, &pixels, &[]).unwrap_err();
    let message = format!("{err}");
    assert!(message.contains("300"), "got: {message}");
    assert!(!message.contains("255"), "got: {message}");
}

/// End-to-end through `run_recipe`: the wire `bitdepth` must reach the
/// `pixi` box in the encoded file, and 12 — a real sharp value `ravif`
/// cannot produce — must be a named rejection rather than a silent
/// 10-bit file. The default (no key at all) must land on 8: that is the
/// depth libheif's prebuilt decoders can read.
#[cfg(feature = "avif")]
#[test]
fn avif_bitdepth_reaches_the_pixi_box_and_twelve_is_named() {
    use crate::raster_recipe_exec::run_recipe;

    let pixels: Vec<u8> = (0..(16 * 16 * 3)).map(|i| (i % 251) as u8).collect();
    let recipe_json = |body: &str| {
        format!(
            r#"{{"v":1,"input":{{"kind":"raw","width":16,"height":16,"channels":3}},"ops":[],"output":{body}}}"#
        )
    };
    for (body, expected) in [
        (r#"{"format":"avif"}"#, 8u8),
        (r#"{"format":"avif","bitdepth":8}"#, 8),
        (r#"{"format":"avif","bitdepth":10}"#, 10),
    ] {
        let recipe = parse_recipe(&recipe_json(body)).unwrap();
        let bytes = run_recipe(&recipe, &pixels, &[]).unwrap().bytes;
        let at = bytes
            .windows(4)
            .position(|w| w == b"pixi")
            .unwrap_or_else(|| panic!("no pixi box for {body}"));
        let count = bytes[at + 8] as usize;
        let depths = &bytes[at + 9..at + 9 + count];
        assert!(
            depths.iter().all(|&d| d == expected),
            "{body} wrote depths {depths:?}, expected all {expected}"
        );
    }
    let recipe = parse_recipe(&recipe_json(r#"{"format":"avif","bitdepth":12}"#)).unwrap();
    let err = run_recipe(&recipe, &pixels, &[]).unwrap_err();
    assert!(format!("{err}").contains("12"), "got: {err}");
}

#[cfg(feature = "avif")]
#[test]
fn an_unsupported_avif_chroma_subsampling_is_named() {
    let r = parse_recipe(&output_json(
        r#"{"format":"avif","chromaSubsampling":"4:1:1"}"#,
    ))
    .unwrap();
    let err = output_from_wire(&r.output).unwrap_err();
    assert!(format!("{err}").contains("4:1:1"), "got: {err}");
}

/// Without the `avif` feature, AVIF output fails by name rather than
/// failing to compile — `RasterOutput::Avif` simply doesn't exist in
/// that build, so `output_from_wire` must route to the named error
/// instead.
#[cfg(not(feature = "avif"))]
#[test]
fn avif_output_without_the_feature_is_a_named_error() {
    let r = parse_recipe(&output_json(r#"{"format":"avif"}"#)).unwrap();
    let err = output_from_wire(&r.output).unwrap_err();
    assert!(format!("{err}").contains("avif"), "got: {err}");
}
