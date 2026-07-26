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

/// Demosaic / `RenderQuality` choice exposed on the CLI. `Amaze` is the
/// default since #940 (the tiled kernel from #1887 made it as fast as
/// bilinear), matching the refine/export selection on all platforms; the
/// parity budgets are baselined against it. `Full` keeps the pre-#940
/// behaviour (Hamilton-Adams when compiled with `high-quality-demosaic`,
/// bilinear otherwise). `Preview` exists for symmetry with the FFI/tile
/// path so a user can generate a half-res candidate from the CLI.
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
    /// Constant-lightness, constant-hue Oklab chroma ramp (#1627 banding
    /// gate). Pair with `--hue`.
    ChromaRamp,
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

/// Auto Profile (#537) override exposed by `maple-cli render` / `batch`.
///
/// The color-parity harness (`src/scripts/test_color_pipeline.sh`) needs to
/// pin the view transform to AgX-Neutral so it measures Maple-vs-ACR
/// fidelity rather than Maple-vs-embedded-JPEG drift; the gate is shipped
/// alongside Auto Profile, not retired by it. `Xmp` (the default) honours
/// `papp:Profile` from the sidecar so the user's setting wins for ad-hoc
/// renders.
#[derive(ValueEnum, Clone, Copy, Debug)]
pub enum ProfileChoice {
    /// Use whatever `papp:Profile` says (default for fresh-open: `Auto`).
    Xmp,
    /// Force `Profile::Auto` regardless of XMP.
    Auto,
    /// Force `Profile::Neutral` regardless of XMP. Used by the
    /// color-parity harness.
    Neutral,
}
