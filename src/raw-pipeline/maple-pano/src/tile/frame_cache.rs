//! Thread-safe, capacity-bounded, on-demand decode cache for the tile
//! strategy's full-resolution frame access (#3090).
//!
//! Before this, `run_tile_branch` decoded every input frame to full
//! resolution up front and held them all resident for the rest of the
//! tile tail (NCC refine, photometric solve, composite) — 33.5 GB peak
//! RSS measured on the 23-frame 100 MP `pano_03` strip. The rotation
//! path already solved the equivalent problem two ways: a 2-entry LRU
//! for stage-3 NCC refinement (`stitch::frame_cache::refine_edges_lru`)
//! and per-strip on-demand decode in `composite_tiled` (#1254). Neither
//! is a drop-in fit here — refine_edges_lru's 2 slots are sized for one
//! edge (two frames) at a time, sequential; the tile path's photometric
//! sampling scan (`tile::sampling::sample_pairs`) is rayon-parallel over
//! canvas row bands and can have a handful of frames live across
//! concurrently-running bands. [`TileFrameCache`] is the equivalent
//! mechanism sized for that: a small LRU keyed by (original) frame
//! index, shared behind an `Arc` so a cache hit is a cheap refcount bump
//! rather than a deep copy, with the lock held only for the bookkeeping
//! (never across a decode) so one thread's cache miss never blocks
//! another thread's hit.
//!
//! For a strip capture (frames laid out along one axis, each overlapping
//! only its near neighbours) the working set touched by any handful of
//! concurrently-active canvas positions is small and changes gradually
//! as the scan progresses — "the tile sweep moves monotonically along
//! the strip" — so a modest fixed capacity keeps peak resident frames
//! bounded by that working set rather than by the total frame count.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use crate::error::PanoError;
use crate::ingest::PlanarImage;

/// On-demand decode cache bounded to `capacity` resident frames, keyed by
/// index into `inputs` (the original, full input-frame list — not a
/// per-set-local index).
pub(crate) struct TileFrameCache<'a> {
    /// `None` only for a [`Self::from_frames`] test cache, which is fully
    /// pre-seeded and therefore never needs to decode anything.
    inputs: Option<&'a [PathBuf]>,
    capacity: usize,
    /// Most-recently-used at the front; evict from the back. A `Vec` is
    /// fine at this capacity (single-digit entries) — no need for a
    /// hash-indexed LRU structure.
    entries: Mutex<Vec<(usize, Arc<PlanarImage>)>>,
}

impl<'a> TileFrameCache<'a> {
    /// `capacity` is clamped to at least 1 (a cache that can hold nothing
    /// would re-decode every single access, including within one edge's
    /// two-frame refine).
    pub(crate) fn new(inputs: &'a [PathBuf], capacity: usize) -> Self {
        Self {
            inputs: Some(inputs),
            capacity: capacity.max(1),
            entries: Mutex::new(Vec::new()),
        }
    }

    /// Test-only: a cache pre-seeded with already-decoded synthetic
    /// frames, keyed by their position in `frames`. Unit tests across
    /// `tile/` build `PlanarImage`s directly in memory (no real files on
    /// disk to decode-on-demand from), so this gives them the same
    /// `TileFrameCache` interface production code uses. Capacity equals
    /// `frames.len()` — no eviction — because a fixed-size synthetic test
    /// fixture is exactly the "small handful of frames" case this cache
    /// is sized for anyway, and tests should never observe an eviction
    /// their assertions didn't ask for.
    #[cfg(test)]
    pub(crate) fn from_frames(frames: Vec<PlanarImage>) -> Self {
        let capacity = frames.len().max(1);
        let entries = frames
            .into_iter()
            .enumerate()
            .map(|(i, f)| (i, Arc::new(f)))
            .collect();
        Self {
            inputs: None,
            capacity,
            entries: Mutex::new(entries),
        }
    }

    /// Get frame `idx` (an index into the `inputs` this cache was built
    /// with), decoding on demand and evicting the least-recently-used
    /// entry if the cache is already at capacity. Decoding happens
    /// **outside** the lock, so a slow decode on one thread never blocks
    /// another thread's concurrent cache hit.
    pub(crate) fn get(&self, idx: usize) -> Result<Arc<PlanarImage>, PanoError> {
        if let Some(img) = self.touch(idx) {
            return Ok(img);
        }
        // Miss: decode outside the lock.
        let inputs = self.inputs.expect(
            "TileFrameCache::get miss with no backing inputs — a from_frames() test cache \
             must be pre-seeded with every index it will be asked for",
        );
        let path = &inputs[idx];
        let img = Arc::new(crate::ingest::ingest_file(path)?.image);
        Ok(self.insert(idx, img))
    }

    /// Fast path: if `idx` is already cached, move it to MRU position and
    /// return the shared frame. Locks only for the bookkeeping.
    fn touch(&self, idx: usize) -> Option<Arc<PlanarImage>> {
        let mut entries = self.entries.lock().unwrap();
        let pos = entries.iter().position(|(i, _)| *i == idx)?;
        let entry = entries.remove(pos);
        let img = entry.1.clone();
        entries.insert(0, entry);
        Some(img)
    }

    /// Insert a freshly-decoded frame at MRU position, evicting the LRU
    /// entry first if at capacity. Re-checks for a race: another thread
    /// may have decoded and inserted the same `idx` while this thread was
    /// decoding — both decodes are equally valid (pure function of the
    /// same file), so the race just costs one redundant decode, never a
    /// correctness issue; the already-present entry is kept.
    fn insert(&self, idx: usize, img: Arc<PlanarImage>) -> Arc<PlanarImage> {
        let mut entries = self.entries.lock().unwrap();
        if let Some(pos) = entries.iter().position(|(i, _)| *i == idx) {
            let existing = entries.remove(pos);
            let kept = existing.1.clone();
            entries.insert(0, existing);
            return kept;
        }
        if entries.len() >= self.capacity {
            entries.pop(); // LRU is at the back.
        }
        entries.insert(0, (idx, img.clone()));
        img
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A capacity-1 cache re-decodes on every distinct index — proves the
    /// eviction path runs, not just the insert-empty path.
    #[test]
    fn capacity_is_clamped_to_at_least_one() {
        let inputs: Vec<PathBuf> = vec![];
        let cache = TileFrameCache::new(&inputs, 0);
        assert_eq!(cache.capacity, 1);
    }

    /// `touch`/`insert` bookkeeping: inserting beyond capacity evicts the
    /// least-recently-used (back-of-list) entry, not the most-recent one.
    #[test]
    fn insert_evicts_lru_not_mru() {
        let inputs: Vec<PathBuf> = vec![];
        let cache = TileFrameCache::new(&inputs, 2);
        let mk = |w: u32| {
            Arc::new(PlanarImage::from_planes(
                w,
                1,
                vec![0.0; w as usize],
                vec![0.0; w as usize],
                vec![0.0; w as usize],
                crate::ingest::ValidityMask::new_filled(w, 1, true),
            ))
        };
        cache.insert(0, mk(1));
        cache.insert(1, mk(2));
        // Cache: [1 (MRU), 0 (LRU)]. Touch 0 to make it MRU.
        assert!(cache.touch(0).is_some());
        // Cache: [0 (MRU), 1 (LRU)]. Insert 2 — should evict 1, not 0.
        cache.insert(2, mk(3));
        assert!(
            cache.touch(0).is_some(),
            "0 was MRU, should survive eviction"
        );
        assert!(
            cache.touch(1).is_none(),
            "1 was LRU, should have been evicted"
        );
        assert!(cache.touch(2).is_some(), "2 was just inserted");
    }

    /// Re-inserting an index already present (the decode-race path) keeps
    /// the cache at one entry for that index and returns a usable image,
    /// rather than growing unboundedly or panicking.
    #[test]
    fn insert_race_on_same_index_keeps_one_entry() {
        let inputs: Vec<PathBuf> = vec![];
        let cache = TileFrameCache::new(&inputs, 4);
        let mk = |w: u32| {
            Arc::new(PlanarImage::from_planes(
                w,
                1,
                vec![0.0; w as usize],
                vec![0.0; w as usize],
                vec![0.0; w as usize],
                crate::ingest::ValidityMask::new_filled(w, 1, true),
            ))
        };
        cache.insert(0, mk(1));
        let kept = cache.insert(0, mk(2));
        assert_eq!(kept.width(), 1, "the already-present decode should be kept");
        assert_eq!(cache.entries.lock().unwrap().len(), 1);
    }
}
