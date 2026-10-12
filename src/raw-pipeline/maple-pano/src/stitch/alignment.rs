//! The solved alignment a panorama preview hands to the full stitch (#4578).
//!
//! [`SolvedAlignment`] is everything stages 0–2 produce that the tail
//! (refinement → solve → composite) reads: per-frame geometry facts, the
//! verified proxy-resolution match graph, the focal seed, and — when the
//! strategy selector picked tile — the unit-focal tile graph. Pixels are
//! not part of it; the tail decodes full-resolution frames from the paths.
//!
//! [`AlignmentKey`] is the fingerprint that decides whether an alignment
//! may be reused: the identity of every input file (canonical path, byte
//! size, modification time) plus exactly the options that feed stages 0–2
//! (strategy request, proxy size, model directory, CoreML). Options read
//! only after the boundary — retention, local alignment, residual budgets,
//! canvas cap, strip height, seam strategy — are deliberately absent: the
//! tail re-runs them on every stitch, so changing them keeps the matching
//! work and still yields the same pixels a fresh stitch would.

use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::{Deserialize, Serialize};

use crate::ba;
use crate::camera::Camera;
use crate::gain::LensGroups;
use crate::graph::{GraphImage, MatchGraph};
use crate::ingest::FramePriors;
use crate::strategy::{select_strategy, StrategyReport, StrategyRequest};

use super::focal_bootstrap::FocalSeedSource;
use super::types::{StitchError, StitchOptions};

/// Bumped whenever the serialized layout or the meaning of a stored field
/// changes; a file written under another version is treated as stale.
pub const ALIGNMENT_FORMAT_VERSION: u32 = 1;

/// Seed for the strategy selector's similarity RANSAC. Shared by the
/// fresh solve and the decode path so a reloaded alignment re-derives the
/// identical [`StrategyReport`].
const STRATEGY_SEED: u64 = 0x1226_cafe_dead_beef;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InputIdentity {
    pub path: PathBuf,
    pub size_bytes: u64,
    pub modified_unix_ns: Option<u64>,
}

impl InputIdentity {
    fn of(path: &Path) -> Result<Self, StitchError> {
        let meta = std::fs::metadata(path).map_err(|e| StitchError::Decode {
            path: path.to_path_buf(),
            cause: e.to_string(),
        })?;
        let canonical = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
        let modified_unix_ns = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .and_then(|d| u64::try_from(d.as_nanos()).ok());
        Ok(Self {
            path: canonical,
            size_bytes: meta.len(),
            modified_unix_ns,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AlignmentKey {
    pub format_version: u32,
    pub inputs: Vec<InputIdentity>,
    pub strategy: String,
    pub proxy_long_edge: u32,
    pub models_dir: Option<PathBuf>,
    pub use_coreml: bool,
}

impl AlignmentKey {
    pub fn for_run(inputs: &[PathBuf], opts: &StitchOptions) -> Result<Self, StitchError> {
        Ok(Self {
            format_version: ALIGNMENT_FORMAT_VERSION,
            inputs: inputs
                .iter()
                .map(|p| InputIdentity::of(p))
                .collect::<Result<_, _>>()?,
            strategy: opts.strategy.as_str().to_string(),
            proxy_long_edge: opts.proxy_long_edge,
            models_dir: opts.models_dir.clone(),
            use_coreml: opts.use_coreml,
        })
    }

    /// `None` when `self` (the stored key) matches `current`; otherwise
    /// the first difference, phrased for a log line or a UI notice.
    pub fn mismatch(&self, current: &AlignmentKey) -> Option<String> {
        if self.format_version != current.format_version {
            return Some(format!(
                "alignment format v{} (this build reads v{})",
                self.format_version, current.format_version
            ));
        }
        if self.inputs.len() != current.inputs.len() {
            return Some(format!(
                "frame count changed ({} → {})",
                self.inputs.len(),
                current.inputs.len()
            ));
        }
        let changed_input = self
            .inputs
            .iter()
            .zip(&current.inputs)
            .enumerate()
            .find(|(_, (stored, now))| stored != now);
        if let Some((i, (stored, now))) = changed_input {
            return Some(if stored.path != now.path {
                format!(
                    "frame {i} is a different file ({} → {})",
                    stored.path.display(),
                    now.path.display()
                )
            } else {
                format!(
                    "frame {i} ({}) changed on disk since the alignment was solved",
                    now.path.display()
                )
            });
        }
        let option_changes: Vec<String> = [
            (self.strategy != current.strategy)
                .then(|| format!("strategy {} → {}", self.strategy, current.strategy)),
            (self.proxy_long_edge != current.proxy_long_edge).then(|| {
                format!(
                    "proxy long edge {} → {}",
                    self.proxy_long_edge, current.proxy_long_edge
                )
            }),
            (self.models_dir != current.models_dir).then(|| "models directory".to_string()),
            (self.use_coreml != current.use_coreml).then(|| "CoreML execution".to_string()),
        ]
        .into_iter()
        .flatten()
        .collect();
        (!option_changes.is_empty())
            .then(|| format!("geometry options changed: {}", option_changes.join(", ")))
    }
}

/// One frame's geometry facts — everything about the frame the tail
/// reads except its pixels.
#[derive(Debug, Clone, PartialEq)]
pub struct AlignedFrame {
    pub full_dims: (u32, u32),
    pub proxy_dims: (u32, u32),
    /// `full / proxy` per axis — maps proxy match coordinates to full res.
    pub proxy_scale: (f64, f64),
    /// Starting focal length (full-resolution px), EXIF-derived or
    /// self-calibrated; bundle adjustment refines it.
    pub focal_full_px: f64,
    pub priors: FramePriors,
    pub applied_opcodes: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct SolvedAlignment {
    pub key: AlignmentKey,
    pub frames: Vec<AlignedFrame>,
    pub focal_seed_source: FocalSeedSource,
    /// Verified proxy-resolution graph (rotation verifier, real focal).
    /// Strategy selection reads it; the rotation tail refines a copy.
    pub graph: MatchGraph,
    /// The unit-focal graph the tile tail consumes; `Some` iff the
    /// selected strategy is tile.
    pub tile_graph: Option<MatchGraph>,
    pub strategy_report: StrategyReport,
    /// Lens identity per frame for the blind vignette estimate (#4522).
    pub lenses: LensGroups,
}

/// How a stitch or preview treated the alignment it was offered.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AlignmentReuse {
    /// No alignment was offered; stages 0–2 ran.
    Solved,
    /// The offered alignment matched; matching and verification were skipped.
    Reused,
    /// The offered alignment did not match (reason); stages 0–2 re-ran.
    Stale(String),
}

impl AlignmentReuse {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Solved => "solved",
            Self::Reused => "reused",
            Self::Stale(_) => "stale",
        }
    }

    pub fn reason(&self) -> Option<&str> {
        match self {
            Self::Stale(reason) => Some(reason),
            _ => None,
        }
    }
}

/// The offered alignment when its key matches `key`, plus the verdict.
pub(super) fn usable<'a>(
    offered: Option<&'a SolvedAlignment>,
    key: &AlignmentKey,
) -> (Option<&'a SolvedAlignment>, AlignmentReuse) {
    match offered {
        None => (None, AlignmentReuse::Solved),
        Some(a) => match a.key.mismatch(key) {
            None => (Some(a), AlignmentReuse::Reused),
            Some(reason) => (None, AlignmentReuse::Stale(reason)),
        },
    }
}

pub(super) fn select_strategy_for(
    request: StrategyRequest,
    graph: &MatchGraph,
    priors: &[FramePriors],
    focal_full_px: &[f64],
) -> StrategyReport {
    let mean_focal_px = if focal_full_px.is_empty() {
        1.0
    } else {
        focal_full_px.iter().sum::<f64>() / focal_full_px.len() as f64
    };
    select_strategy(request, graph, priors, mean_focal_px, STRATEGY_SEED)
}

pub(super) fn parse_strategy_request(s: &str) -> Option<StrategyRequest> {
    [
        StrategyRequest::Auto,
        StrategyRequest::Rotation,
        StrategyRequest::Tile,
    ]
    .into_iter()
    .find(|r| r.as_str() == s)
}

impl SolvedAlignment {
    pub fn priors(&self) -> Vec<FramePriors> {
        self.frames.iter().map(|f| f.priors.clone()).collect()
    }

    pub fn applied_opcodes(&self) -> Vec<Vec<String>> {
        self.frames
            .iter()
            .map(|f| f.applied_opcodes.clone())
            .collect()
    }

    pub fn proxy_scales(&self) -> Vec<(f64, f64)> {
        self.frames.iter().map(|f| f.proxy_scale).collect()
    }

    pub fn full_dims(&self) -> Vec<(u32, u32)> {
        self.frames.iter().map(|f| f.full_dims).collect()
    }

    pub fn proxy_dims(&self) -> Vec<(u32, u32)> {
        self.frames.iter().map(|f| f.proxy_dims).collect()
    }

    /// Initial full-resolution cameras — the same construction
    /// `focal_bootstrap::build_graph_images` uses for verification.
    pub fn full_images(&self) -> Vec<GraphImage> {
        self.frames
            .iter()
            .map(|f| GraphImage {
                camera: Camera::new(
                    [0.0; 3],
                    f.focal_full_px,
                    0.0,
                    0.0,
                    f.full_dims.0,
                    f.full_dims.1,
                ),
                prior_rotation: f.priors.gimbal.as_ref().map(ba::init::rotation_from_gimbal),
            })
            .collect()
    }

    /// Initial proxy-resolution cameras — the cameras the stored graph
    /// was verified against.
    pub fn proxy_images(&self) -> Vec<GraphImage> {
        self.full_images()
            .into_iter()
            .zip(&self.frames)
            .map(|(img, f)| GraphImage {
                camera: Camera::new(
                    [0.0; 3],
                    img.camera.focal_px / f.proxy_scale.0,
                    0.0,
                    0.0,
                    f.proxy_dims.0,
                    f.proxy_dims.1,
                ),
                prior_rotation: img.prior_rotation,
            })
            .collect()
    }
}

#[cfg(test)]
#[path = "alignment_tests.rs"]
mod tests;
