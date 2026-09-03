//! Bounded LRU cache for fitted [`ProfileCurve`]s.
//!
//! `fit_curve_from_raw_display` / `fit_curve_from_bytes_display` run
//! end-to-end on every render — JPEG extract + decode + per-channel +
//! luminance CDF matching over the full source crop. On the 100 MP DJI
//! slider-budget reference frame that blows the 16 ms per-tick budget
//! (CLAUDE.md § Performance invariants). This cache lets second-and-after
//! ticks on the same RAW reuse the previously fitted curve.
//!
//! Key shapes (see [`CacheKey`]):
//! - [`CacheKey::Path`] — `(canonical path, mtime, quality)` for native
//!   callers. Mtime catches "user re-edited and re-exported the RAW out from
//!   under us"; the path discriminates between fixtures.
//! - [`CacheKey::Bytes`] — `(hash, quality)` where the hash is a 64-bit
//!   blake3 digest of the first 64 KB + last 64 KB + total length of the
//!   bytes. Full blake3 of a 50 MB RAW alone is ~50 ms (would defeat the
//!   cache); prefix+suffix+length is collision-free across distinct RAW
//!   files in practice and runs in microseconds. blake3 is already a
//!   workspace dependency.
//!
//! Keying invariant (#1085): the fit is PINNED to the default adjustment
//! model — every fit entry develops `AdjustmentModel::default()` with only
//! `auto_exposure: Off` pinned and the caller's `profile` carried (see
//! `pipeline::render::auto_fit::fit_develop_model`), never the caller's live
//! edit model. The fitted curve/LUT are therefore a pure function of the RAW
//! at a given develop quality, so `(raw identity, quality)` needs no
//! adjustment digest or generation counter: slider ticks cannot change what
//! a fit would produce, and a warm entry is always exactly what a cold fit
//! would re-compute.
//!
//! The fit's [`FitOrigin`] joined the key in #3233 / #3235 — see its doc for
//! the three producers that used to collide on one key.
//!
//! The develop [`RenderQuality`] joined the key in #2035: the fit develop
//! runs at the caller's quality (`Preview` = half-res demosaic), so a
//! Preview-fit and a Full-fit of the same RAW are DIFFERENT artifacts —
//! under the old quality-less key, whichever path fit first (the
//! Full-quality CPU/CLI render vs the Preview-quality Apple GPU-live host)
//! silently served its artifacts to the other. Develop SIZE stays out of the
//! key — pre-existing contract: the standalone fit entries derive their
//! proxy size deterministically from the RAW
//! (`auto_fit::auto_fit_max_long_edge`), so per `(raw, quality)` there is
//! one canonical standalone fit.

use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::SystemTime;

use crate::pipeline::RenderQuality;

use super::curve::ProfileCurve;
use super::lut::ColorLut;

/// Shared capacity, in entries, of BOTH the curve and LUT caches. The two
/// stores are touched with the same keys in the same order (a fit inserts
/// both; a render bumps both), so equal capacities keep them evicting in
/// lockstep — a curve can't outlive its paired residual by 24 generations the
/// way the old 32-vs-8 split allowed (#1085). Sized for the LUT, the larger
/// artifact: a 49³ [`ColorLut`] is 49³×3×4 ≈ 1.4 MB, so 32 entries cap at
/// ~45 MB — still well under one decoded frame (a 100 MP f32 buffer is
/// ~1.2 GB), and a re-fit costs a multi-second develop, so trading bounded
/// memory for fewer refits is the right side of the budget. The curve side is
/// noise (~2 KB each → ~64 KB total).
const CAPACITY: usize = 32;

/// Bytes-hash discriminator window. Prefix + suffix bytes hashed; tunable.
const HASH_WINDOW: usize = 64 * 1024;

/// Which develop the cached artifacts were fitted from (#3233 / #3235).
///
/// Three producers used to write the same `(raw, quality)` key and did not
/// agree on what an entry held: the render path fits from whatever scene
/// it is rendering (a 768 px thumbnail develop and a native-resolution
/// develop yield different ACR-fit pairs), the standalone fit entries fit
/// from the canonical proxy develop, and the #812 curve-only entry stores
/// a display-CDF curve with no residual at all (its acr2 sibling stores an
/// IDENTITY curve plus a LUT). Whichever ran first served the others —
/// deterministic in the app's usual one-path-per-image flow, but a race
/// under parallel tests (`profile_curve_matches_core_fit`,
/// `render_bytes_sized_with_film_empty_lut_matches_render_bytes_sized`)
/// and a silent quality downgrade whenever a sized render preceded a full
/// one in the same process. Keying on the origin makes every entry exactly
/// what a cold fit at that key would recompute, which is the only property
/// that makes concurrent misses benign (both fits are identical).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum FitOrigin {
    /// The standalone proxy develop (`auto_fit::auto_fit_max_long_edge`):
    /// what `fit_auto_profile_from_raw`, `maple_gpu_fit_auto_profile`,
    /// `maple_compute_auto_profile_lut` and the WASM live path produce and
    /// look up. `CacheKey::from_path` / `from_bytes` default to it.
    Standalone,
    /// A render's own develop at this long-edge cap (`None` = native
    /// resolution). A native-resolution render of a sensor the standalone
    /// fit also develops at native resolution keys as [`Standalone`]
    /// instead — the pixels are the same (`auto_fit::render_fit_origin`).
    Render(Option<u32>),
    /// The #812 curve-only display-CDF fit (`fit_profile_curve_from_raw` /
    /// `maple_compute_profile_curve`) — a different artifact from the pair
    /// the other origins store under the same raw + quality.
    CurveOnly,
}

/// Cache key shape — see module doc. `quality` is the develop quality the
/// fit ran at (#2035) — Preview- and Full-fit artifacts must never serve
/// each other; `origin` is the develop the artifacts were fitted from
/// (#3233 / #3235) — see [`FitOrigin`].
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum CacheKey {
    Path {
        path: PathBuf,
        mtime: SystemTime,
        quality: RenderQuality,
        origin: FitOrigin,
    },
    Bytes {
        hash: u64,
        quality: RenderQuality,
        origin: FitOrigin,
    },
}

impl CacheKey {
    /// Build a [`CacheKey::Path`] from a RAW file path + the develop quality
    /// the fit runs at. Returns `None` if the file is missing, can't be
    /// canonicalized, or `metadata` / `modified()` fail (file without an
    /// mtime, e.g. some virtual filesystems).
    ///
    /// Canonicalization resolves symlinks and `..` segments so two callers
    /// referring to the same file through different paths share a cache
    /// entry — matches the module doc's "canonical path" claim.
    pub fn from_path(path: &Path, quality: RenderQuality) -> Option<Self> {
        let canonical = std::fs::canonicalize(path).ok()?;
        let meta = std::fs::metadata(&canonical).ok()?;
        let mtime = meta.modified().ok()?;
        Some(CacheKey::Path {
            path: canonical,
            mtime,
            quality,
            origin: FitOrigin::Standalone,
        })
    }

    /// The same raw + quality, re-keyed to another [`FitOrigin`].
    pub fn with_origin(self, origin: FitOrigin) -> Self {
        match self {
            CacheKey::Path {
                path,
                mtime,
                quality,
                ..
            } => CacheKey::Path {
                path,
                mtime,
                quality,
                origin,
            },
            CacheKey::Bytes { hash, quality, .. } => CacheKey::Bytes {
                hash,
                quality,
                origin,
            },
        }
    }

    /// The develop the artifacts under this key were fitted from.
    pub fn origin(&self) -> FitOrigin {
        match self {
            CacheKey::Path { origin, .. } | CacheKey::Bytes { origin, .. } => *origin,
        }
    }

    /// Build a [`CacheKey::Bytes`] from in-memory RAW bytes + the develop
    /// quality the fit runs at. Uses a 64-bit truncation of blake3 over
    /// (prefix, suffix, length) — see module doc for the cost rationale.
    pub fn from_bytes(bytes: &[u8], quality: RenderQuality) -> Self {
        let mut hasher = blake3::Hasher::new();
        let head_end = bytes.len().min(HASH_WINDOW);
        hasher.update(&bytes[..head_end]);
        // Hash the tail HASH_WINDOW bytes whenever the input is longer
        // than the prefix window — even when overlapping (HASH_WINDOW < len
        // <= 2*HASH_WINDOW). Pre-fix gate `> HASH_WINDOW * 2` let inputs
        // in that range skip the tail entirely, so two slices with matching
        // prefix + length but differing tails collided to the same key.
        if bytes.len() > HASH_WINDOW {
            let tail_start = bytes.len() - HASH_WINDOW;
            hasher.update(&bytes[tail_start..]);
        }
        hasher.update(&(bytes.len() as u64).to_le_bytes());
        let digest = hasher.finalize();
        let bytes_out = digest.as_bytes();
        let hash = u64::from_le_bytes([
            bytes_out[0],
            bytes_out[1],
            bytes_out[2],
            bytes_out[3],
            bytes_out[4],
            bytes_out[5],
            bytes_out[6],
            bytes_out[7],
        ]);
        CacheKey::Bytes {
            hash,
            quality,
            origin: FitOrigin::Standalone,
        }
    }
}

struct LruInner {
    map: HashMap<CacheKey, ProfileCurve>,
    order: VecDeque<CacheKey>,
}

impl LruInner {
    fn new() -> Self {
        Self {
            map: HashMap::with_capacity(CAPACITY),
            order: VecDeque::with_capacity(CAPACITY),
        }
    }
}

fn cell() -> &'static Mutex<LruInner> {
    static CELL: OnceLock<Mutex<LruInner>> = OnceLock::new();
    CELL.get_or_init(|| Mutex::new(LruInner::new()))
}

/// Look up `key` in the cache. Returns a clone of the cached curve on
/// hit, `None` on miss. The clone keeps the API simple — callers don't
/// hold the lock past the lookup, and `ProfileCurve` is ~2 KB so the
/// copy is well below the budget the cache exists to protect.
pub fn get(key: &CacheKey) -> Option<ProfileCurve> {
    let mut guard = cell().lock().ok()?;
    let curve = guard.map.get(key).cloned()?;
    // Move the key to the back of the order queue (most-recently used).
    if let Some(pos) = guard.order.iter().position(|k| k == key) {
        let k = guard.order.remove(pos).unwrap();
        guard.order.push_back(k);
    }
    Some(curve)
}

/// Insert `curve` under `key`. Evicts the oldest entry when at capacity.
/// If `key` is already present, replaces the value in place and bumps it
/// to the most-recently-used end of the order queue.
pub fn insert(key: CacheKey, curve: ProfileCurve) {
    let Ok(mut guard) = cell().lock() else { return };
    if guard.map.contains_key(&key) {
        // Update value + bump to MRU.
        guard.map.insert(key.clone(), curve);
        if let Some(pos) = guard.order.iter().position(|k| k == &key) {
            let k = guard.order.remove(pos).unwrap();
            guard.order.push_back(k);
        }
        return;
    }
    if guard.order.len() >= CAPACITY {
        if let Some(oldest) = guard.order.pop_front() {
            guard.map.remove(&oldest);
        }
    }
    guard.order.push_back(key.clone());
    guard.map.insert(key, curve);
}

// ---------------------------------------------------------------------------
// Parallel LUT cache.
//
// The per-image color LUT (`super::lut::ColorLut`, #913 successor to the #550
// per-channel curve) has the same fit-on-every-render cost profile as the
// curve, so it gets its own bounded LRU keyed on the SAME [`CacheKey`]. This is
// a deliberate parallel structure rather than a generic LRU: the curve cache
// above stays byte-for-byte intact while the LUT path lands incrementally.
// ---------------------------------------------------------------------------

struct LutLruInner {
    map: HashMap<CacheKey, ColorLut>,
    order: VecDeque<CacheKey>,
}

impl LutLruInner {
    fn new() -> Self {
        Self {
            map: HashMap::with_capacity(CAPACITY),
            order: VecDeque::with_capacity(CAPACITY),
        }
    }
}

fn lut_cell() -> &'static Mutex<LutLruInner> {
    static CELL: OnceLock<Mutex<LutLruInner>> = OnceLock::new();
    CELL.get_or_init(|| Mutex::new(LutLruInner::new()))
}

/// Look up `key` in the LUT cache. Returns a clone of the cached LUT on hit,
/// `None` on miss, and bumps the hit entry to most-recently-used. Mirrors
/// [`get`]; a 49³ LUT clone (~1.4 MB) is well below the per-tick render budget
/// the cache exists to protect.
pub fn get_lut(key: &CacheKey) -> Option<ColorLut> {
    let mut guard = lut_cell().lock().ok()?;
    let lut = guard.map.get(key).cloned()?;
    if let Some(pos) = guard.order.iter().position(|k| k == key) {
        let k = guard.order.remove(pos).unwrap();
        guard.order.push_back(k);
    }
    Some(lut)
}

/// Insert `lut` under `key` in the LUT cache. Evicts the oldest entry when at
/// [`CAPACITY`]; replaces in place + bumps to MRU when `key` already
/// present. Mirrors [`insert`].
pub fn insert_lut(key: CacheKey, lut: ColorLut) {
    let Ok(mut guard) = lut_cell().lock() else {
        return;
    };
    if guard.map.contains_key(&key) {
        guard.map.insert(key.clone(), lut);
        if let Some(pos) = guard.order.iter().position(|k| k == &key) {
            let k = guard.order.remove(pos).unwrap();
            guard.order.push_back(k);
        }
        return;
    }
    if guard.order.len() >= CAPACITY {
        if let Some(oldest) = guard.order.pop_front() {
            guard.map.remove(&oldest);
        }
    }
    guard.order.push_back(key.clone());
    guard.map.insert(key, lut);
}

/// Test-only: serialises every test that inserts into or asserts on the
/// process-wide singletons (the LRU-mechanics tests in `cache_tests.rs`,
/// and `auto_fit_tests`' cached-probe test) — an insert from a concurrent
/// test is an extra eviction the capacity assertions cannot tell from a
/// bug. Cargo runs tests in parallel by default.
#[cfg(test)]
pub(crate) fn test_lock() -> std::sync::MutexGuard<'static, ()> {
    static TEST_LOCK: Mutex<()> = Mutex::new(());
    TEST_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Test-only: clear the cache. Used by tests that need a known empty
/// state between cases — production code never needs this.
#[cfg(test)]
pub fn clear_for_test() {
    if let Ok(mut guard) = cell().lock() {
        guard.map.clear();
        guard.order.clear();
    }
}

/// Test-only mirror of [`clear_for_test`] for the parallel LUT cache.
#[cfg(test)]
pub fn clear_lut_for_test() {
    if let Ok(mut guard) = lut_cell().lock() {
        guard.map.clear();
        guard.order.clear();
    }
}

#[cfg(test)]
#[path = "cache_tests.rs"]
mod tests;
