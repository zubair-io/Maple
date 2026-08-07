//! `maple-cli film-pack` — ingest an external `.cube` film-look pack into
//! the committed `.mlut` binary pack + a generated Rust catalog (epic
//! #2683, Task 5a).
//!
//! The source pack (not part of this repo — lives at an operator-provided
//! path, e.g. a local `MapleCube` checkout) is six category directories of
//! Resolve-style 33³ `.cube` LUTs, one per film stock/print/process look.
//! Each `.cube`'s data is written red-fastest in `((b*N+g)*N+r)*3+c` grid
//! order, which is exactly the `.mlut` payload layout (see `raw_core::film`
//! doc comment) — ingestion is a straight parse-then-`encode_mlut`, no
//! reordering.
//!
//! Output is two things checked into the repo:
//!   * `resources/film-luts/<id>.mlut` — one binary per look, `id` is the
//!     `.cube` file stem (also the `papp:FilmLook` XMP value a sidecar
//!     will carry).
//!   * `src/raw-pipeline/raw-core/src/film_catalog.rs` — a generated
//!     `FILM_CATALOG: &[FilmLookEntry]` table the UI/inspector can list
//!     without touching the filesystem.

use std::fmt::Write as _;
use std::path::{Path, PathBuf};

/// The six top-level category directories in the source cube pack, in the
/// fixed order the generated catalog sorts by.
const CATEGORY_DIRS: &[&str] = &[
    "black_white",
    "cinema_print",
    "color_negative",
    "consumer_vintage",
    "instant",
    "slide",
];

/// Mirrors `film_catalog::FilmCategory` (that copy is generated, this one
/// drives the generation) — same duplication pattern already used between
/// `film.rs`'s and `stages::film_look`'s private test helpers (#2683).
#[derive(Copy, Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
enum FilmCategory {
    BlackWhite,
    CinemaPrint,
    ColorNegative,
    ConsumerVintage,
    Instant,
    Slide,
}

impl FilmCategory {
    fn for_dir(dir: &str) -> Result<Self, String> {
        match dir {
            "black_white" => Ok(Self::BlackWhite),
            "cinema_print" => Ok(Self::CinemaPrint),
            "color_negative" => Ok(Self::ColorNegative),
            "consumer_vintage" => Ok(Self::ConsumerVintage),
            "instant" => Ok(Self::Instant),
            "slide" => Ok(Self::Slide),
            other => Err(format!("film-pack: unknown category directory {other:?}")),
        }
    }

    fn variant_name(self) -> &'static str {
        match self {
            Self::BlackWhite => "BlackWhite",
            Self::CinemaPrint => "CinemaPrint",
            Self::ColorNegative => "ColorNegative",
            Self::ConsumerVintage => "ConsumerVintage",
            Self::Instant => "Instant",
            Self::Slide => "Slide",
        }
    }
}

/// A parsed `.cube` LUT: `size` nodes per axis, `data` the flat
/// `size³·3` grid in the same `((b*N+g)*N+r)*3+c` order `raw_core::film`
/// expects.
#[derive(Debug, PartialEq)]
pub struct CubeLut {
    pub size: usize,
    pub data: Vec<f32>,
}

/// Parse a Resolve-style `.cube` file. `path_display` is used only to give
/// parse errors file+line context.
///
/// Accepts `TITLE "..."`, `LUT_3D_SIZE <n>`, `DOMAIN_MIN`/`DOMAIN_MAX`
/// (must be `0 0 0`/`1 1 1` — the only domain the rest of the pipeline
/// assumes), `#`-comments, blank lines, and exactly `size³` whitespace-
/// separated float triples. Anything else — a malformed row, a
/// non-finite value, a row/triple count mismatch — is rejected with the
/// offending file+line.
pub fn parse_cube(text: &str, path_display: &str) -> Result<CubeLut, String> {
    let mut size: Option<usize> = None;
    let mut domain_min = [0.0f32; 3];
    let mut domain_max = [1.0f32; 3];
    let mut data: Vec<f32> = Vec::new();

    for (i, raw_line) in text.lines().enumerate() {
        let line_no = i + 1;
        let line = raw_line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if let Some(rest) = line.strip_prefix("TITLE") {
            let _ = rest; // Ignored: the display name is derived from the file stem, not TITLE.
            continue;
        }
        if let Some(rest) = line.strip_prefix("LUT_3D_SIZE") {
            let n: usize = rest.trim().parse().map_err(|_| {
                format!("{path_display}:{line_no}: invalid LUT_3D_SIZE {rest:?}")
            })?;
            size = Some(n);
            continue;
        }
        if let Some(rest) = line.strip_prefix("DOMAIN_MIN") {
            domain_min = parse_triple(rest, path_display, line_no)?;
            continue;
        }
        if let Some(rest) = line.strip_prefix("DOMAIN_MAX") {
            domain_max = parse_triple(rest, path_display, line_no)?;
            continue;
        }
        let triple = parse_triple(line, path_display, line_no)?;
        data.extend_from_slice(&triple);
    }

    let size = size.ok_or_else(|| format!("{path_display}: missing LUT_3D_SIZE"))?;
    if domain_min != [0.0, 0.0, 0.0] || domain_max != [1.0, 1.0, 1.0] {
        return Err(format!(
            "{path_display}: unsupported domain {domain_min:?}..{domain_max:?} \
             (only 0 0 0 .. 1 1 1 is supported)"
        ));
    }
    let expected_triples = size * size * size;
    let actual_triples = data.len() / 3;
    if actual_triples != expected_triples {
        return Err(format!(
            "{path_display}: LUT_3D_SIZE {size} declares {expected_triples} triples, \
             found {actual_triples}"
        ));
    }

    Ok(CubeLut { size, data })
}

/// Parse a whitespace-separated `r g b` triple, rejecting non-finite
/// (NaN/±inf) values.
fn parse_triple(s: &str, path_display: &str, line_no: usize) -> Result<[f32; 3], String> {
    let parts: Vec<&str> = s.split_whitespace().collect();
    if parts.len() != 3 {
        return Err(format!(
            "{path_display}:{line_no}: expected 3 whitespace-separated values, found {} ({s:?})",
            parts.len()
        ));
    }
    let mut out = [0.0f32; 3];
    for (i, p) in parts.iter().enumerate() {
        let v: f32 = p
            .parse()
            .map_err(|_| format!("{path_display}:{line_no}: malformed float {p:?}"))?;
        if !v.is_finite() {
            return Err(format!(
                "{path_display}:{line_no}: non-finite value {v} ({p:?})"
            ));
        }
        out[i] = v;
    }
    Ok(out)
}

/// Known acronym/word overrides for display-name title-casing. Anything
/// not listed here gets the default treatment (capitalize the first
/// letter); numeric tokens pass through verbatim either way.
const OVERRIDES: &[(&str, &str)] = &[
    ("hp", "HP"),
    ("nc", "NC"),
    ("vc", "VC"),
    ("ns", "NS"),
    ("apx", "APX"),
    ("xpro", "XPro"),
    ("hg", "HG"),
    ("gx", "GX"),
    ("vs", "VS"),
    ("rsx", "RSX"),
    ("fg", "FG"),
    ("sc", "SC"),
    ("vx", "VX"),
    ("t", "T"),
    ("d", "D"),
    ("e", "E"),
];

fn title_case_token(token: &str) -> String {
    if let Some((_, over)) = OVERRIDES.iter().find(|(k, _)| *k == token) {
        return (*over).to_string();
    }
    if token.chars().all(|c| c.is_ascii_digit()) {
        return token.to_string();
    }
    let mut chars = token.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
        None => String::new(),
    }
}

/// Strip the `<category>_` prefix off a `.cube` stem, e.g.
/// `color_negative_kodak_portra_400` + `color_negative` →
/// `kodak_portra_400`.
fn strip_category_prefix<'a>(stem: &'a str, category_dir: &str) -> &'a str {
    let prefix = format!("{category_dir}_");
    stem.strip_prefix(prefix.as_str()).unwrap_or(stem)
}

/// Derive a human display name from a category-stripped stem, e.g.
/// `ilford_hp_5` → `"Ilford HP 5"`. Splits on `_`, title-cases each token
/// via [`OVERRIDES`] with a default-capitalize fallback, numbers verbatim,
/// and joins with spaces.
pub fn derive_name(local_stem: &str) -> String {
    local_stem
        .split('_')
        .map(title_case_token)
        .collect::<Vec<_>>()
        .join(" ")
}

struct CatalogEntry {
    category: FilmCategory,
    id: String,
    name: String,
}

/// Render the generated `film_catalog.rs` source: hand-written types up
/// top (mirrored here, not `include!`d, so the generated file is
/// self-contained and readable on its own), the data table below.
/// Deterministic: `entries` is sorted by (category, id) by the caller, and
/// formatting is fixed, so re-running the ingest against an unchanged pack
/// produces a byte-identical file.
fn emit_catalog(entries: &[CatalogEntry]) -> String {
    let mut out = String::new();
    out.push_str(
        "// GENERATED by `maple-cli film-pack` from the external cube pack — edit via\n\
         // re-ingest, not by hand; not covered by codegen-drift (CI lacks the source\n\
         // pack).\n\
         \n\
         //! Film-look catalog (epic #2683, Task 5a). One entry per `.mlut` shipped\n\
         //! under `resources/film-luts/`; `id` doubles as the `papp:FilmLook` XMP\n\
         //! value and the `.mlut` filename stem.\n\
         \n\
         /// Which broad family a film-look belongs to — matches the six top-level\n\
         /// category directories in the ingested cube pack.\n\
         #[derive(Copy, Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]\n\
         pub enum FilmCategory {\n\
         \x20   BlackWhite,\n\
         \x20   CinemaPrint,\n\
         \x20   ColorNegative,\n\
         \x20   ConsumerVintage,\n\
         \x20   Instant,\n\
         \x20   Slide,\n\
         }\n\
         \n\
         /// One catalog entry: the `.mlut` id (also the `papp:FilmLook` XMP\n\
         /// value), a human display name, and its category.\n\
         #[derive(Copy, Clone, Debug)]\n\
         pub struct FilmLookEntry {\n\
         \x20   pub id: &'static str,\n\
         \x20   pub name: &'static str,\n\
         \x20   pub category: FilmCategory,\n\
         }\n\
         \n\
         pub static FILM_CATALOG: &[FilmLookEntry] = &[\n",
    );
    for entry in entries {
        let _ = writeln!(
            out,
            "    FilmLookEntry {{ id: {:?}, name: {:?}, category: FilmCategory::{} }},",
            entry.id,
            entry.name,
            entry.category.variant_name()
        );
    }
    out.push_str("];\n");
    out
}

/// Ingest `cube_dir` (six category subdirectories of `.cube` files) into
/// `.mlut` binaries under `out_dir` plus a generated catalog at
/// `catalog_out`.
pub fn run(
    cube_dir: &Path,
    out_dir: &Path,
    catalog_out: &Path,
) -> Result<i32, Box<dyn std::error::Error>> {
    std::fs::create_dir_all(out_dir)?;

    let mut entries: Vec<CatalogEntry> = Vec::new();
    let mut total_bytes: u64 = 0;

    for &category_dir in CATEGORY_DIRS {
        let dir_path = cube_dir.join(category_dir);
        let category = FilmCategory::for_dir(category_dir)?;

        let mut cube_files: Vec<PathBuf> = std::fs::read_dir(&dir_path)
            .map_err(|e| format!("film-pack: failed to read {}: {e}", dir_path.display()))?
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.path())
            .filter(|p| p.extension().and_then(|e| e.to_str()) == Some("cube"))
            .collect();
        cube_files.sort();

        for cube_path in cube_files {
            let stem = cube_path
                .file_stem()
                .and_then(|s| s.to_str())
                .ok_or_else(|| format!("film-pack: non-UTF8 filename {}", cube_path.display()))?
                .to_string();

            let text = std::fs::read_to_string(&cube_path)
                .map_err(|e| format!("film-pack: failed to read {}: {e}", cube_path.display()))?;
            let path_display = cube_path.display().to_string();
            let cube = parse_cube(&text, &path_display)?;

            let mlut_bytes = raw_core::film::encode_mlut(cube.size, &cube.data);
            let out_path = out_dir.join(format!("{stem}.mlut"));
            std::fs::write(&out_path, &mlut_bytes)?;
            total_bytes += mlut_bytes.len() as u64;

            let local = strip_category_prefix(&stem, category_dir);
            let name = derive_name(local);
            entries.push(CatalogEntry {
                category,
                id: stem,
                name,
            });
        }
    }

    entries.sort_by(|a, b| a.category.cmp(&b.category).then_with(|| a.id.cmp(&b.id)));

    let catalog_src = emit_catalog(&entries);
    if let Some(parent) = catalog_out.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(catalog_out, catalog_src)?;

    eprintln!(
        "film-pack: ingested {} looks ({:.1} KB total) -> {}",
        entries.len(),
        total_bytes as f64 / 1024.0,
        out_dir.display()
    );
    eprintln!(
        "film-pack: wrote catalog ({} entries) -> {}",
        entries.len(),
        catalog_out.display()
    );

    Ok(0)
}

#[cfg(test)]
#[path = "film_pack_tests.rs"]
mod film_pack_tests;
