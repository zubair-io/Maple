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
//! - `ui-tokens` (`raw_core::ui_tokens::{COLOR_TOKENS, MOTION_TOKENS}`,
//!   ticket #606) — design-system colors + motion specs. Emitter lives in
//!   `ui_tokens.rs` next to this file.
//!
//! Driven from `tools/codegen.sh`. The codegen-drift CI gate
//! (`.github/workflows/cross.yml`) runs the script then `git diff
//! --exit-code` so hand-edits to `Generated/` files fail fast.

mod adjustment;
mod adjustment_groups;
mod color_matrices;
mod ui_tokens;

use std::fs;
use std::path::PathBuf;

use clap::{Parser, ValueEnum};
use raw_core::types::ADJUSTMENT_SCHEMA;
use raw_core::ui_tokens::{COLOR_TOKENS, MOTION_TOKENS};

use adjustment::{emit_swift, emit_ts};

#[derive(Copy, Clone, Debug, ValueEnum)]
enum Target {
    Swift,
    Ts,
    /// SCSS / CSS custom-property output. Only valid for `--schema ui-tokens`;
    /// the adjustment schema has no SCSS surface.
    Scss,
    /// WGSL output. Only valid for `--schema color-matrices` (epic #925 P2 /
    /// #990) — emits the GPU scene-linear kernels' baked color matrices.
    Wgsl,
}

#[derive(Copy, Clone, Debug, ValueEnum, PartialEq, Eq)]
enum Schema {
    /// `raw_core::types::ADJUSTMENT_SCHEMA` — slider ranges, field-name enums,
    /// TS interface + default factory.
    Adjustment,
    /// `raw_core::ui_tokens::{COLOR_TOKENS, MOTION_TOKENS}` — design-system
    /// color hex strings + motion duration/easing pairs. Ticket #606.
    UiTokens,
    /// Oklab + Rec.2020/sRGB color matrices (forward + inverse). WGSL target:
    /// the full nine-matrix set the GPU scene-linear kernels bake in (epic
    /// #925 P2 / #990). TS target: `M_SRGB_TO_REC2020` only — the one matrix
    /// `image-utils.ts`'s non-RAW ingestion path consumes (#1944).
    ColorMatrices,
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
        (Schema::Adjustment, Target::Scss | Target::Wgsl) => {
            eprintln!("codegen: --schema adjustment supports only swift / ts targets");
            std::process::exit(2);
        }
        (Schema::UiTokens, Target::Swift) => ui_tokens::emit_swift(COLOR_TOKENS, MOTION_TOKENS),
        (Schema::UiTokens, Target::Ts) => ui_tokens::emit_ts(COLOR_TOKENS, MOTION_TOKENS),
        (Schema::UiTokens, Target::Scss) => ui_tokens::emit_scss(COLOR_TOKENS, MOTION_TOKENS),
        (Schema::UiTokens, Target::Wgsl) => {
            eprintln!("codegen: --schema ui-tokens has no WGSL target");
            std::process::exit(2);
        }
        (Schema::ColorMatrices, Target::Wgsl) => color_matrices::emit_wgsl(),
        (Schema::ColorMatrices, Target::Ts) => color_matrices::emit_ts(),
        (Schema::ColorMatrices, Target::Swift | Target::Scss) => {
            eprintln!("codegen: --schema color-matrices supports only the wgsl / ts targets");
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
