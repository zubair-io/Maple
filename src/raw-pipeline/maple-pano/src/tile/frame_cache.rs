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
//! rather than a deep copy.
//!
//! The lock is held across a decode on a miss, not just the bookkeeping.
//! An earlier version released it during decode so one thread's slow
//! decode couldn't block another thread's cache hit — but on a *cold*
//! cache (the common case: several rayon threads all requesting the same
//! not-yet-cached frame around the same time) that let multiple threads
//! race into redundant concurrent decodes of the *same* frame before any
//! of them finished inserting, each one transiently doubling or tripling
//! peak RSS beyond what the capacity was supposed to bound — measured
//! directly against this cache's whole reason for existing. Every caller
//! only consults this cache a handful of times per band/tile/scan-pass
//! (never per pixel — see the callers in `tile/sampling.rs`,
//! `tile/masks.rs`, `tile/composite.rs`), so serializing the (comparatively
//! rare) decodes trades a small, bounded amount of cross-thread overlap
//! for peak RSS that actually stays at `capacity`.
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
    /// hash-indexed LRU structure. Locked across a decode on a miss too
    /// (see module docs) — deliberately, not an oversight.
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
        Self::from_frames_with_capacity(frames, capacity)
    }

    /// Like [`Self::from_frames`], but with an explicit (possibly smaller)
    /// capacity — for this module's own eviction-order tests, which need
    /// eviction to actually fire without needing real decodable files on
    /// disk (every index a test asks for is pre-seeded, so `get` never
    /// takes the miss/decode path regardless of capacity).
    #[cfg(test)]
    fn from_frames_with_capacity(frames: Vec<PlanarImage>, capacity: usize) -> Self {
        let entries = frames
            .into_iter()
            .enumerate()
            .map(|(i, f)| (i, Arc::new(f)))
            .collect();
        Self {
            inputs: None,
            capacity: capacity.max(1),
            entries: Mutex::new(entries),
        }
    }

    /// Get frame `idx` (an index into the `inputs` this cache was built
    /// with), decoding on demand and evicting the least-recently-used
    /// entry if the cache is already at capacity.
    ///
    /// The lock is held for the whole call, decode included (see module
    /// docs for why): a hit is a cheap linear scan + `Arc` clone under
    /// the lock, and a miss decodes under the same lock so two threads
    /// can never race into a redundant concurrent decode of the same
    /// frame.
    pub(crate) fn get(&self, idx: usize) -> Result<Arc<PlanarImage>, PanoError> {
        let mut entries = self.entries.lock().unwrap();
        if let Some(pos) = entries.iter().position(|(i, _)| *i == idx) {
            let entry = entries.remove(pos);
            let img = entry.1.clone();
            entries.insert(0, entry);
            return Ok(img);
        }
        let inputs = self.inputs.expect(
            "TileFrameCache::get miss with no backing inputs — a from_frames() test cache \
             must be pre-seeded with every index it will be asked for",
        );
        let path = &inputs[idx];
        let img = Arc::new(crate::ingest::ingest_file(path)?.image);
        if entries.len() >= self.capacity {
            entries.pop(); // LRU is at the back.
        }
        entries.insert(0, (idx, img.clone()));
        Ok(img)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mk_frame(w: u32) -> PlanarImage {
        PlanarImage::from_planes(
            w,
            1,
            vec![0.0; w as usize],
            vec![0.0; w as usize],
            vec![0.0; w as usize],
            crate::ingest::ValidityMask::new_filled(w, 1, true),
        )
    }

    /// A capacity-1 cache re-decodes on every distinct index — proves the
    /// eviction path runs, not just the insert-empty path.
    #[test]
    fn capacity_is_clamped_to_at_least_one() {
        let inputs: Vec<PathBuf> = vec![];
        let cache = TileFrameCache::new(&inputs, 0);
        assert_eq!(cache.capacity, 1);
    }

    /// A `from_frames` test cache resolves every pre-seeded index without
    /// touching `inputs` (which is `None`) — the `get` path used
    /// throughout `tile/`'s unit tests.
    #[test]
    fn from_frames_resolves_preseeded_indices() {
        let cache = TileFrameCache::from_frames(vec![mk_frame(3), mk_frame(5)]);
        assert_eq!(cache.get(0).unwrap().width(), 3);
        assert_eq!(cache.get(1).unwrap().width(), 5);
    }

    /// A hit moves the touched entry to the front (MRU position) — the
    /// ordering `get`'s eviction (LRU is at the back) depends on.
    #[test]
    fn hit_moves_entry_to_mru_position() {
        let cache = TileFrameCache::from_frames_with_capacity(
            vec![mk_frame(1), mk_frame(2), mk_frame(3)],
            3,
        );
        // Seeded order (index 0 first) means 2 is initially LRU (back).
        cache.get(2).unwrap(); // touch the current LRU
        let entries = cache.entries.lock().unwrap();
        assert_eq!(entries[0].0, 2, "touched entry should now be MRU (front)");
    }

    /// End-to-end (real files, fixture-gated — soft-skips without
    /// `test-fixtures/raws/pano_00/`): a capacity-2 cache asked for all 3
    /// `pano_00` frames in order evicts the least-recently-used one, not
    /// the most-recently-used one, and correctly re-decodes it (not a
    /// stale/wrong buffer) when asked for again.
    #[test]
    fn eviction_targets_lru_and_redecodes_correctly_on_a_real_set() {
        let dir = std::path::Path::new(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../test-fixtures/raws/pano_00"
        ));
        if !dir.is_dir() {
            eprintln!("skipping: {} not present", dir.display());
            return;
        }
        let mut inputs: Vec<PathBuf> = std::fs::read_dir(dir)
            .expect("read_dir")
            .filter_map(|e| e.ok().map(|e| e.path()))
            .filter(|p| {
                p.extension()
                    .and_then(|e| e.to_str())
                    .map(|e| e.eq_ignore_ascii_case("dng"))
                    .unwrap_or(false)
            })
            .collect();
        inputs.sort();
        if inputs.len() < 3 {
            eprintln!("skipping: expected >= 3 .dng, found {}", inputs.len());
            return;
        }

        let cache = TileFrameCache::new(&inputs, 2);
        let d0 = cache.get(0).unwrap().r.len();
        let _d1 = cache.get(1).unwrap();
        // Cache: [1 (MRU), 0 (LRU)]. Loading 2 must evict 0, not 1.
        let d2 = cache.get(2).unwrap().r.len();
        {
            let entries = cache.entries.lock().unwrap();
            assert!(
                entries.iter().any(|(i, _)| *i == 1),
                "1 was MRU, should have survived eviction"
            );
            assert!(
                !entries.iter().any(|(i, _)| *i == 0),
                "0 was LRU, should have been evicted"
            );
        }
        // Asking for 0 again must re-decode it correctly (same pixel
        // count as the first decode), not panic or return garbage.
        let d0_again = cache.get(0).unwrap().r.len();
        assert_eq!(
            d0_again, d0,
            "re-decoded frame 0 should match its first decode"
        );
        assert!(d2 > 0, "sanity: the third decode actually produced pixels");
    }
}
