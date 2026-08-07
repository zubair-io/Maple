//! Unit tests for the `.cube` parser, `.mlut` emit, and display-name
//! derivation (epic #2683, Task 5a). Split from `film_pack.rs` per the
//! repo's file-size-budget convention. `super` is `commands::film_pack`.

#![cfg(test)]

use super::*;

// ---- parse_cube: happy path ----------------------------------------------

/// A tiny 2³ cube: 8 triples, red-fastest order. Exercises TITLE, both
/// DOMAIN lines, a comment, and a blank line alongside real data rows.
const TINY_CUBE_2: &str = "\
TITLE \"tiny (Maple 2)\"

# a comment
LUT_3D_SIZE 2
DOMAIN_MIN 0.0 0.0 0.0
DOMAIN_MAX 1.0 1.0 1.0

0.0 0.0 0.0
1.0 0.0 0.0
0.0 1.0 0.0
1.0 1.0 0.0
0.0 0.0 1.0
1.0 0.0 1.0
0.0 1.0 1.0
1.0 1.0 1.0
";

#[test]
fn parse_cube_happy_path_2_cubed() {
    let cube = parse_cube(TINY_CUBE_2, "tiny.cube").expect("should parse");
    assert_eq!(cube.size, 2);
    assert_eq!(cube.data.len(), 2 * 2 * 2 * 3);
    // First triple (r=0,g=0,b=0) and last (r=1,g=1,b=1) per the
    // red-fastest, ((b*N+g)*N+r)*3+c layout `.mlut` also expects.
    assert_eq!(&cube.data[0..3], &[0.0, 0.0, 0.0]);
    assert_eq!(&cube.data[21..24], &[1.0, 1.0, 1.0]);
}

#[test]
fn parse_cube_ignores_comments_and_blank_lines() {
    // TINY_CUBE_2 already interleaves a `#` comment and blank lines with
    // the directives/data; a successful parse above covers this, but
    // assert explicitly that comment-only content doesn't leak into data.
    let cube = parse_cube(TINY_CUBE_2, "tiny.cube").expect("should parse");
    assert_eq!(cube.data.len(), 24);
}

// ---- parse_cube: rejections ------------------------------------------------

#[test]
fn parse_cube_rejects_wrong_row_count_for_declared_size() {
    let bad = "\
LUT_3D_SIZE 2
0.0 0.0 0.0
1.0 0.0 0.0
";
    let err = parse_cube(bad, "bad.cube").expect_err("should reject short data");
    assert!(err.contains("bad.cube"), "error should carry file context: {err}");
    assert!(
        err.contains("8") && err.contains('2'),
        "error should report expected vs found triples: {err}"
    );
}

#[test]
fn parse_cube_rejects_malformed_row() {
    let bad = "\
LUT_3D_SIZE 2
0.0 0.0 0.0
1.0 not-a-number 0.0
0.0 1.0 0.0
1.0 1.0 0.0
0.0 0.0 1.0
1.0 0.0 1.0
0.0 1.0 1.0
1.0 1.0 1.0
";
    let err = parse_cube(bad, "bad.cube").expect_err("should reject malformed row");
    assert!(err.contains("bad.cube:3"), "error should point at line 3: {err}");
}

#[test]
fn parse_cube_rejects_non_finite_value() {
    let bad = "\
LUT_3D_SIZE 2
0.0 0.0 0.0
1.0 NaN 0.0
0.0 1.0 0.0
1.0 1.0 0.0
0.0 0.0 1.0
1.0 0.0 1.0
0.0 1.0 1.0
1.0 1.0 1.0
";
    let err = parse_cube(bad, "bad.cube").expect_err("should reject non-finite value");
    assert!(err.contains("bad.cube:3"), "error should point at line 3: {err}");
}

#[test]
fn parse_cube_rejects_missing_size() {
    let bad = "0.0 0.0 0.0\n";
    let err = parse_cube(bad, "bad.cube").expect_err("should reject missing LUT_3D_SIZE");
    assert!(err.contains("LUT_3D_SIZE"), "error should name the missing directive: {err}");
}

#[test]
fn parse_cube_rejects_unsupported_domain() {
    let bad = "\
LUT_3D_SIZE 2
DOMAIN_MIN 0.0 0.0 0.0
DOMAIN_MAX 2.0 1.0 1.0
0.0 0.0 0.0
1.0 0.0 0.0
0.0 1.0 0.0
1.0 1.0 0.0
0.0 0.0 1.0
1.0 0.0 1.0
0.0 1.0 1.0
1.0 1.0 1.0
";
    let err = parse_cube(bad, "bad.cube").expect_err("should reject a non 0..1 domain");
    assert!(err.contains("domain"), "error should name the domain problem: {err}");
    // Line context: DOMAIN_MAX (the offending directive) is on line 3.
    assert!(
        err.contains("bad.cube:3"),
        "error should carry the offending DOMAIN directive's line: {err}"
    );
}

#[test]
fn parse_cube_domain_error_points_at_domain_min_when_min_is_the_offender() {
    let bad = "\
LUT_3D_SIZE 2
DOMAIN_MIN -1.0 0.0 0.0
DOMAIN_MAX 1.0 1.0 1.0
0.0 0.0 0.0
1.0 0.0 0.0
0.0 1.0 0.0
1.0 1.0 0.0
0.0 0.0 1.0
1.0 0.0 1.0
0.0 1.0 1.0
1.0 1.0 1.0
";
    let err = parse_cube(bad, "bad.cube").expect_err("should reject a non 0..1 domain");
    assert!(
        err.contains("bad.cube:2"),
        "error should carry DOMAIN_MIN's line when MIN is out of range: {err}"
    );
}

#[test]
fn strip_keyword_requires_trailing_whitespace_not_a_prefix_match() {
    // A look-alike directive name must not be misrouted into TITLE's
    // parse branch (or LUT_3D_SIZE's) just because it starts with the
    // same characters.
    assert!(strip_keyword("TITLED foo", "TITLE").is_none());
    assert!(strip_keyword("TITLE \"x\"", "TITLE").is_some());
    assert!(strip_keyword("LUT_3D_SIZEX 2", "LUT_3D_SIZE").is_none());
    assert!(strip_keyword("LUT_3D_SIZE 2", "LUT_3D_SIZE").is_some());
}

// ---- round-trip through raw_core::film::encode_mlut/decode_mlut ----------

#[test]
fn parsed_cube_round_trips_through_mlut_codec() {
    let cube = parse_cube(TINY_CUBE_2, "tiny.cube").expect("should parse");
    let bytes = raw_core::film::encode_mlut(cube.size, &cube.data);
    let decoded = raw_core::film::decode_mlut(&bytes).expect("should decode");
    assert_eq!(decoded.size, cube.size);
    for (a, b) in decoded.data.iter().zip(cube.data.iter()) {
        assert!((a - b).abs() < 1e-3, "f16 round-trip drift too large: {a} vs {b}");
    }
}

// ---- display-name derivation ----------------------------------------------

#[test]
fn derive_name_basic_override() {
    assert_eq!(derive_name("ilford_hp_5"), "Ilford HP 5");
}

#[test]
fn derive_name_plain_words_default_titlecase() {
    assert_eq!(derive_name("kodak_portra_400"), "Kodak Portra 400");
}

#[test]
fn derive_name_numbers_verbatim() {
    assert_eq!(derive_name("agfa_apx_25"), "Agfa APX 25");
}

#[test]
fn derive_name_multiple_overrides() {
    assert_eq!(
        derive_name("kodak_e_100_gx_ektachrome_100"),
        "Kodak E 100 GX Ektachrome 100"
    );
    assert_eq!(derive_name("kodak_t_max_100"), "Kodak T Max 100");
    assert_eq!(derive_name("kodak_portra_160_nc"), "Kodak Portra 160 NC");
    assert_eq!(derive_name("kodak_elite_100_xpro"), "Kodak Elite 100 XPro");
}

#[test]
fn derive_name_bw_cn_overrides() {
    assert_eq!(derive_name("kodak_bw_400_cn"), "Kodak BW 400 CN");
}

#[test]
fn derive_name_px_override() {
    assert_eq!(derive_name("polaroid_px_680"), "Polaroid PX 680");
}

#[test]
fn derive_name_digit_then_trailing_letter_suffix_uppercases_letter_only() {
    assert_eq!(derive_name("fuji_astia_100f"), "Fuji Astia 100F");
    assert_eq!(derive_name("fuji_800z"), "Fuji 800Z");
    assert_eq!(derive_name("kodak_portra_160_vc"), "Kodak Portra 160 VC");
    assert_eq!(derive_name("fuji_provia_400x"), "Fuji Provia 400X");
    assert_eq!(derive_name("polaroid_px_100uv_cold"), "Polaroid PX 100UV Cold");
}

#[test]
fn derive_name_pure_digit_token_stays_verbatim() {
    assert_eq!(derive_name("agfa_precisa_100"), "Agfa Precisa 100");
    assert_eq!(derive_name("kodak_kodachrome_25"), "Kodak Kodachrome 25");
}

#[test]
fn strip_category_prefix_removes_only_leading_match() {
    assert_eq!(
        strip_category_prefix("color_negative_kodak_portra_400", "color_negative"),
        "kodak_portra_400"
    );
    // No matching prefix: returned unchanged rather than mangled.
    assert_eq!(strip_category_prefix("kodak_portra_400", "slide"), "kodak_portra_400");
}

// ---- catalog emission ------------------------------------------------------

#[test]
fn emit_catalog_is_deterministic_and_sorted() {
    let entries = vec![
        CatalogEntry {
            category: FilmCategory::Slide,
            id: "slide_fuji_velvia_50".to_string(),
            name: "Fuji Velvia 50".to_string(),
        },
        CatalogEntry {
            category: FilmCategory::BlackWhite,
            id: "black_white_ilford_hp_5_plus_400".to_string(),
            name: "Ilford HP 5 Plus 400".to_string(),
        },
    ];
    let src = emit_catalog(&entries);
    assert!(src.contains("GENERATED by `maple-cli film-pack`"));
    assert!(src.contains("pub enum FilmCategory"));
    assert!(src.contains("pub struct FilmLookEntry"));
    assert!(src.contains("pub static FILM_CATALOG"));
    assert!(src.contains(
        "FilmLookEntry { id: \"black_white_ilford_hp_5_plus_400\", \
         name: \"Ilford HP 5 Plus 400\", category: FilmCategory::BlackWhite }"
    ));
    assert!(src.contains(
        "FilmLookEntry { id: \"slide_fuji_velvia_50\", name: \"Fuji Velvia 50\", \
         category: FilmCategory::Slide }"
    ));

    // Byte-stable across re-runs on the same input.
    let src2 = emit_catalog(&entries);
    assert_eq!(src, src2);
}

#[test]
fn film_category_ordering_matches_alphabetical_directory_order() {
    let mut cats = vec![
        FilmCategory::Slide,
        FilmCategory::BlackWhite,
        FilmCategory::Instant,
        FilmCategory::ColorNegative,
    ];
    cats.sort();
    assert_eq!(
        cats,
        vec![
            FilmCategory::BlackWhite,
            FilmCategory::ColorNegative,
            FilmCategory::Instant,
            FilmCategory::Slide,
        ]
    );
}

// ---- real-pack verifications (fixture-gated: skip when the committed ----
// ---- resources/film-luts pack is absent) ----------------------------------

fn repo_root() -> std::path::PathBuf {
    // CARGO_MANIFEST_DIR is `<repo>/src/raw-pipeline/maple-cli`.
    std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../..")
        .canonicalize()
        .expect("repo root should resolve")
}

#[test]
fn ingested_pack_has_exactly_100_looks_of_the_expected_size() {
    let luts_dir = repo_root().join("resources/film-luts");
    if !luts_dir.is_dir() {
        eprintln!("skipping: {} not present", luts_dir.display());
        return;
    }
    let files: Vec<_> = std::fs::read_dir(&luts_dir)
        .expect("should read resources/film-luts")
        .filter_map(|e| e.ok())
        .filter(|e| e.path().extension().and_then(|x| x.to_str()) == Some("mlut"))
        .collect();
    assert_eq!(files.len(), 100, "expected exactly 100 .mlut files");
    for entry in &files {
        let len = entry.metadata().expect("metadata").len();
        // Header(8) + 33^3 * 3 * 2 bytes (f16) = 8 + 215,622 = 215,630 bytes,
        // i.e. ~210.6 KiB / ~216 KB. Allow slack for filesystem block
        // rounding differences across platforms — check the exact byte
        // count directly instead.
        assert_eq!(
            len,
            8 + 33 * 33 * 33 * 3 * 2,
            "{} has unexpected size {len}",
            entry.path().display()
        );
    }
}

#[test]
fn film_catalog_has_exactly_100_entries() {
    assert_eq!(
        raw_core::film_catalog::FILM_CATALOG.len(),
        100,
        "FILM_CATALOG should have exactly 100 entries once the pack is ingested \
         (this test intentionally does NOT skip: film_catalog.rs is committed \
         source, not a fixture)"
    );
}

#[test]
fn portra_400_spot_check_matches_source_cube_first_and_last_triples() {
    let luts_dir = repo_root().join("resources/film-luts");
    let mlut_path = luts_dir.join("color_negative_kodak_portra_400.mlut");
    if !mlut_path.is_file() {
        eprintln!("skipping: {} not present", mlut_path.display());
        return;
    }
    let bytes = std::fs::read(&mlut_path).expect("should read the mlut");
    let decoded = raw_core::film::decode_mlut(&bytes).expect("should decode");
    assert_eq!(decoded.size, 33);

    // Known first/last triples of
    // color_negative/color_negative_kodak_portra_400.cube in the source
    // pack (see the ingest brief for provenance).
    let first = [0.028550286f32, 0.036040645, 0.035365429];
    let last = [0.973810613f32, 0.975828350, 0.972427905];

    let n = decoded.data.len();
    assert!(n >= 6, "decoded data too short");
    for c in 0..3 {
        assert!(
            (decoded.data[c] - first[c]).abs() < 5e-3,
            "first triple[{c}]: {} vs {}",
            decoded.data[c],
            first[c]
        );
        assert!(
            (decoded.data[n - 3 + c] - last[c]).abs() < 5e-3,
            "last triple[{c}]: {} vs {}",
            decoded.data[n - 3 + c],
            last[c]
        );
    }
}
