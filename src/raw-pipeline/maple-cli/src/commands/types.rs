//! CLI value-enums shared between the clap `Cmd` derive in `main.rs` and the
//! per-command modules under `commands::*`. Kept in one place so the
//! `--format`, `--demosaic`, and `--kind` flags carry the exact same set of
//! values in `--help` output and on the dispatch side.

use clap::ValueEnum;
use raw_core::pipeline::RenderQuality;

#[derive(ValueEnum, Clone, Copy, Debug)]
pub enum OutputFormat {
    Png,
    Jpeg,
    Tiff,
}

/// Demosaic / `RenderQuality` choice exposed on the CLI. `Full` is the
/// default and matches the historical `maple-cli render` behaviour
/// (Hamilton-Adams when compiled with `high-quality-demosaic`, bilinear
/// otherwise) — the parity harnesses depend on this default. `Amaze`
/// switches to the AMaZE demosaic for finer-detail / moiré-resistant
/// renders. `Preview` exists for symmetry with the FFI/tile path so a
/// user can generate a half-res candidate from the CLI.
#[derive(ValueEnum, Clone, Copy, Debug)]
pub enum DemosaicChoice {
    Preview,
    Full,
    Amaze,
}

/// Synthetic-input kind exposed by `maple-cli synthetic`. Each kind picks
/// one of the `raw_core::synthetic_input::*` generators and feeds the
/// resulting scene-linear `Image` through the view transform (or the
/// slider chain, when `--params` is supplied).
#[derive(ValueEnum, Clone, Copy, Debug)]
pub enum SyntheticKind {
    NeutralRamp,
    HuePatch,
    HaloDisk,
}

impl From<DemosaicChoice> for RenderQuality {
    fn from(c: DemosaicChoice) -> Self {
        match c {
            DemosaicChoice::Preview => RenderQuality::Preview,
            DemosaicChoice::Full => RenderQuality::Full,
            DemosaicChoice::Amaze => RenderQuality::Amaze,
        }
    }
}
