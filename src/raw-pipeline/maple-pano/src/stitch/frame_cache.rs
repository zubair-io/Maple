//! 2-entry LRU decode cache helpers for the stage-3 refinement pass (#1254).
//!
//! During full-resolution NCC refinement, each edge's pair of frames is decoded
//! on demand and the cache evicts the frame least needed by the next edge.  At
//! most 2 full-resolution [`PlanarImage`]s are resident simultaneously.

use std::path::PathBuf;

use crate::ingest::{ingest_file, PlanarImage};

/// Decode a frame into the cache at `evict_slot`, replacing whatever was there.
///
/// Returns `Err(message)` if the file fails to decode.
pub(super) fn load_frame(
    cache: &mut [Option<(usize, PlanarImage)>; 2],
    idx: usize,
    path: &PathBuf,
    evict_slot: usize,
) -> Result<(), String> {
    let frame = ingest_file(path).map_err(|e| e.to_string())?;
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
