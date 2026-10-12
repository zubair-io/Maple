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
    /// Stage-F local alignment (#1218, #4577). `mesh` (default): a
    /// bounded bilinear mesh per frame absorbs parallax before compositing
    /// — the camera-drift floor on rotation stitches, terrain relief on
    /// tile stitches. `off`: the geometric chain ends at the global solve
    /// (BA rotations or tile similarity placement).
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
    /// User seam constraints (#4520; single-set mode, needs
    /// `--seam-strategy graph-cut`): a JSON array of `include` / `exclude`
    /// rectangles in output-canvas pixels, each naming a frame by its index
    /// in the sorted input list. An include keeps that frame's content (one
    /// instance of a moving subject); an exclude keeps it out (a passer-by).
    /// Contradictory constraints fail the stitch with the conflict location.
    #[arg(long, conflicts_with = "manifest")]
    pub(super) seam_constraints: Option<PathBuf>,
    /// Declared capture grid `ROWSxCOLS` for drone surveys / camera
    /// arrays (#4519), COLS = frames per pass; the last pass may be
    /// short. Replaces global candidate nomination with grid neighbours
    /// and rejects loop closures that leave the grid footprint or break
    /// triangle rotation consistency. Single-set mode only.
    #[arg(long, value_parser = parse_grid, conflicts_with = "manifest")]
    pub(super) grid: Option<(usize, usize)>,
    /// Pass direction for --grid: `raster` (every pass the same way) or
    /// `serpentine` (alternate passes reversed).
    #[arg(long, value_enum, default_value_t = GridOrderArg::Serpentine, requires = "grid")]
    pub(super) grid_order: GridOrderArg,
    /// Treat diagonal grid cells as neighbours too.
    #[arg(long, requires = "grid")]
    pub(super) grid_diagonals: bool,
    /// Feature detector/matcher (#4523). `ml`: ALIKED + LightGlue (needs
    /// ONNX Runtime + models; `pano` builds). `classical`: Harris +
    /// gradient-histogram descriptors, no ONNX (`pano-classical` builds).
    /// Defaults to `ml` when built in.
    #[arg(long, value_enum, default_value_t = FeaturesEngineArg::default())]
    pub(super) features_engine: FeaturesEngineArg,
}

impl StitchArgs {
    pub(super) fn grid_layout(&self) -> Option<maple_pano::graph::GridLayout> {
        self.grid.map(|(rows, cols)| maple_pano::graph::GridLayout {
            rows,
            cols,
            order: self.grid_order.to_order(),
            diagonals: self.grid_diagonals,
        })
    }
}

fn parse_grid(value: &str) -> Result<(usize, usize), String> {
    let (rows, cols) = value
        .split_once(['x', 'X'])
        .ok_or_else(|| format!("expected ROWSxCOLS, got {value:?}"))?;
    let parse = |part: &str| {
        part.trim()
            .parse::<usize>()
            .ok()
            .filter(|&n| n > 0)
            .ok_or_else(|| format!("grid dimension {part:?} must be a positive integer"))
    };
    Ok((parse(rows)?, parse(cols)?))
}

/// CLI surface for [`maple_pano::graph::GridOrder`].
#[derive(Clone, Copy, PartialEq, Eq, ValueEnum)]
pub(super) enum GridOrderArg {
    Raster,
    Serpentine,
}

impl GridOrderArg {
    fn to_order(self) -> maple_pano::graph::GridOrder {
        use maple_pano::graph::GridOrder;
        match self {
            GridOrderArg::Raster => GridOrder::Raster,
            GridOrderArg::Serpentine => GridOrder::Serpentine,
        }
    }
}

/// CLI surface for [`maple_pano::stitch::FeatureEngine`] (#4523).
#[derive(Clone, Copy, PartialEq, Eq, Default, ValueEnum)]
pub(super) enum FeaturesEngineArg {
    #[cfg(feature = "pano")]
    #[default]
    Ml,
    #[cfg(feature = "pano-classical")]
    #[cfg_attr(not(feature = "pano"), default)]
    Classical,
}

impl FeaturesEngineArg {
    pub(super) fn to_engine(self) -> maple_pano::stitch::FeatureEngine {
        use maple_pano::stitch::FeatureEngine;
        match self {
            #[cfg(feature = "pano")]
            FeaturesEngineArg::Ml => FeatureEngine::Ml,
            #[cfg(feature = "pano-classical")]
            FeaturesEngineArg::Classical => FeatureEngine::Classical,
        }
    }
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

#[cfg(test)]
mod tests {
    use super::parse_grid;

    #[test]
    fn grid_flag_parses_rows_by_cols() {
        assert_eq!(parse_grid("4x6"), Ok((4, 6)));
        assert_eq!(parse_grid("3X2"), Ok((3, 2)));
        assert!(parse_grid("4").is_err());
        assert!(parse_grid("0x3").is_err());
        assert!(parse_grid("ax3").is_err());
    }
}
