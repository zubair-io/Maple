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
/// Prefers to evict the slot that is *not* referenced by either index in
/// `next_pair` — if both or neither are referenced, evicts slot 1
/// (arbitrary tiebreak, deterministic).
pub(super) fn choose_evict_slot(
    cache: &[Option<(usize, PlanarImage)>; 2],
    _want_a: usize,
    _want_b: usize,
    next_pair: Option<(usize, usize)>,
) -> usize {
    let Some((na, nb)) = next_pair else {
        return 1; // Last edge: pick any slot.
    };
    for (slot, entry) in cache.iter().enumerate() {
        if let Some((idx, _)) = entry {
            if *idx != na && *idx != nb {
                return slot; // This slot's frame is not needed next.
            }
        } else {
            return slot; // Empty slot — free to use.
        }
    }
    1 // Both slots are referenced by next_pair — evict slot 1.
}
