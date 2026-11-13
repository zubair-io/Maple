//! JSON form of [`SolvedAlignment`] (#4578).
//!
//! Every float is stored as its IEEE-754 bit pattern: serde_json's default
//! float parser is best-effort, not correctly rounded, so a decimal round
//! trip can move a value by one ULP — and a reused alignment must drive
//! the tail to the exact pixels a fresh solve does. The strategy report is
//! not stored; it is re-derived from the stored graph on decode with the
//! same deterministic seed the fresh solve used.

use serde::{Deserialize, Serialize};

use crate::gain::LensGroups;
use crate::graph::{MatchGraph, RejectedPair, VerifiedEdge};
use crate::ingest::{FramePriors, GimbalPrior, GpsPrior};
use crate::math::Mat3;
use crate::robust::VerifyFailure;
use crate::strategy::Strategy;
use crate::twoview::PixelCorrespondence;

use super::alignment::{
    parse_strategy_request, select_strategy_for, AlignedFrame, AlignmentKey, SolvedAlignment,
};
use super::focal_bootstrap::FocalSeedSource;

#[derive(Serialize, Deserialize)]
struct AlignmentFile {
    key: AlignmentKey,
    focal_seed_source: String,
    frames: Vec<FrameDto>,
    graph: GraphDto,
    tile_graph: Option<GraphDto>,
    lens_labels: Vec<String>,
    lens_of_frame: Vec<Option<usize>>,
}

#[derive(Serialize, Deserialize)]
struct FrameDto {
    full_dims: (u32, u32),
    proxy_dims: (u32, u32),
    proxy_scale_bits: (u64, u64),
    focal_full_px_bits: u64,
    focal_mm_bits: Option<u32>,
    focal_35mm_equiv_bits: Option<u32>,
    prior_focal_px_bits: Option<u64>,
    gimbal_ypr_bits: Option<[u64; 3]>,
    /// `[lat, lon]` and the relative altitude.
    gps_bits: Option<([u64; 2], Option<u64>)>,
    applied_opcodes: Vec<String>,
}

#[derive(Serialize, Deserialize)]
struct GraphDto {
    image_count: usize,
    edges: Vec<EdgeDto>,
    rejected: Vec<RejectedDto>,
    components: Vec<Vec<usize>>,
    orphans: Vec<usize>,
}

#[derive(Serialize, Deserialize)]
struct EdgeDto {
    a: usize,
    b: usize,
    rotation_bits: [u64; 9],
    inlier_count: usize,
    mean_residual_rad_bits: u64,
    /// `[a.x, a.y, b.x, b.y]` per inlier.
    inlier_bits: Vec<[u64; 4]>,
}

#[derive(Serialize, Deserialize)]
struct RejectedDto {
    a: usize,
    b: usize,
    reason: FailureDto,
}

#[derive(Serialize, Deserialize)]
enum FailureDto {
    TooFewCorrespondences {
        have: usize,
        need: usize,
    },
    NoModel {
        iterations: usize,
    },
    BelowMinInliers {
        inliers: usize,
        required: usize,
    },
    LoopClosureOutsideFootprint {
        cells: usize,
    },
    LoopClosureUnconfirmed {
        best_triangle_error_deg_bits: Option<u64>,
    },
    LoopClosurePlacementUnconfirmed {
        best_placement_error_px_bits: Option<u64>,
    },
    LoopClosureBeyondGroundFootprint {
        distance_m_bits: u64,
        limit_m_bits: u64,
    },
}

fn mat_bits(m: &Mat3) -> [u64; 9] {
    std::array::from_fn(|i| m.0[i / 3][i % 3].to_bits())
}

fn mat_from_bits(bits: &[u64; 9]) -> Mat3 {
    Mat3(std::array::from_fn(|r| {
        std::array::from_fn(|c| f64::from_bits(bits[r * 3 + c]))
    }))
}

impl From<&VerifyFailure> for FailureDto {
    fn from(f: &VerifyFailure) -> Self {
        match *f {
            VerifyFailure::TooFewCorrespondences { have, need } => {
                Self::TooFewCorrespondences { have, need }
            }
            VerifyFailure::NoModel { iterations } => Self::NoModel { iterations },
            VerifyFailure::BelowMinInliers { inliers, required } => {
                Self::BelowMinInliers { inliers, required }
            }
            VerifyFailure::LoopClosureOutsideFootprint { cells } => {
                Self::LoopClosureOutsideFootprint { cells }
            }
            VerifyFailure::LoopClosureUnconfirmed {
                best_triangle_error_deg,
            } => Self::LoopClosureUnconfirmed {
                best_triangle_error_deg_bits: best_triangle_error_deg.map(f64::to_bits),
            },
            VerifyFailure::LoopClosurePlacementUnconfirmed {
                best_placement_error_px,
            } => Self::LoopClosurePlacementUnconfirmed {
                best_placement_error_px_bits: best_placement_error_px.map(f64::to_bits),
            },
            VerifyFailure::LoopClosureBeyondGroundFootprint {
                distance_m,
                limit_m,
            } => Self::LoopClosureBeyondGroundFootprint {
                distance_m_bits: distance_m.to_bits(),
                limit_m_bits: limit_m.to_bits(),
            },
        }
    }
}

impl From<FailureDto> for VerifyFailure {
    fn from(f: FailureDto) -> Self {
        match f {
            FailureDto::TooFewCorrespondences { have, need } => {
                Self::TooFewCorrespondences { have, need }
            }
            FailureDto::NoModel { iterations } => Self::NoModel { iterations },
            FailureDto::BelowMinInliers { inliers, required } => {
                Self::BelowMinInliers { inliers, required }
            }
            FailureDto::LoopClosureOutsideFootprint { cells } => {
                Self::LoopClosureOutsideFootprint { cells }
            }
            FailureDto::LoopClosureUnconfirmed {
                best_triangle_error_deg_bits,
            } => Self::LoopClosureUnconfirmed {
                best_triangle_error_deg: best_triangle_error_deg_bits.map(f64::from_bits),
            },
            FailureDto::LoopClosurePlacementUnconfirmed {
                best_placement_error_px_bits,
            } => Self::LoopClosurePlacementUnconfirmed {
                best_placement_error_px: best_placement_error_px_bits.map(f64::from_bits),
            },
            FailureDto::LoopClosureBeyondGroundFootprint {
                distance_m_bits,
                limit_m_bits,
            } => Self::LoopClosureBeyondGroundFootprint {
                distance_m: f64::from_bits(distance_m_bits),
                limit_m: f64::from_bits(limit_m_bits),
            },
        }
    }
}

impl From<&MatchGraph> for GraphDto {
    fn from(g: &MatchGraph) -> Self {
        Self {
            image_count: g.image_count,
            edges: g
                .edges
                .iter()
                .map(|e| EdgeDto {
                    a: e.a,
                    b: e.b,
                    rotation_bits: mat_bits(&e.rotation),
                    inlier_count: e.inlier_count,
                    mean_residual_rad_bits: e.mean_residual_rad.to_bits(),
                    inlier_bits: e
                        .inlier_matches
                        .iter()
                        .map(|m| {
                            [
                                m.a.0.to_bits(),
                                m.a.1.to_bits(),
                                m.b.0.to_bits(),
                                m.b.1.to_bits(),
                            ]
                        })
                        .collect(),
                })
                .collect(),
            rejected: g
                .rejected
                .iter()
                .map(|r| RejectedDto {
                    a: r.a,
                    b: r.b,
                    reason: (&r.reason).into(),
                })
                .collect(),
            components: g.components.clone(),
            orphans: g.orphans.clone(),
        }
    }
}

impl From<GraphDto> for MatchGraph {
    fn from(g: GraphDto) -> Self {
        let f = f64::from_bits;
        Self {
            image_count: g.image_count,
            edges: g
                .edges
                .into_iter()
                .map(|e| VerifiedEdge {
                    a: e.a,
                    b: e.b,
                    rotation: mat_from_bits(&e.rotation_bits),
                    inlier_count: e.inlier_count,
                    mean_residual_rad: f(e.mean_residual_rad_bits),
                    inlier_matches: e
                        .inlier_bits
                        .iter()
                        .map(|m| PixelCorrespondence {
                            a: (f(m[0]), f(m[1])),
                            b: (f(m[2]), f(m[3])),
                        })
                        .collect(),
                })
                .collect(),
            rejected: g
                .rejected
                .into_iter()
                .map(|r| RejectedPair {
                    a: r.a,
                    b: r.b,
                    reason: r.reason.into(),
                })
                .collect(),
            components: g.components,
            orphans: g.orphans,
        }
    }
}

impl From<&AlignedFrame> for FrameDto {
    fn from(fr: &AlignedFrame) -> Self {
        let p = &fr.priors;
        Self {
            full_dims: fr.full_dims,
            proxy_dims: fr.proxy_dims,
            proxy_scale_bits: (fr.proxy_scale.0.to_bits(), fr.proxy_scale.1.to_bits()),
            focal_full_px_bits: fr.focal_full_px.to_bits(),
            focal_mm_bits: p.focal_mm.map(f32::to_bits),
            focal_35mm_equiv_bits: p.focal_35mm_equiv.map(f32::to_bits),
            prior_focal_px_bits: p.focal_px.map(f64::to_bits),
            gimbal_ypr_bits: p.gimbal.map(|g| {
                [
                    g.yaw_deg.to_bits(),
                    g.pitch_deg.to_bits(),
                    g.roll_deg.to_bits(),
                ]
            }),
            gps_bits: p.gps.as_ref().map(|g| {
                (
                    [g.lat_deg.to_bits(), g.lon_deg.to_bits()],
                    g.relative_altitude_m.map(f64::to_bits),
                )
            }),
            applied_opcodes: fr.applied_opcodes.clone(),
        }
    }
}

impl From<FrameDto> for AlignedFrame {
    fn from(d: FrameDto) -> Self {
        let f = f64::from_bits;
        Self {
            full_dims: d.full_dims,
            proxy_dims: d.proxy_dims,
            proxy_scale: (f(d.proxy_scale_bits.0), f(d.proxy_scale_bits.1)),
            focal_full_px: f(d.focal_full_px_bits),
            priors: FramePriors {
                focal_mm: d.focal_mm_bits.map(f32::from_bits),
                focal_35mm_equiv: d.focal_35mm_equiv_bits.map(f32::from_bits),
                focal_px: d.prior_focal_px_bits.map(f),
                gimbal: d.gimbal_ypr_bits.map(|[y, p, r]| GimbalPrior {
                    yaw_deg: f(y),
                    pitch_deg: f(p),
                    roll_deg: f(r),
                }),
                gps: d.gps_bits.map(|([lat, lon], alt)| GpsPrior {
                    lat_deg: f(lat),
                    lon_deg: f(lon),
                    relative_altitude_m: alt.map(f),
                }),
            },
            applied_opcodes: d.applied_opcodes,
        }
    }
}

impl SolvedAlignment {
    pub fn to_json(&self) -> String {
        serde_json::to_string(&AlignmentFile {
            key: self.key.clone(),
            focal_seed_source: self.focal_seed_source.as_str().to_string(),
            frames: self.frames.iter().map(FrameDto::from).collect(),
            graph: (&self.graph).into(),
            tile_graph: self.tile_graph.as_ref().map(GraphDto::from),
            lens_labels: self.lenses.labels.clone(),
            lens_of_frame: self.lenses.of_frame.clone(),
        })
        .expect("alignment DTOs hold only integers, strings and paths")
    }

    pub fn from_json(json: &str) -> Result<Self, String> {
        let file: AlignmentFile =
            serde_json::from_str(json).map_err(|e| format!("unreadable alignment: {e}"))?;
        let request = parse_strategy_request(&file.key.strategy)
            .ok_or_else(|| format!("unknown strategy {:?}", file.key.strategy))?;
        let focal_seed_source = [FocalSeedSource::Exif, FocalSeedSource::HomographyFallback]
            .into_iter()
            .find(|s| s.as_str() == file.focal_seed_source)
            .ok_or_else(|| format!("unknown focal seed source {:?}", file.focal_seed_source))?;
        let frames: Vec<AlignedFrame> = file.frames.into_iter().map(AlignedFrame::from).collect();
        let graph = MatchGraph::from(file.graph);
        if frames.len() != file.key.inputs.len()
            || graph.image_count != frames.len()
            || file.lens_of_frame.len() != frames.len()
            || file
                .lens_of_frame
                .iter()
                .flatten()
                .any(|&g| g >= file.lens_labels.len())
        {
            return Err(format!(
                "inconsistent alignment: {} inputs, {} frames, graph over {} images, {} lens entries",
                file.key.inputs.len(),
                frames.len(),
                graph.image_count,
                file.lens_of_frame.len()
            ));
        }
        let priors: Vec<FramePriors> = frames.iter().map(|f| f.priors.clone()).collect();
        let focals: Vec<f64> = frames.iter().map(|f| f.focal_full_px).collect();
        let strategy_report = select_strategy_for(request, &graph, &priors, &focals);
        if (strategy_report.selected == Strategy::Tile) != file.tile_graph.is_some() {
            return Err(format!(
                "inconsistent alignment: strategy re-derives as {} but the tile graph is {}",
                strategy_report.selected.as_str(),
                if file.tile_graph.is_some() {
                    "present"
                } else {
                    "absent"
                }
            ));
        }
        Ok(Self {
            key: file.key,
            frames,
            focal_seed_source,
            graph,
            tile_graph: file.tile_graph.map(MatchGraph::from),
            strategy_report,
            lenses: LensGroups {
                labels: file.lens_labels,
                of_frame: file.lens_of_frame,
            },
        })
    }
}
