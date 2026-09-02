//! CLI argument surface for `pano stitch` — split from `pano/mod.rs`
//! for the file-size budget. Flag semantics are documented on the
//! fields; strategy/mode enums map onto [`maple_pano::ba`] options.

use std::path::PathBuf;

use clap::{Args, ValueEnum};
use maple_pano::ba::RetentionPolicy;

use super::{SPEC_MAX_BUDGET_PX, SPEC_MEAN_BUDGET_PX};

#[derive(Args)]
pub struct StitchArgs {
    /// Input RAW frames (2+; single-set mode). Sorted by file name =
    /// capture order. Mutually exclusive with --manifest.
    #[arg(num_args = 0..)]
    pub(super) inputs: Vec<PathBuf>,
    /// Output PNG path (16-bit, scene-linear; single-set mode).
    #[arg(long)]
    pub(super) out: Option<PathBuf>,
    /// Also write an sRGB-encoded 16-bit preview PNG here (single-set).
    #[arg(long)]
    pub(super) display: Option<PathBuf>,
    /// Write the stitch report JSON here (always printed to stderr).
    #[arg(long)]
    pub(super) report: Option<PathBuf>,
    /// Batch mode: pano manifest JSON (the harness contract — see the
    /// module docs). Requires --out-dir.
    #[arg(long, conflicts_with_all = ["out", "display", "report"])]
    pub(super) manifest: Option<PathBuf>,
    /// Batch mode: candidate output directory.
    #[arg(long, requires = "manifest")]
    pub(super) out_dir: Option<PathBuf>,
    /// Long-edge cap for the feature-extraction proxy. The ALIKED
    /// export letterboxes to 1280² internally; larger proxies only
    /// cost decode time. Default 1600 (matches the pano harness baseline). 1280 starves ALIKED on pano_01 (regressed to 19 orphans, #1248) — lower it only when accepting that tradeoff.
    #[arg(long, default_value_t = 1600)]
    pub(super) proxy_long_edge: u32,
    /// Total canvas pixel cap (uniform downscale to fit).
    #[arg(long, default_value_t = 256_000_000)]
    pub(super) max_canvas_px: usize,
    /// Per-frame mean reprojection-error budget (px; single-set mode
    /// only). The spec §5.3 gate is 1.5; relax it for input with
    /// uncorrected lens distortion (DJI `WarpRectilinear` opcodes
    /// raw-core does not yet apply, #1159), which inflates residuals
    /// the k1/k2 model only partly absorbs.
    #[arg(long, default_value_t = SPEC_MEAN_BUDGET_PX)]
    pub(super) max_mean_px: f64,
    /// Per-frame max reprojection-error budget (px; single-set mode
    /// only). Spec §5.3 gate is 6.
    #[arg(long, default_value_t = SPEC_MAX_BUDGET_PX)]
    pub(super) max_residual_px: f64,
    /// Models directory (defaults to $MAPLE_PANO_MODELS).
    #[arg(long)]
    pub(super) models_dir: Option<PathBuf>,
    /// Frame-retention policy. `keep` (default; spec §8 product
    /// behavior): a frame with a certified rigid core is kept — its
    /// non-rigid matches are pruned and seam-routed, and drops are
    /// pose-evidence-only. `strict`: the §5.3 residual budgets drop
    /// frames, including motion-dominated ones. A mode choice, not a
    /// gate relaxer — allowed in batch mode; the harness gates the
    /// outcome either way.
    #[arg(long, value_enum, default_value_t = RetentionArg::Keep)]
    pub(super) retention: RetentionArg,
    /// Stage-F local alignment (#1218). `mesh` (default): a bounded
    /// bilinear mesh absorbs the parallax floor before gating and
    /// compositing. `off`: the geometric chain ends at the BA rotations
    /// (pure #1213 geometry).
    #[arg(long, value_enum, default_value_t = LocalAlignArg::Mesh)]
    pub(super) local_align: LocalAlignArg,
    /// Alignment strategy (spec §8, #1226).
    /// `auto` (default): content-based model selection — compares
    /// rotation vs similarity residuals per verified edge; selects tile
    /// for translation-dominant sets (nadir strips, film scans).
    /// `rotation`: force rotation BA for all sets.
    /// `tile`: force planar similarity for all sets.
    #[arg(long, value_enum, default_value_t = StrategyArg::Auto)]
    pub(super) strategy: StrategyArg,
    /// Canvas strip height for the memory-bounded composite (#1254).
    /// Divides the output canvas into horizontal strips of this many rows;
    /// decodes each full-res frame on demand per strip and frees it
    /// immediately after warping. Peak RSS ≈ 1 decoded frame + 1 warped
    /// strip + 1 output strip instead of all frames resident simultaneously.
    /// Omitting this flag uses a default of 512 rows — the tiled path
    /// always engages on the rotation path (#1254). Pass a larger value to
    /// reduce tile-pass overhead at the cost of more peak RSS.
    #[arg(long)]
    pub(super) canvas_tile_rows: Option<u32>,
    /// Seam placement on the rotation-strategy composite (#1179; no effect
    /// on the tile-strategy branch, which keeps its own Voronoi seam).
    /// `voronoi` (default): deterministic, content-blind, source-border
    /// distance — what every `pano-budgets.json` ratchet is measured
    /// against. `graph-cut`: content-aware Boykov-Kolmogorov max-flow seam
    /// that routes around a moving subject or parallax-shifted edge
    /// instead of cutting through it — opt-in until a follow-up
    /// re-baselines the budgets with it as the default.
    #[arg(long, value_enum, default_value_t = SeamStrategyArg::Voronoi)]
    pub(super) seam_strategy: SeamStrategyArg,
}

/// CLI surface for [`maple_pano::ba::RetentionPolicy`].
#[derive(Clone, Copy, PartialEq, Eq, ValueEnum)]
pub(super) enum RetentionArg {
    Keep,
    Strict,
}

impl RetentionArg {
    pub(super) fn policy(self) -> RetentionPolicy {
        match self {
            RetentionArg::Keep => RetentionPolicy::KeepAlignable,
            RetentionArg::Strict => RetentionPolicy::Strict,
        }
    }
    pub(super) fn label(self) -> &'static str {
        match self {
            RetentionArg::Keep => "keep",
            RetentionArg::Strict => "strict",
        }
    }
}

/// CLI surface for [`maple_pano::strategy::StrategyRequest`].
#[derive(Clone, Copy, PartialEq, Eq, ValueEnum)]
pub(super) enum StrategyArg {
    Auto,
    Rotation,
    Tile,
}

impl StrategyArg {
    pub(super) fn to_request(self) -> maple_pano::strategy::StrategyRequest {
        use maple_pano::strategy::StrategyRequest;
        match self {
            StrategyArg::Auto => StrategyRequest::Auto,
            StrategyArg::Rotation => StrategyRequest::Rotation,
            StrategyArg::Tile => StrategyRequest::Tile,
        }
    }
}

/// CLI surface for [`maple_pano::ba::BaOptions::local_align`].
#[derive(Clone, Copy, PartialEq, Eq, ValueEnum)]
pub(super) enum LocalAlignArg {
    Mesh,
    Off,
}

impl LocalAlignArg {
    pub(super) fn enabled(self) -> bool {
        matches!(self, LocalAlignArg::Mesh)
    }
    pub(super) fn label(self) -> &'static str {
        match self {
            LocalAlignArg::Mesh => "mesh",
            LocalAlignArg::Off => "off",
        }
    }
}

/// CLI surface for [`maple_pano::seam::SeamStrategy`] (#1179).
#[derive(Clone, Copy, PartialEq, Eq, ValueEnum)]
pub(super) enum SeamStrategyArg {
    Voronoi,
    GraphCut,
}

impl SeamStrategyArg {
    pub(super) fn to_strategy(self) -> maple_pano::seam::SeamStrategy {
        use maple_pano::seam::SeamStrategy;
        match self {
            SeamStrategyArg::Voronoi => SeamStrategy::Voronoi,
            SeamStrategyArg::GraphCut => SeamStrategy::GraphCut,
        }
    }
}
