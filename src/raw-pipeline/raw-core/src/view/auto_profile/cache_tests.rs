//! Unit tests for the auto-profile LRU caches — split out of `cache.rs`
//! (file-size budget) when the `FitOrigin` discriminator joined the key
//! (#3233 / #3235).

use super::*;
use crate::view::auto_profile::curve::{ChannelCurve, IDENTITY_MATRIX};

/// Bytes-variant key at a fixed quality — the tests below that exercise
/// LRU mechanics (not quality discrimination) key on the hash alone.
fn bkey(hash: u64) -> CacheKey {
    CacheKey::Bytes {
        hash,
        quality: RenderQuality::Full,
        origin: FitOrigin::Standalone,
        fit_model_version: AUTO_FIT_MODEL_VERSION,
    }
}

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
    let _g = test_lock();
    clear_for_test();
    let key = bkey(0xdead_beef);
    let curve = dummy_curve(1.234);
    insert(key.clone(), curve.clone());
    let got = get(&key).expect("should hit");
    assert_eq!(got, curve);
}

#[test]
fn miss_returns_none() {
    let _g = test_lock();
    clear_for_test();
    let key = bkey(0x1234);
    assert!(get(&key).is_none());
}

#[test]
fn insert_lut_then_get_lut_returns_same_lut() {
    let _g = test_lock();
    clear_lut_for_test();
    // Build a small NON-identity LUT (tweak one node) so a hit proves we got
    // OUR stored grid back, not a freshly minted identity.
    let mut lut = ColorLut::identity(5);
    lut.data[0] = 0.123;
    // `from_bytes` needs no filesystem — keeps the round-trip pure in-memory.
    let key = CacheKey::from_bytes(b"lut-round-trip-fixture", RenderQuality::Full);
    insert_lut(key.clone(), lut.clone());
    let got = get_lut(&key).expect("should hit");
    assert_eq!(got, lut);
    // The tweaked node specifically survived the round trip.
    assert_eq!(got.data[0], 0.123);
}

#[test]
fn lut_cache_miss_returns_none() {
    let _g = test_lock();
    clear_lut_for_test();
    let key = CacheKey::from_bytes(b"absent-lut-key", RenderQuality::Full);
    assert!(get_lut(&key).is_none());
}

#[test]
fn lru_evicts_oldest_at_capacity() {
    let _g = test_lock();
    clear_for_test();
    // Fill cache to capacity + 1, with distinct keys.
    for i in 0..(CAPACITY as u64 + 1) {
        insert(bkey(i), dummy_curve(i as f32));
    }
    // Key 0 should have been evicted; keys 1..=CAPACITY should be present.
    assert!(get(&bkey(0)).is_none());
    for i in 1..=(CAPACITY as u64) {
        assert!(get(&bkey(i)).is_some(), "expected hit for hash={i}");
    }
}

#[test]
fn get_promotes_to_mru() {
    let _g = test_lock();
    clear_for_test();
    // Fill to capacity.
    for i in 0..(CAPACITY as u64) {
        insert(bkey(i), dummy_curve(i as f32));
    }
    // Touch the oldest (hash=0) — it should now be MRU.
    let _ = get(&bkey(0));
    // Insert one more — the new LRU should be hash=1, not hash=0.
    insert(bkey(999), dummy_curve(999.0));
    assert!(
        get(&bkey(0)).is_some(),
        "hash=0 was promoted, should survive"
    );
    assert!(get(&bkey(1)).is_none(), "hash=1 was LRU, should be evicted");
}

#[test]
fn path_key_includes_mtime() {
    use std::fs::OpenOptions;
    use std::io::Write;
    use std::time::Duration;

    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("test.bin");
    std::fs::write(&path, b"hello").expect("write");
    let k1 = CacheKey::from_path(&path, RenderQuality::Full).expect("key 1");

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
    let k2 = CacheKey::from_path(&path, RenderQuality::Full).expect("key 2");
    assert_ne!(k1, k2, "mtime change should produce a different key");
}

#[test]
fn bytes_key_discriminates() {
    let a = vec![0u8; 1024];
    let mut b = vec![0u8; 1024];
    b[0] = 1;
    let c = vec![0u8; 2048];
    let ka = CacheKey::from_bytes(&a, RenderQuality::Full);
    let kb = CacheKey::from_bytes(&b, RenderQuality::Full);
    let kc = CacheKey::from_bytes(&c, RenderQuality::Full);
    // Identical bytes → identical keys.
    let ka2 = CacheKey::from_bytes(&a, RenderQuality::Full);
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
    assert_ne!(
        CacheKey::from_bytes(&a, RenderQuality::Full),
        CacheKey::from_bytes(&b, RenderQuality::Full)
    );
}

#[test]
fn bytes_key_path_and_bytes_variants_never_collide() {
    let path_key = CacheKey::Path {
        path: PathBuf::from("/x"),
        mtime: SystemTime::UNIX_EPOCH,
        quality: RenderQuality::Full,
        origin: FitOrigin::Standalone,
        fit_model_version: AUTO_FIT_MODEL_VERSION,
    };
    let bytes_key = bkey(0);
    assert_ne!(path_key, bytes_key);
}

/// #2035: the develop quality is part of the key — same source, different
/// quality → different key, for BOTH variants.
#[test]
fn quality_discriminates_keys() {
    let bytes = b"quality-key-fixture";
    assert_ne!(
        CacheKey::from_bytes(bytes, RenderQuality::Preview),
        CacheKey::from_bytes(bytes, RenderQuality::Full),
    );

    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("q.bin");
    std::fs::write(&path, b"hello").expect("write");
    assert_ne!(
        CacheKey::from_path(&path, RenderQuality::Preview).expect("key"),
        CacheKey::from_path(&path, RenderQuality::Full).expect("key"),
    );
}

/// #2035 cross-quality poisoning regression: artifacts inserted under a
/// Full-quality key must MISS when looked up at Preview (and vice versa)
/// — before quality joined the key, whichever path fit first silently
/// served the other quality's artifacts.
#[test]
fn cross_quality_lookup_misses() {
    let _g = test_lock();
    clear_for_test();
    clear_lut_for_test();
    let bytes = b"cross-quality-miss-fixture";
    let full_key = CacheKey::from_bytes(bytes, RenderQuality::Full);
    let preview_key = CacheKey::from_bytes(bytes, RenderQuality::Preview);

    insert(full_key.clone(), dummy_curve(4.2));
    insert_lut(full_key.clone(), ColorLut::identity(5));

    assert!(
        get(&preview_key).is_none(),
        "a Full-fit curve must not serve a Preview lookup"
    );
    assert!(
        get_lut(&preview_key).is_none(),
        "a Full-fit LUT must not serve a Preview lookup"
    );
    // Sanity: the matching quality still hits.
    assert!(get(&full_key).is_some());
    assert!(get_lut(&full_key).is_some());
}

/// #3233 / #3235: the fit origin is part of the key — the standalone
/// proxy fit, a render-path fit at each long-edge cap, and the curve-only
/// fit never serve each other, for BOTH variants.
#[test]
fn origin_discriminates_keys() {
    let bytes = b"origin-key-fixture";
    let standalone = CacheKey::from_bytes(bytes, RenderQuality::Full);
    assert_eq!(standalone.origin(), FitOrigin::Standalone);
    let native = standalone.clone().with_origin(FitOrigin::Render(None));
    let sized = standalone.clone().with_origin(FitOrigin::Render(Some(768)));
    let other_size = standalone.clone().with_origin(FitOrigin::Render(Some(512)));
    let curve_only = standalone.clone().with_origin(FitOrigin::CurveOnly);
    let keys = [&standalone, &native, &sized, &other_size, &curve_only];
    for (i, a) in keys.iter().enumerate() {
        for (j, b) in keys.iter().enumerate() {
            assert_eq!(i == j, a == b, "{a:?} vs {b:?}");
        }
    }
    // Re-keying keeps the raw identity + quality: back to Standalone is the
    // original key again.
    assert_eq!(sized.with_origin(FitOrigin::Standalone), standalone);

    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("o.bin");
    std::fs::write(&path, b"hello").expect("write");
    let p_standalone = CacheKey::from_path(&path, RenderQuality::Full).expect("key");
    let p_sized = p_standalone
        .clone()
        .with_origin(FitOrigin::Render(Some(768)));
    assert_ne!(p_standalone, p_sized);
    assert_eq!(p_sized.with_origin(FitOrigin::Standalone), p_standalone);
}

/// An artifact inserted under one origin must MISS a lookup under another
/// — the curve-only fit's identity-free curve can no longer be handed to
/// the pair readers, and a 768 px render's pair cannot serve a native one.
#[test]
fn cross_origin_lookup_misses() {
    let _g = test_lock();
    clear_for_test();
    clear_lut_for_test();
    let bytes = b"cross-origin-miss-fixture";
    let standalone = CacheKey::from_bytes(bytes, RenderQuality::Full);
    let sized = standalone.clone().with_origin(FitOrigin::Render(Some(768)));
    let curve_only = standalone.clone().with_origin(FitOrigin::CurveOnly);

    insert(curve_only.clone(), dummy_curve(8.12));
    insert(sized.clone(), dummy_curve(7.68));
    insert_lut(sized.clone(), ColorLut::identity(5));

    assert!(get(&standalone).is_none(), "standalone must miss both");
    assert!(get_lut(&standalone).is_none());
    assert_eq!(get(&curve_only).map(|c| c.chroma_boost), Some(8.12));
    assert_eq!(get(&sized).map(|c| c.chroma_boost), Some(7.68));
    assert!(get_lut(&curve_only).is_none(), "curve-only never has a LUT");
}

/// Curve and residual must come from the same fitting-model version,
/// including after a caller changes the origin of a path or bytes key.
#[test]
fn fit_model_version_invalidates_both_artifact_caches() {
    let _g = test_lock();
    clear_for_test();
    clear_lut_for_test();
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("model-version.bin");
    std::fs::write(&path, b"fit-model-version").expect("write");
    let keys = [
        CacheKey::from_path(&path, RenderQuality::Full).expect("path key"),
        CacheKey::from_bytes(b"fit-model-version", RenderQuality::Full),
    ];
    for current in keys {
        let mut older = current.clone();
        let (CacheKey::Path {
            fit_model_version, ..
        }
        | CacheKey::Bytes {
            fit_model_version, ..
        }) = &mut older;
        assert_eq!(*fit_model_version, AUTO_FIT_MODEL_VERSION);
        *fit_model_version -= 1;
        let current = current.with_origin(FitOrigin::Render(Some(768)));
        let older = older.with_origin(FitOrigin::Render(Some(768)));
        insert(older.clone(), dummy_curve(4.2));
        insert_lut(older.clone(), ColorLut::identity(5));
        assert!(get(&current).is_none(), "old fit curve must miss");
        assert!(get_lut(&current).is_none(), "old residual LUT must miss");
        assert!(get(&older).is_some());
        assert!(get_lut(&older).is_some());
    }
}
