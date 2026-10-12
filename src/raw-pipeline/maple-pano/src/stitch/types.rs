//! Public types for the stitch pipeline: options, outcome, and errors.
//!
//! [`StitchSuccess`] is the top-level success type returned by [`super::stitch`];
//! it carries either a rotation outcome or a tile outcome. Both strategies share
//! the same early pipeline (decode + ML + match graph) so no re-decode happens
//! when the auto selector chooses tile (#1270).

use std::path::PathBuf;

use crate::ba::{self, BaSolution, RetentionPolicy};
use crate::composite::CompositeReport;
use crate::ingest::{FramePriors, PlanarImage};
use crate::local_align::LocalCorrection;
use crate::strategy::StrategyReport;

use super::focal_bootstrap::FocalSeedSource;

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
    /// Canvas tile height for memory-bounded composite (M6-D, #1248, #1254).
    ///
    /// When `Some(n)`, the composite phase processes `n` canvas rows at a
    /// time, decoding source frames on demand and discarding them after each
    /// tile, keeping at most **one full-resolution frame** resident per tile
    /// pass instead of all N simultaneously. The gain solve runs before the
    /// pixel data is freed and its result is re-used across all tiles.
    ///
    /// `None` (default): **512-row tiled path** — the tiled composite always
    /// engages on the rotation-strategy path (#1254).  A `None` value no
    /// longer selects a full-canvas all-resident path; it selects the default
    /// tile height of 512 rows.  Pass `Some(n)` to override the strip height.
    pub canvas_tile_rows: Option<u32>,
    /// Request the CoreML Execution Provider for the ALIKED + LightGlue
    /// ORT sessions (M6-C, #1251). iOS-only: the EP is registered behind
    /// `#[cfg(target_os = "ios")]` in the session builders. If CoreML
    /// can't engage at runtime, ORT logs a warning and continues on
    /// CPU-ORT (a logged fallback, not a silent one). The CLI/macOS path
    /// leaves this `false` (CPU ORT, parity-verified); the iOS FFI sets
    /// it `true`.
    pub use_coreml: bool,
    /// Voronoi (default) or graph-cut seam placement on the composite's
    /// rotation-branch tail (#1179). See `composite`'s module doc.
    /// Voronoi stays the default: it's what every existing
    /// `pano-budgets.json` ratchet was measured against; graph-cut is
    /// opt-in until a follow-up re-baselines those budgets with it as
    /// the default.
    pub seam_strategy: crate::seam::SeamStrategy,
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
            use_coreml: false,
            seam_strategy: crate::seam::SeamStrategy::Voronoi,
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
    /// Which source produced the shared camera focal seed — EXIF, or the
    /// homography self-calibration fallback (spec §5.3, ticket #1214).
    pub focal_seed_source: FocalSeedSource,
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

// ─── Tile outcome ────────────────────────────────────────────────────────────

/// Everything [`stitch_tile`](super::stitch_tile) returns on success.
///
/// The composited image is the primary product; all other fields are
/// bookkeeping the CLI uses to assemble the tile `StitchReport` JSON
/// (spec §8 / #1226). The FFI caller needs only `image`.
pub struct TileStitchOutcome {
    /// Scene-linear Rec.2020 composite (the value the PNG/DNG writer encodes).
    pub image: PlanarImage,
    /// Tile composite report (canvas, placements, gains, residuals, …).
    pub tile_report: crate::tile::TileCompositeReport,
    /// Strategy-selection outcome (evidence + selection + optional warning).
    pub strategy_report: StrategyReport,
    /// Which source produced the shared camera focal seed — EXIF, or the
    /// homography self-calibration fallback (spec §5.3, ticket #1214).
    /// `None` only for the standalone [`super::stitch_tile`] entry point,
    /// which never resolves a real per-frame focal (always unit-focal).
    pub focal_seed_source: Option<FocalSeedSource>,
    /// Per-frame opcode lists (needed for CLI report).
    pub applied_opcodes: Vec<Vec<String>>,
    /// Per-frame EXIF/gimbal priors (needed for CLI report).
    pub priors: Vec<FramePriors>,
    /// Number of full-resolution NCC-refined correspondences.
    pub refined_matches: usize,
    /// Number of correspondences that fell back to proxy accuracy.
    pub fallback_matches: usize,
    /// Summary of the rotation-path reverification step (always 0/0 for tile).
    pub reverify: crate::graph::ReverifySummary,
    /// Frame indices disconnected from the anchor component.
    pub orphans: Vec<usize>,
    /// Number of frames successfully placed in the tile composite.
    pub poses_placed: usize,
    /// Mean planar residual across all verified inlier pairs (px).
    pub mean_planar_residual_px: f64,
    /// Max planar residual across all verified inlier pairs (px).
    pub max_planar_residual_px: f64,
    /// Stage wall-clock timings (seconds). Named keys:
    /// `[decode, features, match_graph, refine, solve, composite]`.
    pub stage_timings_s: [f64; 6],
}

// ─── Unified success type ─────────────────────────────────────────────────────

/// The success result of [`super::stitch`].
///
/// Both strategies share the early pipeline (decode-proxy + ALIKED +
/// LightGlue + match graph). After strategy selection the run diverges:
/// rotation continues through BA → leveling → equirect composite;
/// tile goes through planar placement → NCC refine → planar composite.
///
/// Callers that only need the pixel output can use the blanket accessor
/// [`StitchSuccess::image`] without matching on the strategy.
pub enum StitchSuccess {
    /// The rotation strategy ran (BA → leveling → equirect composite).
    Rotation(StitchOutcome),
    /// The tile strategy ran (planar placement → NCC refine → composite).
    Tile(TileStitchOutcome),
}

impl StitchSuccess {
    /// The composited pixel output regardless of which strategy ran.
    pub fn image(&self) -> &crate::ingest::PlanarImage {
        match self {
            Self::Rotation(o) => &o.image,
            Self::Tile(o) => &o.image,
        }
    }
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
    /// Too few frames survived bundle adjustment to composite.
    TooFewSurvivors {
        survived: usize,
        dropped: Vec<ba::DroppedFrame>,
    },
    /// Neither EXIF nor the homography self-calibration fallback could
    /// seed a shared camera focal length: no frame carried a usable
    /// EXIF value, and the assumed-FOV bootstrap match graph produced
    /// no usable homography focal estimate (spec §5.3, ticket #1214).
    NoFocalSeed,
    /// The BA solution produced a degenerate geometry that would require an
    /// impossibly large canvas to represent (e.g. near-parallel / translational
    /// camera set forced through the rotation path). The guard fires before any
    /// large allocation. The caller should retry with Auto or Tile strategy.
    DegenerateGeometry(String),
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
            Self::TooFewSurvivors { survived, dropped } => write!(
                f,
                "only {survived} frame(s) survived BA (drops: {dropped:?})"
            ),
            Self::NoFocalSeed => write!(
                f,
                "no EXIF focal length on any frame, and the assumed-FOV bootstrap match \
                 graph produced no usable homography focal estimate — cannot seed camera model"
            ),
            Self::DegenerateGeometry(msg) => {
                write!(f, "degenerate rotation geometry: {msg}")
            }
            Self::Cancelled => write!(f, "cancelled by caller"),
        }
    }
}
