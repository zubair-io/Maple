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
//! - [`CacheKey::Path`] — `(canonical path, mtime)` for native callers.
//!   Mtime catches "user re-edited and re-exported the RAW out from under
//!   us"; the path discriminates between fixtures.
//! - [`CacheKey::Bytes`] — discriminator over a 64-bit blake3 digest of
//!   the first 64 KB + last 64 KB + total length of the bytes. Full
//!   blake3 of a 50 MB RAW alone is ~50 ms (would defeat the cache);
//!   prefix+suffix+length is collision-free across distinct RAW files in
//!   practice and runs in microseconds. blake3 is already a workspace
//!   dependency.
//!
//! Keying invariant (#1085): the fit is PINNED to the default adjustment
//! model — every fit entry develops `AdjustmentModel::default()` with only
//! `auto_exposure: Off` pinned and the caller's `profile` carried (see
//! `pipeline::render::auto_fit::fit_develop_model`), never the caller's live
//! edit model. The fitted curve/LUT are therefore a pure function of the RAW
//! (at a given develop quality/size), so a RAW-identity key needs no
//! adjustment digest or generation counter: slider ticks cannot change what
//! a fit would produce, and a warm entry is always exactly what a cold fit
//! would re-compute. (Develop quality/size are NOT in the key — pre-existing,
//! documented contract: the fit quality "MUST match the host's render".)

use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::SystemTime;

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

/// Cache key shape — see module doc.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum CacheKey {
    Path { path: PathBuf, mtime: SystemTime },
    Bytes { hash: u64 },
}

impl CacheKey {
    /// Build a [`CacheKey::Path`] from a RAW file path. Returns `None`
    /// if the file is missing, can't be canonicalized, or `metadata` /
    /// `modified()` fail (file without an mtime, e.g. some virtual
    /// filesystems).
    ///
    /// Canonicalization resolves symlinks and `..` segments so two callers
    /// referring to the same file through different paths share a cache
    /// entry — matches the module doc's "canonical path" claim.
    pub fn from_path(path: &Path) -> Option<Self> {
        let canonical = std::fs::canonicalize(path).ok()?;
        let meta = std::fs::metadata(&canonical).ok()?;
        let mtime = meta.modified().ok()?;
        Some(CacheKey::Path {
            path: canonical,
            mtime,
        })
    }

    /// Build a [`CacheKey::Bytes`] from in-memory RAW bytes. Uses a 64-bit
    /// truncation of blake3 over (prefix, suffix, length) — see module
    /// doc for the cost rationale.
    pub fn from_bytes(bytes: &[u8]) -> Self {
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
        CacheKey::Bytes { hash }
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
mod tests {
    use super::*;
    use crate::view::auto_profile::curve::{ChannelCurve, IDENTITY_MATRIX};
    use std::sync::Mutex;

    /// Cache tests share global state (the singleton). Cargo runs them in
    /// parallel by default; serialize via a test-local mutex so the
    /// clear_for_test + assertions are not interleaved with another test's
    /// inserts.
    static TEST_LOCK: Mutex<()> = Mutex::new(());

    fn dummy_curve(tag: f32) -> ProfileCurve {
        // Build a curve with a recognisable tag in chroma_boost so we can
        // tell cached entries apart by value.
        ProfileCurve {
            r: ChannelCurve::identity(),
            g: ChannelCurve::identity(),
            b: ChannelCurve::identity(),
            matrix: IDENTITY_MATRIX,
            chroma_boost: tag,
            chroma_offset: [0.0, 0.0],
            lightness_offset: 0.0,
            lightness_band_offsets: [0.0; 5],
            ab_band_offsets: [[0.0; 2]; 5],
        }
    }

    #[test]
    fn insert_then_get_returns_same_curve() {
        let _g = TEST_LOCK.lock().unwrap();
        clear_for_test();
        let key = CacheKey::Bytes { hash: 0xdead_beef };
        let curve = dummy_curve(1.234);
        insert(key.clone(), curve.clone());
        let got = get(&key).expect("should hit");
        assert_eq!(got, curve);
    }

    #[test]
    fn miss_returns_none() {
        let _g = TEST_LOCK.lock().unwrap();
        clear_for_test();
        let key = CacheKey::Bytes { hash: 0x1234 };
        assert!(get(&key).is_none());
    }

    #[test]
    fn insert_lut_then_get_lut_returns_same_lut() {
        let _g = TEST_LOCK.lock().unwrap();
        clear_lut_for_test();
        // Build a small NON-identity LUT (tweak one node) so a hit proves we got
        // OUR stored grid back, not a freshly minted identity.
        let mut lut = ColorLut::identity(5);
        lut.data[0] = 0.123;
        // `from_bytes` needs no filesystem — keeps the round-trip pure in-memory.
        let key = CacheKey::from_bytes(b"lut-round-trip-fixture");
        insert_lut(key.clone(), lut.clone());
        let got = get_lut(&key).expect("should hit");
        assert_eq!(got, lut);
        // The tweaked node specifically survived the round trip.
        assert_eq!(got.data[0], 0.123);
    }

    #[test]
    fn lut_cache_miss_returns_none() {
        let _g = TEST_LOCK.lock().unwrap();
        clear_lut_for_test();
        let key = CacheKey::from_bytes(b"absent-lut-key");
        assert!(get_lut(&key).is_none());
    }

    #[test]
    fn lru_evicts_oldest_at_capacity() {
        let _g = TEST_LOCK.lock().unwrap();
        clear_for_test();
        // Fill cache to capacity + 1, with distinct keys.
        for i in 0..(CAPACITY as u64 + 1) {
            insert(CacheKey::Bytes { hash: i }, dummy_curve(i as f32));
        }
        // Key 0 should have been evicted; keys 1..=CAPACITY should be present.
        assert!(get(&CacheKey::Bytes { hash: 0 }).is_none());
        for i in 1..=(CAPACITY as u64) {
            assert!(
                get(&CacheKey::Bytes { hash: i }).is_some(),
                "expected hit for hash={i}"
            );
        }
    }

    #[test]
    fn get_promotes_to_mru() {
        let _g = TEST_LOCK.lock().unwrap();
        clear_for_test();
        // Fill to capacity.
        for i in 0..(CAPACITY as u64) {
            insert(CacheKey::Bytes { hash: i }, dummy_curve(i as f32));
        }
        // Touch the oldest (hash=0) — it should now be MRU.
        let _ = get(&CacheKey::Bytes { hash: 0 });
        // Insert one more — the new LRU should be hash=1, not hash=0.
        insert(CacheKey::Bytes { hash: 999 }, dummy_curve(999.0));
        assert!(
            get(&CacheKey::Bytes { hash: 0 }).is_some(),
            "hash=0 was promoted, should survive"
        );
        assert!(
            get(&CacheKey::Bytes { hash: 1 }).is_none(),
            "hash=1 was LRU, should be evicted"
        );
    }

    #[test]
    fn path_key_includes_mtime() {
        use std::fs::OpenOptions;
        use std::io::Write;
        use std::time::Duration;

        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("test.bin");
        std::fs::write(&path, b"hello").expect("write");
        let k1 = CacheKey::from_path(&path).expect("key 1");

        // Touch the file to a different mtime. On filesystems with low
        // mtime resolution (HFS+ = 1 s), a plain rewrite can land in the
        // same second; explicitly set a later mtime via `filetime`-style
        // shim using set_file_times is more reliable but adds a dep. We
        // sleep then rewrite — slower but works without new deps.
        std::thread::sleep(Duration::from_millis(1100));
        OpenOptions::new()
            .write(true)
            .truncate(true)
            .open(&path)
            .expect("open")
            .write_all(b"world!")
            .expect("write");
        let k2 = CacheKey::from_path(&path).expect("key 2");
        assert_ne!(k1, k2, "mtime change should produce a different key");
    }

    #[test]
    fn bytes_key_discriminates() {
        let a = vec![0u8; 1024];
        let mut b = vec![0u8; 1024];
        b[0] = 1;
        let c = vec![0u8; 2048];
        let ka = CacheKey::from_bytes(&a);
        let kb = CacheKey::from_bytes(&b);
        let kc = CacheKey::from_bytes(&c);
        // Identical bytes → identical keys.
        let ka2 = CacheKey::from_bytes(&a);
        assert_eq!(ka, ka2);
        // Different prefix → different key.
        assert_ne!(ka, kb);
        // Different length → different key.
        assert_ne!(ka, kc);
    }

    /// Regression for the pre-fix `> HASH_WINDOW * 2` collision range:
    /// two slices identical in the first HASH_WINDOW bytes and identical
    /// in length but differing in the tail used to collide. After the fix
    /// the tail is hashed whenever `len > HASH_WINDOW`.
    #[test]
    fn bytes_key_includes_tail_for_medium_length_inputs() {
        let len = HASH_WINDOW + HASH_WINDOW / 2; // 96 KB — in the broken range.
        let mut a = vec![0u8; len];
        let mut b = vec![0u8; len];
        // Differ only in the very last byte. Prefix + length identical.
        a[len - 1] = 1;
        b[len - 1] = 2;
        assert_ne!(CacheKey::from_bytes(&a), CacheKey::from_bytes(&b));
    }

    #[test]
    fn bytes_key_path_and_bytes_variants_never_collide() {
        let path_key = CacheKey::Path {
            path: PathBuf::from("/x"),
            mtime: SystemTime::UNIX_EPOCH,
        };
        let bytes_key = CacheKey::Bytes { hash: 0 };
        assert_ne!(path_key, bytes_key);
    }
}
