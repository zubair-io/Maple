//! Public types for the stitch pipeline: options, outcome, and errors.

use std::path::PathBuf;

use crate::ba::{self, BaSolution, RetentionPolicy};
use crate::composite::CompositeReport;
use crate::ingest::{FramePriors, PlanarImage};
use crate::local_align::LocalCorrection;
use crate::strategy::StrategyReport;

// ─── Input options ───────────────────────────────────────────────────────────

/// All tunable parameters for a single stitch run. Callers construct this
/// with `StitchOptions::default()` and override what they need.
#[derive(Clone)]
pub struct StitchOptions {
    /// Frame-retention policy passed to the BA solver.
    pub retention: RetentionPolicy,
    /// Enable Stage-F bilinear-mesh local alignment (#1218).
    pub local_align: bool,
    /// Content-based / forced strategy selection (#1226).
    pub strategy: crate::strategy::StrategyRequest,
    /// Spec §5.3 mean reprojection-error acceptance gate (px).
    pub mean_budget_px: f64,
    /// Spec §5.3 max reprojection-error acceptance gate (px).
    pub max_budget_px: f64,
    /// Optional explicit models directory; `None` reads `MAPLE_PANO_MODELS`.
    pub models_dir: Option<PathBuf>,
    /// Long-edge cap for the feature-extraction proxy (px).
    ///
    /// Default **1600**. 1280 was tried (M6-D, ALIKED's native input) but
    /// measurably starved the matcher on the acceptance set — pano_01
    /// regressed to tile strategy + 19 orphans / no candidate at 1280 vs
    /// rotation, 0-dropped, mean 1.13 at 1600 (#1248). The proxy feeds the
    /// match/BA phase only, not the composite memory peak that
    /// `canvas_tile_rows` addresses, so 1600 costs ~no memory vs 1280.
    /// Lower it only when the matcher-quality tradeoff is acceptable.
    pub proxy_long_edge: u32,
    /// Total output canvas pixel cap (uniform downscale to fit).
    pub max_canvas_px: usize,
    /// Canvas tile height for memory-bounded composite (M6-D, #1248).
    ///
    /// When `Some(n)`, the composite phase processes `n` canvas rows at a
    /// time, decoding source frames on demand and discarding them after each
    /// tile, keeping at most **one full-resolution frame** resident per tile
    /// pass instead of all N simultaneously. The gain solve runs before the
    /// pixel data is freed and its result is re-used across all tiles.
    ///
    /// `None` (default): full-canvas all-resident path (backward compatible;
    /// uses full multi-band blending).
    pub canvas_tile_rows: Option<u32>,
    // M6-C (#1248 follow-up): CoreML EP wiring for iOS.
}

impl Default for StitchOptions {
    fn default() -> Self {
        Self {
            retention: RetentionPolicy::KeepAlignable,
            local_align: true,
            strategy: crate::strategy::StrategyRequest::Auto,
            mean_budget_px: 1.5,
            max_budget_px: 6.0,
            models_dir: None,
            // 1600, NOT 1280: dropping the default to 1280 starves ALIKED of
            // keypoints on the acceptance set (pano_01 regressed to tile
            // strategy + 19 orphans / no candidate at 1280; rotation, 0
            // dropped, mean 1.13 at 1600 — measured). The proxy only feeds
            // the match/BA phase, NOT the composite peak that tiling
            // addresses, so 1600 costs ~no memory vs 1280. Callers that
            // accept the matcher-quality tradeoff can still lower it.
            proxy_long_edge: 1600,
            max_canvas_px: 256_000_000,
            canvas_tile_rows: None,
        }
    }
}

// ─── Output ──────────────────────────────────────────────────────────────────

/// Everything `stitch` returns on success. The composited image is the
/// primary product; all other fields are bookkeeping the CLI uses to
/// assemble the `StitchReport` JSON (spec §6). The FFI caller ignores
/// those fields.
pub struct StitchOutcome {
    /// Scene-linear Rec.2020 composite (the value the PNG/DNG writer encodes).
    pub image: PlanarImage,
    /// The compositing stage report (projection, canvas dims, gains, …).
    pub comp_report: CompositeReport,
    /// Bundle-adjustment solution (cameras, reproj stats, drops, …).
    pub solution: BaSolution,
    /// Per-frame local-alignment corrections (parallel to `solution.cameras`).
    pub local_corrections: Vec<Option<LocalCorrection>>,
    /// Strategy-selection outcome (evidence + selection + optional warning).
    pub strategy_report: StrategyReport,
    /// Decoded input frames (applied_opcodes survives frame consumption).
    pub applied_opcodes: Vec<Vec<String>>,
    /// Per-frame EXIF/gimbal priors (needed for CLI report).
    pub priors: Vec<FramePriors>,
    /// Number of full-resolution NCC-refined correspondences.
    pub refined_matches: usize,
    /// Number of correspondences that fell back to proxy accuracy.
    pub fallback_matches: usize,
    /// Summary of the full-resolution reverification (edges/matches dropped).
    pub reverify: crate::graph::ReverifySummary,
    /// Whether the BA solution was roll-leveled.
    pub leveled: bool,
    /// Horizon tilt in degrees when leveling was applied.
    pub horizon_tilt_deg: Option<f64>,
    /// Stage wall-clock timings (seconds). Indices are stage ordinals above.
    /// Entry 5 = composite; entry 6 = not used (write is the caller's job).
    pub stage_timings_s: [f64; 6],
}

// ─── Errors ──────────────────────────────────────────────────────────────────

/// Errors from `stitch`.
#[derive(Debug)]
pub enum StitchError {
    /// Fewer than 2 input paths were provided.
    TooFewFrames(usize),
    /// ML environment unavailable (models dir or ORT dylib missing).
    MlUnavailable(String),
    /// Frame decode or prior extraction failed.
    Decode { path: PathBuf, cause: String },
    /// Feature extraction failed for a frame.
    Feature { frame_idx: usize, cause: String },
    /// LightGlue matching failed on one or more pairs.
    MatchFailed(Vec<String>),
    /// Bundle adjustment failed.
    BaSolve(String),
    /// Reverification failed.
    Reverify(String),
    /// Compositing failed.
    Composite(String),
    /// Strategy returned `Tile` — the caller must route to its tile path.
    TileNotSupported(StrategyReport),
    /// Too few frames survived bundle adjustment to composite.
    TooFewSurvivors {
        survived: usize,
        dropped: Vec<ba::DroppedFrame>,
    },
    /// No EXIF 35mm focal length available for seeding the camera model.
    NoFocal { path: PathBuf },
    /// Cancelled by the caller.
    Cancelled,
}

impl std::fmt::Display for StitchError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::TooFewFrames(n) => write!(f, "need at least 2 frames, got {n}"),
            Self::MlUnavailable(e) => write!(
                f,
                "ML environment unavailable: {e}\n\
                 Set MAPLE_PANO_MODELS to the models dir and ORT_DYLIB_PATH \
                 to libonnxruntime (>= 1.23)"
            ),
            Self::Decode { path, cause } => write!(f, "{}: {cause}", path.display()),
            Self::Feature { frame_idx, cause } => {
                write!(f, "frame {frame_idx}: feature extraction: {cause}")
            }
            Self::MatchFailed(pairs) => {
                write!(
                    f,
                    "LightGlue failed on {} pair(s): {}",
                    pairs.len(),
                    pairs.join("; ")
                )
            }
            Self::BaSolve(e) => write!(f, "BA solve: {e}"),
            Self::Reverify(e) => write!(f, "reverify: {e}"),
            Self::Composite(e) => write!(f, "composite: {e}"),
            Self::TileNotSupported(_) => write!(
                f,
                "tile strategy selected; tile FFI path not yet implemented"
            ),
            Self::TooFewSurvivors { survived, dropped } => write!(
                f,
                "only {survived} frame(s) survived BA (drops: {dropped:?})"
            ),
            Self::NoFocal { path } => write!(
                f,
                "{}: no EXIF 35mm focal length — cannot seed camera model",
                path.display()
            ),
            Self::Cancelled => write!(f, "cancelled by caller"),
        }
    }
}
