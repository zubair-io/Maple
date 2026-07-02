//! Bounded LRU cache for decoded [`RawImage`]s (#949).
//!
//! On a cold image open the SAME RAW file is decoded twice — once by the
//! scene-linear render FFI (`maple_render_file_scene_linear_f32`, stage
//! `ffi_rawler_decode`) and once by the Auto-Profile fit FFI
//! (`maple_compute_auto_profile_lut`, stage `ffi_auto_lut_decode`). The two
//! calls are back-to-back on the same file, so the read + demosaic runs twice
//! (profiling showed `ffi_rawler_decode 1.88s` AND `ffi_auto_lut_decode 1.87s`
//! for one open). raw-core already caches the fitted Auto-Profile curve / LUT
//! (`view::auto_profile::cache`) but NOT the decoded `RawImage` — this module
//! closes that gap so the second decode of the same key is a hit (~0 ms).
//!
//! This is a deliberate parallel of [`crate::view::auto_profile::cache`]:
//! identical [`CacheKey`] shape, the same `Mutex` + `OnceLock` global, the same
//! bounded-LRU eviction. The two caches stay separate (different value types,
//! different capacities) rather than being generified — keeping the auto_profile
//! cache byte-for-byte intact while this one lands.
//!
//! Key shapes (see [`CacheKey`]):
//! - [`CacheKey::Path`] — `(canonical path, mtime)` for native callers. Mtime
//!   catches "the RAW was re-exported out from under us"; the path
//!   discriminates between files. Both cold-open decode sites have a real path,
//!   so both build [`CacheKey::Path`] and the second call hits.
//! - [`CacheKey::Bytes`] — discriminator over a 64-bit blake3 digest of the
//!   first 64 KB + last 64 KB + total length of the bytes (the WASM / in-memory
//!   path has no filesystem path). Full blake3 of a 50 MB RAW alone is ~50 ms
//!   (would defeat the cache); prefix+suffix+length is collision-free across
//!   distinct RAW files in practice and runs in microseconds. blake3 is already
//!   a workspace dependency.
//!
//! Value type: the cache stores `Arc<RawImage>` and hands out a CLONE of the
//! Arc on a hit. A 100 MP `RawImage` is ~200 MB, so the Arc keeps the hit O(1)
//! — no 200 MB copy. Because a hit returns the SAME `Arc` instance the original
//! decode produced, the bytes are trivially bit-identical to a fresh decode.
//!
//! Capacity is deliberately the minimum that fixes the bug ([`CAPACITY`] = 1):
//! render-then-fit touch ONE RAW back-to-back, so a single-entry cache already
//! makes the second decode a hit — which is the entire double-decode the ticket
//! targets. Each entry is ~200 MB for a 100 MP frame, and iOS is a target, so
//! holding only one keeps the resident footprint at one frame (raising it to 2
//! would double that for only the "re-open a just-closed image" case). A
//! distinct key evicts the previous entry.
//!
//! Staleness note: the key does NOT include any per-edit sidecar/adjustment
//! version — and it correctly should not. The decoded `RawImage` is a pure
//! function of the source bytes (sensor data + metadata); slider edits never
//! change it (they feed the develop/view stages downstream). So a hit is always
//! valid for the same `(path, mtime)` / bytes regardless of the XMP.

use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::SystemTime;

use crate::image::RawImage;
use crate::Result;

/// Cache capacity in entries. Each entry is one decoded `RawImage` (~200 MB for
/// a 100 MP frame), so this is the minimum that fixes the double-decode — see
/// the module doc for why 1 (not 2) is the deliberate choice.
const CAPACITY: usize = 1;

/// Bytes-hash discriminator window. Prefix + suffix bytes hashed; tunable.
/// Matches [`crate::view::auto_profile::cache`]'s window so the two caches agree
/// on what "the same in-memory RAW" means.
const HASH_WINDOW: usize = 64 * 1024;

/// Cache key shape — see module doc. Mirrors
/// [`crate::view::auto_profile::cache::CacheKey`].
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum CacheKey {
    Path { path: PathBuf, mtime: SystemTime },
    Bytes { hash: u64 },
}

impl CacheKey {
    /// Build a [`CacheKey::Path`] from a RAW file path. Returns `None` if the
    /// file is missing, can't be canonicalized, or `metadata` / `modified()`
    /// fail (file without an mtime, e.g. some virtual filesystems). Callers
    /// fall back to an uncached decode on `None`.
    ///
    /// Canonicalization resolves symlinks and `..` segments so two callers
    /// referring to the same file through different paths share a cache entry.
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
    /// truncation of blake3 over (prefix, suffix, length) — see module doc for
    /// the cost rationale. Identical to the auto_profile cache's hashing so the
    /// two caches discriminate inputs the same way.
    pub fn from_bytes(bytes: &[u8]) -> Self {
        let mut hasher = blake3::Hasher::new();
        let head_end = bytes.len().min(HASH_WINDOW);
        hasher.update(&bytes[..head_end]);
        // Hash the tail HASH_WINDOW bytes whenever the input is longer than the
        // prefix window — even when overlapping (HASH_WINDOW < len <=
        // 2*HASH_WINDOW). Without this, two slices with matching prefix + length
        // but differing tails would collide to the same key.
        if bytes.len() > HASH_WINDOW {
            let tail_start = bytes.len() - HASH_WINDOW;
            hasher.update(&bytes[tail_start..]);
        }
        hasher.update(&(bytes.len() as u64).to_le_bytes());
        let digest = hasher.finalize();
        let b = digest.as_bytes();
        let hash = u64::from_le_bytes([b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7]]);
        CacheKey::Bytes { hash }
    }
}

struct LruInner {
    map: HashMap<CacheKey, Arc<RawImage>>,
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

/// Look up `key`. Returns a clone of the cached `Arc<RawImage>` on hit (O(1) —
/// no pixel copy), `None` on miss, and bumps the hit entry to most-recently
/// used. The lock is held only for the lookup, never across a decode.
pub fn get(key: &CacheKey) -> Option<Arc<RawImage>> {
    let mut guard = cell().lock().ok()?;
    let img = guard.map.get(key).cloned()?;
    if let Some(pos) = guard.order.iter().position(|k| k == key) {
        let k = guard.order.remove(pos).unwrap();
        guard.order.push_back(k);
    }
    Some(img)
}

/// Insert `img` under `key`. Evicts the oldest entry when at [`CAPACITY`]. If
/// `key` is already present, replaces the value in place and bumps it to MRU.
/// The lock is held only for the insert.
pub fn insert(key: CacheKey, img: Arc<RawImage>) {
    let Ok(mut guard) = cell().lock() else { return };
    if guard.map.contains_key(&key) {
        guard.map.insert(key.clone(), img);
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
    guard.map.insert(key, img);
}

/// Decode `bytes` (extension hint `ext`) through the LRU keyed on `key`.
///
/// On a hit this returns the cached `Arc<RawImage>` WITHOUT touching the
/// decoder — that is the ~0 ms path the cache exists for. On a miss it decodes
/// via [`crate::decode::decode_bytes`] **without holding the lock** (a 1.8 s
/// decode under the mutex would serialize every decode), wraps the result in an
/// `Arc`, inserts it, and returns the same `Arc`.
///
/// The returned image is bit-identical to a fresh `decode_bytes` call: on a
/// miss it IS a fresh decode; on a hit it is the very `Arc` instance an earlier
/// fresh decode produced.
///
/// A rare double-decode race (two callers miss the same cold key
/// simultaneously) is harmless — both produce a valid `RawImage`, last insert
/// wins, both callers get a valid `Arc`. This matches the auto_profile cache's
/// accepted behaviour.
pub fn decode_bytes_cached(key: &CacheKey, bytes: &[u8], ext: &str) -> Result<Arc<RawImage>> {
    if let Some(hit) = get(key) {
        return Ok(hit);
    }
    let img = Arc::new(crate::decode::decode_bytes(bytes, ext)?);
    insert(key.clone(), Arc::clone(&img));
    Ok(img)
}

/// Test-only: clear the cache so tests start from a known empty state.
/// Production code never needs this.
#[cfg(test)]
pub fn clear_for_test() {
    if let Ok(mut guard) = cell().lock() {
        guard.map.clear();
        guard.order.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Cache tests share the singleton. Cargo runs them in parallel by default;
    /// serialize via a test-local mutex so a `clear_for_test` + assertions are
    /// not interleaved with another test's inserts. Mirrors the auto_profile
    /// cache test harness.
    static TEST_LOCK: Mutex<()> = Mutex::new(());

    /// Build a tiny, distinct `Arc<RawImage>` tagged by `white_level` so cached
    /// entries are tellable apart by value. The fields are arbitrary — these
    /// tests exercise the cache container, not the decoder.
    fn dummy_image(tag: u32) -> Arc<RawImage> {
        Arc::new(RawImage {
            width: 1,
            height: 1,
            cfa: crate::image::CfaPattern::Rggb,
            black_level: [0; 4],
            white_level: tag,
            raw_data: vec![0u16],
            as_shot_neutral: [1.0, 1.0, 1.0],
            as_shot_cct: None,
            camera_make: String::new(),
            camera_model: String::new(),
            unique_camera_model: None,
            color_matrices: std::collections::HashMap::new(),
            forward_matrices: std::collections::HashMap::new(),
            orientation: crate::image::ExifOrientation::Normal,
            baseline_exposure: 0.0,
            hsm_data: std::collections::HashMap::new(),
            plt: None,
            profile_tone_curve: None,
            profile_gain_table_map: None,
            crop_rect: None,
            iso: 100,
            noise_profile: None,
        })
    }

    #[test]
    fn insert_then_get_returns_same_arc() {
        let _g = TEST_LOCK.lock().unwrap();
        clear_for_test();
        let key = CacheKey::Bytes { hash: 0xdead_beef };
        let img = dummy_image(123);
        insert(key.clone(), Arc::clone(&img));
        let got = get(&key).expect("should hit");
        // Same instance, not just an equal value.
        assert!(Arc::ptr_eq(&got, &img));
    }

    #[test]
    fn miss_returns_none() {
        let _g = TEST_LOCK.lock().unwrap();
        clear_for_test();
        let key = CacheKey::Bytes { hash: 0x1234_5678 };
        assert!(get(&key).is_none());
    }

    #[test]
    fn lru_evicts_oldest_at_capacity() {
        let _g = TEST_LOCK.lock().unwrap();
        clear_for_test();
        // Fill to capacity + 1 with distinct keys; key 0 should be evicted.
        for i in 0..(CAPACITY as u64 + 1) {
            insert(CacheKey::Bytes { hash: i }, dummy_image(i as u32));
        }
        assert!(
            get(&CacheKey::Bytes { hash: 0 }).is_none(),
            "oldest evicted"
        );
        for i in 1..=(CAPACITY as u64) {
            assert!(
                get(&CacheKey::Bytes { hash: i }).is_some(),
                "hash={i} present"
            );
        }
    }

    #[test]
    fn get_promotes_to_mru() {
        // MRU promotion is only observable with >= 2 slots: with CAPACITY = 1
        // any second insert evicts the first regardless of access order, so
        // there's nothing to promote. Keep the test capacity-agnostic so it
        // stays correct if CAPACITY is later bumped.
        if CAPACITY < 2 {
            return;
        }
        let _g = TEST_LOCK.lock().unwrap();
        clear_for_test();
        // Fill to capacity: keys 0..CAPACITY.
        for i in 0..(CAPACITY as u64) {
            insert(CacheKey::Bytes { hash: i }, dummy_image(i as u32));
        }
        // Touch the oldest (hash=0) — it becomes MRU, so hash=1 is now the LRU.
        let _ = get(&CacheKey::Bytes { hash: 0 });
        // Insert one more — the evicted entry is hash=1 (LRU), not hash=0.
        insert(CacheKey::Bytes { hash: 999 }, dummy_image(999));
        assert!(
            get(&CacheKey::Bytes { hash: 0 }).is_some(),
            "hash=0 promoted, survives"
        );
        assert!(
            get(&CacheKey::Bytes { hash: 1 }).is_none(),
            "hash=1 was LRU, evicted"
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

        // Touch to a later mtime. HFS+ has 1 s mtime resolution, so a plain
        // rewrite can land in the same second; sleep first (no new dep).
        std::thread::sleep(Duration::from_millis(1100));
        OpenOptions::new()
            .write(true)
            .truncate(true)
            .open(&path)
            .expect("open")
            .write_all(b"world!")
            .expect("write");
        let k2 = CacheKey::from_path(&path).expect("key 2");
        assert_ne!(k1, k2, "mtime change → different key");
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
        assert_eq!(
            ka,
            CacheKey::from_bytes(&a),
            "identical bytes → identical key"
        );
        assert_ne!(ka, kb, "different prefix → different key");
        assert_ne!(ka, kc, "different length → different key");
    }

    #[test]
    fn path_and_bytes_variants_never_collide() {
        let path_key = CacheKey::Path {
            path: PathBuf::from("/x"),
            mtime: SystemTime::UNIX_EPOCH,
        };
        let bytes_key = CacheKey::Bytes { hash: 0 };
        assert_ne!(path_key, bytes_key);
    }

    /// End-to-end proof of the ticket's core claim: a SECOND decode of the same
    /// `(path, mtime)` is a cache hit that returns the SAME `Arc` (no
    /// re-decode), and a DIFFERENT path (distinct bytes/mtime) misses and
    /// decodes fresh. Uses the synthetic-DNG generator so it runs without RAW
    /// fixtures on the machine.
    #[test]
    fn second_decode_same_path_is_hit_different_path_misses() {
        use crate::test_support::synth_dng::SyntheticGreyDng;

        let _g = TEST_LOCK.lock().unwrap();
        clear_for_test();

        let dir = tempfile::tempdir().expect("tempdir");

        // File A.
        let bytes_a = SyntheticGreyDng::default().write_to_bytes();
        let path_a = dir.path().join("a.dng");
        std::fs::write(&path_a, &bytes_a).expect("write a");
        let key_a = CacheKey::from_path(&path_a).expect("key a");

        // First decode of A — a miss, decodes for real.
        let first = decode_bytes_cached(&key_a, &bytes_a, "dng").expect("decode a #1");
        // Second decode of A — a HIT, same Arc instance (no re-decode).
        let second = decode_bytes_cached(&key_a, &bytes_a, "dng").expect("decode a #2");
        assert!(
            Arc::ptr_eq(&first, &second),
            "second decode of same (path,mtime) must hit the cache (same Arc)"
        );

        // File B — a DIFFERENT path with different bytes. Must MISS and decode a
        // distinct image (not A's Arc).
        let bytes_b = SyntheticGreyDng::default()
            .with_hasselblad_dcp()
            .write_to_bytes();
        let path_b = dir.path().join("b.dng");
        std::fs::write(&path_b, &bytes_b).expect("write b");
        let key_b = CacheKey::from_path(&path_b).expect("key b");
        assert_ne!(key_a, key_b, "distinct files → distinct keys");

        let other = decode_bytes_cached(&key_b, &bytes_b, "dng").expect("decode b");
        assert!(
            !Arc::ptr_eq(&first, &other),
            "different path must miss and decode a fresh image"
        );
    }

    /// A changed mtime for the SAME path is a miss (the file was re-exported out
    /// from under us). Pairs with [`path_key_includes_mtime`] but drives it
    /// through the full `decode_bytes_cached` path to prove the cache, not just
    /// the key, distinguishes the two.
    #[test]
    fn changed_mtime_same_path_misses() {
        use crate::test_support::synth_dng::SyntheticGreyDng;
        use std::time::Duration;

        let _g = TEST_LOCK.lock().unwrap();
        clear_for_test();

        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("c.dng");

        let bytes1 = SyntheticGreyDng::default().write_to_bytes();
        std::fs::write(&path, &bytes1).expect("write 1");
        let key1 = CacheKey::from_path(&path).expect("key 1");
        let first = decode_bytes_cached(&key1, &bytes1, "dng").expect("decode 1");

        // Rewrite the SAME path with new content at a later mtime.
        std::thread::sleep(Duration::from_millis(1100));
        let bytes2 = SyntheticGreyDng::default()
            .with_hasselblad_dcp()
            .write_to_bytes();
        std::fs::write(&path, &bytes2).expect("write 2");
        let key2 = CacheKey::from_path(&path).expect("key 2");
        assert_ne!(key1, key2, "mtime bump → different key");

        let second = decode_bytes_cached(&key2, &bytes2, "dng").expect("decode 2");
        assert!(
            !Arc::ptr_eq(&first, &second),
            "changed mtime must miss and decode fresh"
        );
    }
}
