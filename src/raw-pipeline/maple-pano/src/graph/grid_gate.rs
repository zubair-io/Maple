//! Loop-closure gate for structured-grid captures (#4519).
//!
//! Neighbour edges on the declared grid are the prior and always stay.
//! Every other verified edge must pass two checks:
//!
//! 1. **Distance.** When both frames carry a ground footprint (DJI GPS
//!    fix + height above take-off + EXIF focal), their centres must be
//!    closer than the mean footprint diagonal — further apart, two nadir
//!    frames cannot share content. Otherwise the frames must lie within
//!    [`LOOP_CLOSURE_MAX_CELLS`] of each other on the grid.
//! 2. **Cycle consistency.** For some frame `k` neighbouring both ends,
//!    composing the verified `a → k` and `k → b` relations must reproduce
//!    the edge's own `a → b` relation. The relation follows the strategy:
//!    on the rotation path it is the verified relative rotation (gated in
//!    degrees); on the tile path — translation-dominant nadir surveys,
//!    where the rotation verifier runs at a placeholder unit focal and
//!    its rotations carry no geometry — it is a robust 2D similarity fit
//!    to the edge's inliers, gated on how far frame `a`'s corners land
//!    apart under the composed vs direct transform, as a fraction of the
//!    frame diagonal.
//!
//! Rejections move to [`MatchGraph::rejected`] with their reason.

use std::collections::BTreeMap;

use super::{connected_components, orphans_of, GraphImage, GridLayout, MatchGraph};
use super::{RejectedPair, VerifiedEdge};
use crate::math::Mat3;
use crate::prng::SplitMix64;
use crate::robust::VerifyFailure;
use crate::similarity::{estimate_similarity, Similarity2d, SimilarityOptions};
use crate::twoview::rotation_angle_between;

/// Chebyshev grid distance beyond which two frames cannot overlap on a
/// survey flown at normal (≤ ~80 %) forward/side overlap.
pub const LOOP_CLOSURE_MAX_CELLS: usize = 2;

/// Two composed neighbour rotations each carry the verifier's
/// sub-0.5° noise; a real loop closure lands well inside this, a false
/// match on repetitive texture lands far outside.
pub const LOOP_CLOSURE_MAX_ROTATION_ERROR_DEG: f64 = 2.0;

/// Corner disagreement allowed on the tile path, as a fraction of frame
/// `a`'s diagonal (~20 px on a 1600 px proxy): three similarity fits'
/// noise plus mild nadir parallax stay well under it, while a false match
/// on a repeating texture is off by at least one texture period.
pub const LOOP_CLOSURE_MAX_CORNER_ERROR_FRAC: f64 = 0.01;

const MEAN_EARTH_RADIUS_M: f64 = 6_371_008.8;

/// Which pairwise relation the cycle-consistency check composes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LoopClosureCheck {
    Rotation,
    Planar,
}

/// A frame's ground footprint: GPS centre plus the ground length of the
/// frame diagonal.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct GroundFootprint {
    pub lat_deg: f64,
    pub lon_deg: f64,
    pub diagonal_m: f64,
}

impl GroundFootprint {
    /// Great-circle (haversine) distance between footprint centres.
    pub fn distance_m(&self, other: &GroundFootprint) -> f64 {
        let (lat_a, lat_b) = (self.lat_deg.to_radians(), other.lat_deg.to_radians());
        let d_lat = lat_b - lat_a;
        let d_lon = (other.lon_deg - self.lon_deg).to_radians();
        let h =
            (d_lat / 2.0).sin().powi(2) + lat_a.cos() * lat_b.cos() * (d_lon / 2.0).sin().powi(2);
        2.0 * MEAN_EARTH_RADIUS_M * h.sqrt().min(1.0).asin()
    }
}

/// Inputs of [`MatchGraph::admit_grid_loop_closures`]. `ground` is
/// indexed by frame; an empty slice means no frame has a footprint.
#[derive(Debug, Clone, Copy)]
pub struct LoopClosureGate<'a> {
    pub layout: GridLayout,
    pub check: LoopClosureCheck,
    pub ground: &'a [Option<GroundFootprint>],
}

#[derive(Debug, Clone, Copy)]
enum Relation {
    Rotation(Mat3),
    Planar(Similarity2d),
}

impl Relation {
    fn inverse(&self) -> Relation {
        match self {
            Relation::Rotation(r) => Relation::Rotation(r.transpose()),
            Relation::Planar(t) => {
                let inv = Similarity2d {
                    scale: 1.0 / t.scale,
                    theta: -t.theta,
                    tx: 0.0,
                    ty: 0.0,
                };
                let (x, y) = inv.apply(t.tx, t.ty);
                Relation::Planar(Similarity2d {
                    tx: -x,
                    ty: -y,
                    ..inv
                })
            }
        }
    }

    /// `self` maps a → k, `next` maps k → b; the result maps a → b.
    fn then(&self, next: &Relation) -> Option<Relation> {
        match (self, next) {
            (Relation::Rotation(ak), Relation::Rotation(kb)) => {
                Some(Relation::Rotation(kb.mul_mat(ak)))
            }
            (Relation::Planar(ak), Relation::Planar(kb)) => {
                let (tx, ty) = kb.apply(ak.tx, ak.ty);
                Some(Relation::Planar(Similarity2d {
                    scale: ak.scale * kb.scale,
                    theta: ak.theta + kb.theta,
                    tx,
                    ty,
                }))
            }
            _ => None,
        }
    }

    /// Degrees for rotations; corner disagreement over the frame
    /// diagonal for similarities.
    fn disagreement(&self, other: &Relation, frame: (u32, u32)) -> Option<f64> {
        match (self, other) {
            (Relation::Rotation(x), Relation::Rotation(y)) => {
                Some(rotation_angle_between(x, y).to_degrees())
            }
            (Relation::Planar(x), Relation::Planar(y)) => {
                let (w, h) = (frame.0 as f64, frame.1 as f64);
                let worst = [(0.0, 0.0), (w, 0.0), (0.0, h), (w, h)]
                    .iter()
                    .map(|&(cx, cy)| {
                        let ((x0, y0), (x1, y1)) = (x.apply(cx, cy), y.apply(cx, cy));
                        (x0 - x1).hypot(y0 - y1)
                    })
                    .fold(0.0_f64, f64::max);
                Some(worst / w.hypot(h))
            }
            _ => None,
        }
    }
}

fn edge_relation(edge: &VerifiedEdge, check: LoopClosureCheck) -> Option<Relation> {
    match check {
        LoopClosureCheck::Rotation => Some(Relation::Rotation(edge.rotation)),
        LoopClosureCheck::Planar => {
            let mut rng = SplitMix64::new(0x4519 ^ ((edge.a as u64) << 32) ^ edge.b as u64);
            estimate_similarity(
                &edge.inlier_matches,
                &SimilarityOptions::default(),
                &mut rng,
            )
            .ok()
            .map(|est| Relation::Planar(est.transform))
        }
    }
}

impl MatchGraph {
    /// Apply the structured-grid loop-closure gate (module docs) in
    /// place; returns how many edges it rejected. Components and orphans
    /// are recomputed.
    pub fn admit_grid_loop_closures(
        &mut self,
        images: &[GraphImage],
        gate: &LoopClosureGate<'_>,
    ) -> usize {
        let layout = gate.layout;
        let relations: BTreeMap<(usize, usize), Relation> = self
            .edges
            .iter()
            .filter_map(|e| edge_relation(e, gate.check).map(|r| ((e.a, e.b), r)))
            .collect();
        let trusted = |from: usize, to: usize| -> Option<Relation> {
            let key = (from.min(to), from.max(to));
            let relation = relations
                .get(&key)
                .filter(|_| layout.is_neighbour(from, to))?;
            Some(if from < to {
                *relation
            } else {
                relation.inverse()
            })
        };
        let verdict = |e: &VerifiedEdge| -> Option<VerifyFailure> {
            if layout.is_neighbour(e.a, e.b) {
                return None;
            }
            distance_verdict(e, gate).or_else(|| {
                let direct = relations.get(&(e.a, e.b));
                let frame = images
                    .get(e.a)
                    .map_or((1, 1), |img| (img.camera.width, img.camera.height));
                let best = layout
                    .neighbours(e.a, self.image_count)
                    .into_iter()
                    .filter_map(|k| {
                        let via = trusted(e.a, k)?.then(&trusted(k, e.b)?)?;
                        via.disagreement(direct?, frame)
                    })
                    .min_by(f64::total_cmp);
                consistency_verdict(best, gate.check, frame)
            })
        };
        let (kept, refused): (Vec<_>, Vec<_>) = std::mem::take(&mut self.edges)
            .into_iter()
            .map(|e| {
                let reason = verdict(&e);
                (e, reason)
            })
            .partition(|(_, reason)| reason.is_none());
        let rejected_count = refused.len();
        self.edges = kept.into_iter().map(|(e, _)| e).collect();
        self.rejected
            .extend(refused.into_iter().filter_map(|(e, reason)| {
                reason.map(|reason| RejectedPair {
                    a: e.a,
                    b: e.b,
                    reason,
                })
            }));
        self.rejected.sort_by_key(|r| (r.a, r.b));
        self.components = connected_components(self.image_count, &self.edges);
        self.orphans = orphans_of(&self.components);
        rejected_count
    }
}

fn distance_verdict(edge: &VerifiedEdge, gate: &LoopClosureGate<'_>) -> Option<VerifyFailure> {
    let footprint = |i: usize| gate.ground.get(i).copied().flatten();
    match (footprint(edge.a), footprint(edge.b)) {
        (Some(fa), Some(fb)) => {
            let distance_m = fa.distance_m(&fb);
            let limit_m = 0.5 * (fa.diagonal_m + fb.diagonal_m);
            (distance_m > limit_m).then_some(VerifyFailure::LoopClosureBeyondGroundFootprint {
                distance_m,
                limit_m,
            })
        }
        _ => {
            let cells = gate
                .layout
                .cell_distance(edge.a, edge.b)
                .unwrap_or(usize::MAX);
            (cells > LOOP_CLOSURE_MAX_CELLS)
                .then_some(VerifyFailure::LoopClosureOutsideFootprint { cells })
        }
    }
}

fn consistency_verdict(
    best: Option<f64>,
    check: LoopClosureCheck,
    frame: (u32, u32),
) -> Option<VerifyFailure> {
    match check {
        LoopClosureCheck::Rotation => match best {
            Some(err) if err <= LOOP_CLOSURE_MAX_ROTATION_ERROR_DEG => None,
            _ => Some(VerifyFailure::LoopClosureUnconfirmed {
                best_triangle_error_deg: best,
            }),
        },
        LoopClosureCheck::Planar => match best {
            Some(frac) if frac <= LOOP_CLOSURE_MAX_CORNER_ERROR_FRAC => None,
            _ => Some(VerifyFailure::LoopClosurePlacementUnconfirmed {
                best_corner_error_px: best
                    .map(|frac| frac * (frame.0 as f64).hypot(frame.1 as f64)),
            }),
        },
    }
}
