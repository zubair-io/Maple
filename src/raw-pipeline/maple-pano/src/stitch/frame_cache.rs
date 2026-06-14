//! 2-entry LRU decode cache helpers for the stage-3 refinement pass (#1254).
//!
//! During full-resolution NCC refinement, each edge's pair of frames is decoded
//! on demand and the cache evicts the frame least needed by the next edge.  At
//! most 2 full-resolution [`PlanarImage`]s are resident simultaneously.
//!
//! [`refine_edges_lru`] is the main entry: it runs the full LRU-cached
//! refinement loop over every edge of the match graph, returning the aggregate
//! match counts. It is factored out of `stitch/mod.rs` for the 600-LOC budget.

use std::path::PathBuf;

use crate::graph::{GraphImage, MatchGraph};
use crate::ingest::{FrameMeta, PlanarImage};
use crate::refine::{refine_correspondences, RefineGeometry, RefineOptions};
use crate::stitch::types::StitchError;

/// Decode a frame into the cache at `evict_slot`, replacing whatever was there.
///
/// Returns `Err(message)` if the file fails to decode.
pub(super) fn load_frame(
    cache: &mut [Option<(usize, PlanarImage)>; 2],
    idx: usize,
    path: &PathBuf,
    evict_slot: usize,
) -> Result<(), String> {
    let frame = crate::ingest::ingest_file(path).map_err(|e| e.to_string())?;
    cache[evict_slot] = Some((idx, frame.image));
    Ok(())
}

/// Choose which of the two cache slots to evict when loading a new frame.
///
/// **Never** evicts a slot holding `want_a` or `want_b` — the two frames
/// the current edge requires.  Among the remaining candidates, prefers the
/// slot whose frame is *not* referenced by either index in `next_pair`.
/// Falls back to slot 1 when all slots are excluded or tied.
pub(super) fn choose_evict_slot(
    cache: &[Option<(usize, PlanarImage)>; 2],
    want_a: usize,
    want_b: usize,
    next_pair: Option<(usize, usize)>,
) -> usize {
    // Build eviction candidates: exclude slots that hold want_a or want_b
    // (evicting them would force an immediate re-decode of the same frame).
    let candidates: Vec<usize> = (0..2)
        .filter(|&slot| {
            !cache[slot]
                .as_ref()
                .map(|(idx, _)| *idx == want_a || *idx == want_b)
                .unwrap_or(false)
        })
        .collect();

    // Among candidates, prefer empty slots or ones not needed by next_pair.
    let (na, nb) = next_pair.unwrap_or((usize::MAX, usize::MAX));
    for &slot in &candidates {
        match &cache[slot] {
            None => return slot, // Empty — free to use.
            Some((idx, _)) if *idx != na && *idx != nb => return slot, // Not needed next.
            _ => {}
        }
    }
    // Fallback: pick first candidate (or slot 1 if no candidates, which
    // would only happen if both slots already hold want_a and want_b — the
    // caller should then not call choose_evict_slot at all).
    candidates.into_iter().next().unwrap_or(1)
}

/// Outcome of the LRU-cached NCC refinement pass.
pub(super) struct RefinePassResult {
    pub refined_matches: usize,
    pub fallback_matches: usize,
}

/// Run the LRU-cached full-resolution NCC refinement pass over every edge of
/// `graph` (#1254), updating `graph.edges[i].inlier_matches` in place.
///
/// Uses a 2-entry LRU decode cache so at most 2 full-resolution frames are
/// resident at once. `inputs` and `full_images` are index-parallel with the
/// `metas` used to build the graph.
///
/// Returns the aggregate refined / fallback match counts.
pub(super) fn refine_edges_lru(
    graph: &mut MatchGraph,
    inputs: &[PathBuf],
    metas: &[FrameMeta],
    full_images: &[GraphImage],
    mut progress: impl FnMut(f32),
) -> Result<RefinePassResult, StitchError> {
    let mut cache: [Option<(usize, PlanarImage)>; 2] = [None, None];
    let edge_count = graph.edges.len();
    let edge_pairs: Vec<(usize, usize)> = graph.edges.iter().map(|e| (e.a, e.b)).collect();

    let mut refined_matches = 0usize;
    let mut fallback_matches = 0usize;

    for ei in 0..edge_count {
        let (ia, ib) = edge_pairs[ei];
        let next_pair: Option<(usize, usize)> = edge_pairs.get(ei + 1).copied();

        let slot_a = cache
            .iter()
            .position(|s| s.as_ref().map(|c| c.0) == Some(ia));
        let slot_for_a = match slot_a {
            Some(s) => s,
            None => {
                let evict = choose_evict_slot(&cache, ia, ib, next_pair);
                load_frame(&mut cache, ia, &inputs[ia], evict).map_err(|cause| {
                    StitchError::Decode {
                        path: inputs[ia].clone(),
                        cause,
                    }
                })?;
                evict
            }
        };

        let slot_b_after = cache
            .iter()
            .position(|s| s.as_ref().map(|c| c.0) == Some(ib));
        let slot_for_b = match slot_b_after {
            Some(s) => s,
            None => {
                let evict = if slot_for_a == 0 { 1 } else { 0 };
                load_frame(&mut cache, ib, &inputs[ib], evict).map_err(|cause| {
                    StitchError::Decode {
                        path: inputs[ib].clone(),
                        cause,
                    }
                })?;
                evict
            }
        };

        let img_a = cache[slot_for_a].as_ref().unwrap();
        let img_b = cache[slot_for_b].as_ref().unwrap();
        debug_assert_eq!(img_a.0, ia);
        debug_assert_eq!(img_b.0, ib);

        let scale_of = |meta: &FrameMeta| (meta.proxy_scale_x, meta.proxy_scale_y);
        let (rotation_clone, inlier_matches_clone) = {
            let edge = &graph.edges[ei];
            (edge.rotation, edge.inlier_matches.clone())
        };
        let geometry = RefineGeometry {
            cam_a: &full_images[ia].camera,
            cam_b: &full_images[ib].camera,
            rotation: &rotation_clone,
        };
        let outcome = refine_correspondences(
            &img_a.1,
            &img_b.1,
            scale_of(&metas[ia]),
            scale_of(&metas[ib]),
            Some(&geometry),
            &inlier_matches_clone,
            &RefineOptions::default(),
        );
        refined_matches += outcome.refined_count;
        fallback_matches += outcome.fallback_count;
        graph.edges[ei].inlier_matches = outcome.refined;

        progress((ei + 1) as f32 / edge_count as f32);
    }
    // cache drops here, freeing the last ≤2 full-res frames.
    Ok(RefinePassResult {
        refined_matches,
        fallback_matches,
    })
}
