//! The stage-3 full-resolution refinement pass over every edge (#1254),
//! shared by the rotation and tile strategies.
//!
//! Each edge refines its matches from the stitch's frame store in bands
//! of matches (`refine::refine_from_frames`, #5563): only the rectangles
//! one band's templates and search windows touch are resident, never a
//! whole frame. Factored out of `stitch/mod.rs` for the 600-LOC budget.

use std::path::PathBuf;

use crate::frame_store::FrameRows;
use crate::graph::{GraphImage, MatchGraph};
use crate::refine::{refine_from_frames, RefineGeometry, RefineOptions};
use crate::stitch::types::StitchError;

/// Outcome of the refinement pass.
pub(super) struct RefinePassResult {
    pub refined_matches: usize,
    pub fallback_matches: usize,
}

/// Refine every edge of `graph` at full resolution, updating
/// `graph.edges[i].inlier_matches` in place. `inputs` (named in read
/// errors), `frames`, `proxy_scales` (`full / proxy` per axis) and
/// `full_images` are index-parallel with the graph's frames; `full_images`
/// is `None` for the tile path, which refines without perspective
/// compensation.
pub(super) fn refine_edges(
    graph: &mut MatchGraph,
    inputs: &[PathBuf],
    frames: &dyn FrameRows,
    proxy_scales: &[(f64, f64)],
    full_images: Option<&[GraphImage]>,
    mut progress: impl FnMut(f32),
    is_cancelled: &dyn Fn() -> bool,
) -> Result<RefinePassResult, StitchError> {
    let edge_count = graph.edges.len();
    let mut refined_matches = 0usize;
    let mut fallback_matches = 0usize;

    for ei in 0..edge_count {
        if is_cancelled() {
            return Err(StitchError::Cancelled);
        }
        let edge = &graph.edges[ei];
        let (ia, ib) = (edge.a, edge.b);
        let geometry = full_images.map(|images| RefineGeometry {
            cam_a: &images[ia].camera,
            cam_b: &images[ib].camera,
            rotation: &edge.rotation,
        });
        let outcome = refine_from_frames(
            frames,
            ia,
            ib,
            proxy_scales[ia],
            proxy_scales[ib],
            geometry.as_ref(),
            &edge.inlier_matches,
            &RefineOptions::default(),
        )
        .map_err(|(failed, e)| StitchError::Decode {
            path: inputs[failed].clone(),
            cause: format!("refining edge {ia}–{ib}: {e}"),
        })?;
        refined_matches += outcome.refined_count;
        fallback_matches += outcome.fallback_count;
        graph.edges[ei].inlier_matches = outcome.refined;

        progress((ei + 1) as f32 / edge_count as f32);
    }
    Ok(RefinePassResult {
        refined_matches,
        fallback_matches,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::frame_store::InMemory;
    use crate::graph::VerifiedEdge;
    use crate::ingest::PlanarImage;
    use crate::math::Mat3;

    #[test]
    fn refinement_stops_before_reading_once_cancelled() {
        let mut graph = MatchGraph {
            image_count: 2,
            edges: vec![VerifiedEdge {
                a: 0,
                b: 1,
                rotation: Mat3::identity(),
                inlier_count: 0,
                mean_residual_rad: 0.0,
                inlier_matches: Vec::new(),
            }],
            rejected: Vec::new(),
            components: vec![vec![0, 1]],
            orphans: Vec::new(),
        };
        let inputs = [
            PathBuf::from("/nonexistent/a.dng"),
            PathBuf::from("/nonexistent/b.dng"),
        ];
        let frames: [PlanarImage; 0] = [];
        let outcome = refine_edges(
            &mut graph,
            &inputs,
            &InMemory(&frames),
            &[(1.0, 1.0); 2],
            None,
            |_| {},
            &|| true,
        );
        assert!(matches!(outcome, Err(StitchError::Cancelled)));
    }
}
