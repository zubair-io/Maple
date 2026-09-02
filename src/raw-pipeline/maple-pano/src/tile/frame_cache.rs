//! Thread-safe, capacity-bounded, on-demand decode cache for the tile
//! strategy's full-resolution frame access (#3090, redone under #3197
//! after the first attempt — #3146 — was reverted for serializing the
//! whole tile tail).
//!
//! ## What went wrong the first time (#3197)
//!
//! #3146's `TileFrameCache` held **one cache-wide `Mutex` across the
//! whole decode** on a miss — deliberately, to stop two threads racing
//! into a redundant concurrent decode of the same frame. That reasoning
//! was sound for the "don't decode the same frame twice" goal but wrong
//! about its cost: a 100 MP decode takes on the order of a second, and
//! with that lock held for the whole call, *every other frame's* cache
//! access serializes behind it too — not just repeat requests for the
//! same frame. Compounding that, `tile::sampling::sample_pairs` called
//! `cache.get()` **once per sample point** from inside a rayon-parallel
//! scan, so on `pano_03` (23 frames, capacity 8) up to 19 worker threads
//! ended up piled on that one lock at once, almost all of them idle in
//! `pthread_mutex_lock_wait` while at most one decode ran — the photometric
//! solve degenerated to serial repeated 100 MP decodes. Measured: 531.6 s
//! before, still unfinished after 12.5 h with #3146.
//!
//! ## The fix here has two independent parts
//!
//! 1. **Per-frame locking, not a cache-wide one.** Each frame index gets
//!    its own [`std::sync::OnceLock`] — the standard library's built-in
//!    "compute once, block concurrent callers on the SAME cell, never on
//!    a different one" primitve. The cache's own `Mutex` protects only
//!    the bookkeeping map (which indices are cached, LRU order) for a
//!    lookup/insert/evict — microseconds, never held across a decode. A
//!    miss on frame *i* now only blocks other callers also asking for
//!    frame *i* at that exact moment; a concurrent request for frame *j*
//!    proceeds immediately, decodes independently, and never touches
//!    frame *i*'s cell.
//! 2. **Pin per spatial unit, not per sample.** See `frame_window.rs`:
//!    callers no longer call `get()` from inside a per-pixel loop. They
//!    resolve which frames a whole band/tile of work touches once, pin
//!    those via [`TileFrameCache::pin_many`], and only then run the
//!    per-pixel work against the pinned set — with successive spatial
//!    units processed in geometry-driven sequential groups ("waves") so
//!    the number of frames pinned at once stays bounded.
//!
//! Both matter independently: per-frame locking alone still leaves the
//! cache thrashing if callers keep asking for a different frame on every
//! sample (each miss now runs concurrently instead of serially, but the
//! *decode churn itself* — evict-then-immediately-need-it-again — is
//! unchanged); the per-unit pinning alone still serializes unrelated
//! decodes behind one lock. Together they bound both the amount of
//! decoding work AND how much of it can run in parallel.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};

use crate::error::PanoError;
use crate::ingest::PlanarImage;

/// A decode result, memoized behind a [`OnceLock`] so concurrent callers
/// for the same frame index block on each other (dedup) without ever
/// touching the cache-wide bookkeeping lock. The error side stores a
/// plain `String`, not `PanoError` — `PanoError` isn't `Clone` (its
/// `image`/`io` sources aren't), and this needs to be handed back
/// verbatim to every caller that was waiting on the same cell, so the
/// decode path stringifies once here rather than the cache trying to
/// clone a non-`Clone` error on every subsequent hit.
type DecodeCell = Arc<OnceLock<Result<Arc<PlanarImage>, String>>>;

struct CacheState {
    slots: HashMap<usize, DecodeCell>,
    /// Recency order, oldest at the front. Only ever touched under
    /// `TileFrameCache::state`'s lock, alongside `slots` — never across a
    /// decode (see module docs).
    order: Vec<usize>,
}

impl CacheState {
    fn touch(&mut self, idx: usize) {
        if let Some(pos) = self.order.iter().position(|&i| i == idx) {
            self.order.remove(pos);
        }
        self.order.push(idx);
    }
}

/// On-demand decode cache bounded to `capacity` resident frames, keyed by
/// index into the original input-frame list (`poses[i].frame_idx` /
/// `FrameMeta` space), not a position local to some filtered subset.
///
/// Cloning a hit is a cheap `Arc` refcount bump; a miss decodes exactly
/// once regardless of how many callers ask for the same index at once.
/// See the module docs for the locking model.
pub(crate) struct TileFrameCache<'a> {
    /// `None` only for a [`Self::from_frames`] / [`Self::with_decoder`]
    /// test cache — production caches are always backed by real paths.
    inputs: Option<&'a [PathBuf]>,
    /// Test-only override of the decode step, so cache concurrency and
    /// eviction properties can be tested with a synthetic, instrumented
    /// "decoder" instead of real fixture files (#3197).
    #[cfg(test)]
    test_decoder: Option<Box<dyn Fn(usize) -> Result<PlanarImage, String> + Send + Sync + 'a>>,
    capacity: usize,
    state: Mutex<CacheState>,
}

impl<'a> TileFrameCache<'a> {
    /// `capacity` is clamped to at least 1 — a cache that could hold
    /// nothing would re-decode on every single access, including within
    /// one edge's two-frame refine.
    pub(crate) fn new(inputs: &'a [PathBuf], capacity: usize) -> Self {
        Self {
            inputs: Some(inputs),
            #[cfg(test)]
            test_decoder: None,
            capacity: capacity.max(1),
            state: Mutex::new(CacheState {
                slots: HashMap::new(),
                order: Vec::new(),
            }),
        }
    }

    /// Test-only: a cache pre-seeded with already-decoded synthetic
    /// frames, keyed by their position in `frames`. Unit tests across
    /// `tile/` build `PlanarImage`s directly in memory (no files on disk
    /// to decode-on-demand from), so this gives them the same
    /// `TileFrameCache` interface production code uses. Unbounded
    /// capacity (`frames.len()`) — a fixed synthetic fixture is exactly
    /// the "small handful of frames" case this cache is sized for, and
    /// tests should never observe an eviction their assertions didn't
    /// ask for.
    #[cfg(test)]
    pub(crate) fn from_frames(frames: Vec<PlanarImage>) -> Self {
        let capacity = frames.len().max(1);
        let mut slots = HashMap::new();
        let mut order = Vec::new();
        for (i, f) in frames.into_iter().enumerate() {
            let cell: DecodeCell = Arc::new(OnceLock::new());
            let _ = cell.set(Ok(Arc::new(f)));
            slots.insert(i, cell);
            order.push(i);
        }
        Self {
            inputs: None,
            test_decoder: None,
            capacity,
            state: Mutex::new(CacheState { slots, order }),
        }
    }

    /// Test-only: a cache with no backing files at all, whose decode step
    /// is `decoder` — used to test concurrency (does a miss on frame *i*
    /// actually run in parallel with a miss on frame *j*?) and eviction
    /// without needing real fixtures on disk.
    #[cfg(test)]
    pub(crate) fn with_decoder(
        capacity: usize,
        decoder: impl Fn(usize) -> Result<PlanarImage, String> + Send + Sync + 'a,
    ) -> Self {
        Self {
            inputs: None,
            test_decoder: Some(Box::new(decoder)),
            capacity: capacity.max(1),
            state: Mutex::new(CacheState {
                slots: HashMap::new(),
                order: Vec::new(),
            }),
        }
    }

    /// Get frame `idx` (an index into the `inputs` this cache was built
    /// with), decoding on demand and evicting the least-recently-touched
    /// entry from the bookkeeping map if it's already at capacity.
    ///
    /// The cache-wide lock is held only to look up or insert the entry's
    /// `OnceLock` cell — a handful of hash-map operations, never a
    /// decode. The actual decode (on a miss) runs after that lock is
    /// released, inside `OnceLock::get_or_init`, whose own per-cell
    /// synchronization is what dedups concurrent callers for the *same*
    /// index without blocking callers of any *other* index.
    pub(crate) fn get(&self, idx: usize) -> Result<Arc<PlanarImage>, PanoError> {
        let cell = {
            let mut state = self.state.lock().unwrap();
            if let Some(existing) = state.slots.get(&idx) {
                let cell = existing.clone();
                state.touch(idx);
                cell
            } else {
                if state.slots.len() >= self.capacity {
                    if let Some(evict) = state.order.first().copied() {
                        state.order.remove(0);
                        state.slots.remove(&evict);
                    }
                }
                let cell: DecodeCell = Arc::new(OnceLock::new());
                state.slots.insert(idx, cell.clone());
                state.order.push(idx);
                cell
            }
        };

        match cell.get_or_init(|| self.decode(idx)) {
            Ok(img) => Ok(img.clone()),
            Err(msg) => Err(PanoError::InvalidOptions(format!(
                "TileFrameCache: frame {idx} failed to decode: {msg}"
            ))),
        }
    }

    /// The bound on resident frames this cache was built with. Callers
    /// that pin a working set (`frame_window`'s wave grouping) size that
    /// set to this so a wave's own frames don't evict each other.
    pub(crate) fn capacity(&self) -> usize {
        self.capacity
    }

    /// Pin several distinct frame indices at once — the entry point
    /// `frame_window`'s wave grouping uses so a wave's frames are all
    /// resolved together, decoding whichever ones are still misses
    /// concurrently rather than one at a time.
    ///
    /// Concurrency here is capped at [`DECODE_CONCURRENCY`], deliberately
    /// *lower* than the cache's own residency `capacity`: those are two
    /// different budgets. `capacity` bounds how many *already-decoded*
    /// images stay resident for reuse; this bounds how many *decodes*
    /// (each a full 100 MP RAW demosaic/develop, with its own multi-GB
    /// transient scratch well above the ~1.2 GB the finished image ends
    /// up costing) run at once. Measured on `pano_03`: letting a
    /// capacity-6 wave decode all 6 misses at once produced a sharp,
    /// short-lived RSS spike to ~30 GB (vs. a ~12-16 GB steady state the
    /// rest of the run) — the transient decode scratch, not the cached
    /// images, was the dominant cost. Capping concurrent decodes at 2
    /// matches the rotation path's own established precedent for
    /// full-resolution decode memory safety (`stitch/frame_cache.rs`'s
    /// 2-entry LRU for stage-3 refinement) and keeps that spike bounded
    /// without giving up the core fix: distinct frames still decode
    /// without serializing behind one global lock (`get`'s per-frame
    /// `OnceLock`), just not unboundedly many at once.
    ///
    /// Returns `(idx, image)` pairs in `indices` order.
    pub(crate) fn pin_many(
        &self,
        indices: &[usize],
    ) -> Result<Vec<(usize, Arc<PlanarImage>)>, PanoError> {
        use rayon::prelude::*;
        const DECODE_CONCURRENCY: usize = 2;
        let mut out = Vec::with_capacity(indices.len());
        for chunk in indices.chunks(DECODE_CONCURRENCY) {
            let mut part: Vec<(usize, Arc<PlanarImage>)> = chunk
                .par_iter()
                .map(|&i| self.get(i).map(|img| (i, img)))
                .collect::<Result<Vec<_>, PanoError>>()?;
            out.append(&mut part);
        }
        Ok(out)
    }

    fn decode(&self, idx: usize) -> Result<Arc<PlanarImage>, String> {
        #[cfg(test)]
        if let Some(decoder) = &self.test_decoder {
            return decoder(idx).map(Arc::new);
        }
        let inputs = self
            .inputs
            .expect("TileFrameCache::get miss with no backing inputs");
        let path = inputs
            .get(idx)
            .ok_or_else(|| format!("index {idx} out of range for {} inputs", inputs.len()))?;
        crate::ingest::ingest_file(path)
            .map(|f| Arc::new(f.image))
            .map_err(|e| e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Barrier;
    use std::time::Duration;

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

    #[test]
    fn capacity_is_clamped_to_at_least_one() {
        let inputs: Vec<PathBuf> = vec![];
        let cache = TileFrameCache::new(&inputs, 0);
        assert_eq!(cache.capacity, 1);
    }

    #[test]
    fn from_frames_resolves_preseeded_indices() {
        let cache = TileFrameCache::from_frames(vec![mk_frame(3), mk_frame(5)]);
        assert_eq!(cache.get(0).unwrap().width(), 3);
        assert_eq!(cache.get(1).unwrap().width(), 5);
    }

    /// Out-of-range access returns a typed error, not a panic — checked
    /// against a real (empty) `inputs` backing, no fixtures needed.
    #[test]
    fn get_rejects_out_of_range_idx() {
        let inputs: Vec<PathBuf> = vec![];
        let cache = TileFrameCache::new(&inputs, 4);
        assert!(cache.get(0).is_err());
    }

    /// The property #3197 is really about: a miss on frame *i* must not
    /// block a concurrent miss on frame *j*. A synthetic decoder that
    /// blocks on a barrier only completes once BOTH threads are inside
    /// their decode call at the same time — if the cache still
    /// serialized decodes behind one lock (the #3146 bug), the second
    /// thread would never reach the barrier while the first is still
    /// "decoding", and this test would hang / time out.
    #[test]
    fn distinct_indices_decode_concurrently() {
        let barrier = Arc::new(Barrier::new(2));
        let cache = Arc::new(TileFrameCache::with_decoder(8, {
            let barrier = barrier.clone();
            move |idx: usize| {
                // Every caller must reach this point before any of them
                // returns — provable only if the cache let both decodes
                // run at once.
                barrier.wait();
                Ok(mk_frame(idx as u32 + 1))
            }
        }));

        let c0 = cache.clone();
        let t0 = std::thread::spawn(move || c0.get(0).unwrap().width());
        let c1 = cache.clone();
        let t1 = std::thread::spawn(move || c1.get(1).unwrap().width());

        // If either thread hangs (serialized behind a single lock), this
        // join would block forever; a bounded test harness will time the
        // whole test out rather than hang silently.
        assert_eq!(t0.join().unwrap(), 1);
        assert_eq!(t1.join().unwrap(), 2);
    }

    /// The other half of the property: concurrent callers asking for the
    /// SAME index must still only decode it once (dedup), even though
    /// distinct indices no longer serialize behind each other.
    #[test]
    fn same_index_decodes_at_most_once_under_concurrency() {
        let decode_count = Arc::new(AtomicUsize::new(0));
        let cache = Arc::new(TileFrameCache::with_decoder(8, {
            let decode_count = decode_count.clone();
            move |idx: usize| {
                decode_count.fetch_add(1, Ordering::SeqCst);
                std::thread::sleep(Duration::from_millis(20));
                Ok(mk_frame(idx as u32 + 1))
            }
        }));

        let handles: Vec<_> = (0..6)
            .map(|_| {
                let cache = cache.clone();
                std::thread::spawn(move || cache.get(0).unwrap().width())
            })
            .collect();
        for h in handles {
            assert_eq!(h.join().unwrap(), 1);
        }
        assert_eq!(
            decode_count.load(Ordering::SeqCst),
            1,
            "6 concurrent callers for the same index must decode it exactly once"
        );
    }

    /// Proves real parallelism, not just "didn't deadlock": several
    /// distinct indices' decodes must overlap in time. Each decode call
    /// bumps a shared "currently decoding" counter, records the running
    /// max, holds briefly, then decrements — a cache that (re)serializes
    /// decodes behind one global lock could never show a max above 1.
    #[test]
    fn n_distinct_frames_decode_concurrently() {
        const N: usize = 5;
        let active = Arc::new(AtomicUsize::new(0));
        let max_active = Arc::new(AtomicUsize::new(0));
        let cache = Arc::new(TileFrameCache::with_decoder(N, {
            let active = active.clone();
            let max_active = max_active.clone();
            move |idx: usize| {
                let now = active.fetch_add(1, Ordering::SeqCst) + 1;
                max_active.fetch_max(now, Ordering::SeqCst);
                std::thread::sleep(Duration::from_millis(30));
                active.fetch_sub(1, Ordering::SeqCst);
                Ok(mk_frame(idx as u32 + 1))
            }
        }));

        let handles: Vec<_> = (0..N)
            .map(|i| {
                let cache = cache.clone();
                std::thread::spawn(move || cache.get(i).unwrap())
            })
            .collect();
        for h in handles {
            h.join().unwrap();
        }
        assert!(
            max_active.load(Ordering::SeqCst) >= 2,
            "expected multiple distinct-index decodes to overlap, max observed: {}",
            max_active.load(Ordering::SeqCst)
        );
    }

    /// `pin_many` fetches distinct indices via rayon — the entry point
    /// `frame_window`'s wave grouping uses. Confirms it decodes each
    /// requested index and returns them in request order.
    #[test]
    fn pin_many_resolves_all_requested_indices_in_order() {
        let cache = TileFrameCache::with_decoder(8, |idx: usize| Ok(mk_frame(idx as u32 + 1)));
        let pinned = cache.pin_many(&[2, 0, 1]).unwrap();
        let widths: Vec<u32> = pinned.iter().map(|(_, img)| img.width()).collect();
        assert_eq!(widths, vec![3, 1, 2]);
    }

    /// A capacity-2 cache asked for 3 distinct indices in sequence must
    /// evict the least-recently-touched one, not the most-recently-used
    /// one, and correctly re-decode it (not return a stale/wrong buffer)
    /// when asked for again. Uses the synthetic decoder — no fixtures.
    #[test]
    fn eviction_targets_lru_and_redecodes_correctly() {
        let decode_count = Arc::new(AtomicUsize::new(0));
        let cache = TileFrameCache::with_decoder(2, {
            let decode_count = decode_count.clone();
            move |idx: usize| {
                decode_count.fetch_add(1, Ordering::SeqCst);
                Ok(mk_frame(idx as u32 + 10))
            }
        });

        cache.get(0).unwrap();
        cache.get(1).unwrap();
        // Cache: [0 (LRU), 1 (MRU)]. Loading 2 must evict 0, not 1.
        cache.get(2).unwrap();
        {
            let state = cache.state.lock().unwrap();
            assert!(state.slots.contains_key(&1), "1 was MRU, should survive");
            assert!(
                !state.slots.contains_key(&0),
                "0 was LRU, should be evicted"
            );
        }
        assert_eq!(decode_count.load(Ordering::SeqCst), 3);
        // Re-decode of evicted index 0 must happen (a 4th decode call)
        // and return correct content, not stale/garbage data.
        assert_eq!(cache.get(0).unwrap().width(), 10);
        assert_eq!(
            decode_count.load(Ordering::SeqCst),
            4,
            "evicted index must trigger a fresh decode, not a phantom hit"
        );
    }

    /// End-to-end real-file sanity check (fixture-gated, soft-skips
    /// without `test-fixtures/raws/pano_00/`): the production decode
    /// path (`ingest_file`, not the synthetic decoder) actually works
    /// through the cache.
    #[test]
    fn real_decode_path_resolves_a_real_frame() {
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
        if inputs.is_empty() {
            eprintln!("skipping: no .dng found in {}", dir.display());
            return;
        }
        let cache = TileFrameCache::new(&inputs, 4);
        let img = cache.get(0).unwrap();
        assert!(img.width() > 0 && img.height() > 0);
    }
}
