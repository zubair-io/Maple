//! Cross-platform codegen for raw-core canonical schemas.
//!
//! Two schemas today:
//!
//! - `adjustment` (`raw_core::types::ADJUSTMENT_SCHEMA`, ticket #118) — slider
//!   range constants, the canonical field-name enum, the TS interface, and
//!   the TS default factory. Swift defaults stay hand-written in
//!   `AdjustmentModel.swift` so per-field doc-comments can live next to
//!   each `let` (per #326, sharpen converges to 40 / 1.0 / 25 / 0). Emitter
//!   lives in `adjustment.rs` next to this file.
//! - `ui-tokens` (`raw_core::ui_tokens::{COLOR_TOKENS, MOTION_TOKENS,
//!   RADIUS_TOKENS, SPACING_TOKENS}`, ticket #606) — design-system colors,
//!   motion specs, radius, and spacing. Swift/TS/SCSS emitters live in
//!   `ui_tokens.rs`; the WinUI/XAML emitter lives in `ui_tokens_xaml.rs`,
//!   both next to this file.
//! - `film-catalog` (`raw_core::film_catalog::FILM_CATALOG`, epic #2683
//!   Task 6) — the FilmCategory enum/union, the FilmLookEntry shape, and
//!   the full catalog. Emitter lives in `film_catalog.rs` next to this
//!   file.
//!
//! Driven from `tools/codegen.sh`. The codegen-drift CI gate
//! (`.github/workflows/cross.yml`) runs the script then `git diff
//! --exit-code` so hand-edits to `Generated/` files fail fast.

mod adjustment;
mod adjustment_groups;
mod adjustment_tables;
mod color_matrices;
mod film_catalog;
mod ui_tokens;
mod ui_tokens_xaml;

use std::fs;
use std::path::PathBuf;

use clap::{Parser, ValueEnum};
use raw_core::film_catalog::FILM_CATALOG;
use raw_core::types::ADJUSTMENT_SCHEMA;
use raw_core::ui_tokens::{COLOR_TOKENS, MOTION_TOKENS, RADIUS_TOKENS, SPACING_TOKENS};

use adjustment::{emit_swift, emit_ts};
use adjustment_tables::emit_ts_tables;

#[derive(Copy, Clone, Debug, ValueEnum)]
enum Target {
    Swift,
    Ts,
    /// TypeScript field-lookup tables (`ADJUSTMENT_RANGES` + the copy/paste
    /// group tables) — only valid for `--schema adjustment`. Split into its
    /// own output file (#2683) so neither generated TS file grows toward
    /// the 600-line hard budget as `ADJUSTMENT_SCHEMA` gains fields; see
    /// `adjustment_tables::emit_ts_tables`.
    TsTables,
    /// SCSS / CSS custom-property output. Only valid for `--schema ui-tokens`;
    /// the adjustment schema has no SCSS surface.
    Scss,
    /// WGSL output. Only valid for `--schema color-matrices` (epic #925 P2 /
    /// #990) — emits the GPU scene-linear kernels' baked color matrices.
    Wgsl,
    /// WinUI XAML `ResourceDictionary` output. Only valid for `--schema
    /// ui-tokens`; closes the Windows codegen gap tracked under milestone
    /// #22 — `Themes/Tokens.xaml` was previously hand-mirrored.
    Xaml,
}

#[derive(Copy, Clone, Debug, ValueEnum, PartialEq, Eq)]
enum Schema {
    /// `raw_core::types::ADJUSTMENT_SCHEMA` — slider ranges, field-name enums,
    /// TS interface + default factory.
    Adjustment,
    /// `raw_core::ui_tokens::{COLOR_TOKENS, MOTION_TOKENS, RADIUS_TOKENS,
    /// SPACING_TOKENS}` — design-system color hex strings, motion
    /// duration/easing pairs, radius, and spacing. Ticket #606.
    UiTokens,
    /// Oklab + Rec.2020/sRGB color matrices (forward + inverse). WGSL target:
    /// the full nine-matrix set the GPU scene-linear kernels bake in (epic
    /// #925 P2 / #990). TS target: `M_SRGB_TO_REC2020` only — the one matrix
    /// `image-utils.ts`'s non-RAW ingestion path consumes (#1944).
    ColorMatrices,
    /// `raw_core::film_catalog::FILM_CATALOG` — the FilmCategory enum/union,
    /// the FilmLookEntry shape, and the full 100-entry catalog (epic #2683,
    /// Task 6).
    FilmCatalog,
}

#[derive(Parser, Debug)]
#[command(
    name = "codegen",
    about = "Emit Swift / TS / SCSS shape declarations from raw-core canonical schemas"
)]
struct Cli {
    /// Which canonical schema to emit. Defaults to `adjustment` for back-compat
    /// with the original single-schema codegen.
    #[arg(long, value_enum, default_value_t = Schema::Adjustment)]
    schema: Schema,
    #[arg(long, value_enum)]
    target: Target,
    #[arg(long)]
    out: PathBuf,
}


fn main() {
    let cli = Cli::parse();
    let out = match (cli.schema, cli.target) {
        (Schema::Adjustment, Target::Swift) => emit_swift(ADJUSTMENT_SCHEMA),
        (Schema::Adjustment, Target::Ts) => emit_ts(ADJUSTMENT_SCHEMA),
        (Schema::Adjustment, Target::TsTables) => emit_ts_tables(ADJUSTMENT_SCHEMA),
        (Schema::Adjustment, Target::Scss | Target::Wgsl | Target::Xaml) => {
            eprintln!("codegen: --schema adjustment supports only swift / ts / ts-tables targets");
            std::process::exit(2);
        }
        (Schema::UiTokens, Target::Swift) => {
            ui_tokens::emit_swift(COLOR_TOKENS, MOTION_TOKENS, RADIUS_TOKENS, SPACING_TOKENS)
        }
        (Schema::UiTokens, Target::Ts) => {
            ui_tokens::emit_ts(COLOR_TOKENS, MOTION_TOKENS, RADIUS_TOKENS, SPACING_TOKENS)
        }
        (Schema::UiTokens, Target::Scss) => {
            ui_tokens::emit_scss(COLOR_TOKENS, MOTION_TOKENS, RADIUS_TOKENS, SPACING_TOKENS)
        }
        (Schema::UiTokens, Target::Xaml) => {
            ui_tokens_xaml::emit_xaml(COLOR_TOKENS, RADIUS_TOKENS, SPACING_TOKENS)
        }
        (Schema::UiTokens, Target::TsTables | Target::Wgsl) => {
            eprintln!("codegen: --schema ui-tokens has no ts-tables / WGSL target");
            std::process::exit(2);
        }
        (Schema::ColorMatrices, Target::Wgsl) => color_matrices::emit_wgsl(),
        (Schema::ColorMatrices, Target::Ts) => color_matrices::emit_ts(),
        (Schema::ColorMatrices, Target::Swift | Target::Scss | Target::TsTables | Target::Xaml) => {
            eprintln!("codegen: --schema color-matrices supports only the wgsl / ts targets");
            std::process::exit(2);
        }
        (Schema::FilmCatalog, Target::Swift) => film_catalog::emit_swift(FILM_CATALOG),
        (Schema::FilmCatalog, Target::Ts) => film_catalog::emit_ts(FILM_CATALOG),
        (Schema::FilmCatalog, Target::TsTables | Target::Scss | Target::Wgsl | Target::Xaml) => {
            eprintln!("codegen: --schema film-catalog supports only the swift / ts targets");
            std::process::exit(2);
        }
    };
    if let Some(parent) = cli.out.parent() {
        fs::create_dir_all(parent).expect("create parent dir");
    }
    fs::write(&cli.out, out).expect("write generated file");
}

/// snake_case -> camelCase. `temperature` -> `temperature`,
/// `sharpen_amount` -> `sharpenAmount`.
pub(crate) fn camel_case(snake: &str) -> String {
    let mut out = String::with_capacity(snake.len());
    let mut upper_next = false;
    for ch in snake.chars() {
        if ch == '_' {
            upper_next = true;
        } else if upper_next {
            out.extend(ch.to_uppercase());
            upper_next = false;
        } else {
            out.push(ch);
        }
    }
    out
}
