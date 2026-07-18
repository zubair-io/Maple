//! `maple_compute_auto_profile_lut` cache-path gate (#2035).
//!
//! The fusion entry (fit + bake) must serve a fully-cached
//! `(path, mtime, quality)` fit WITHOUT reading or decoding the RAW, and the
//! quality discriminant in the key must keep Preview- and Full-fit artifacts
//! from serving each other. Proven structurally with an UNDECODABLE temp file:
//! the read+decode path can only fail on it (rc=7), so an rc=0 with the
//! expected bytes is possible only via the cache. No fixture needed.

use super::*;
use raw_core::view::auto_profile::bake_auto_profile_lut;
use raw_core::view::auto_profile::curve::ProfileCurve;
use raw_core::view::auto_profile::lut::ColorLut;

/// A small non-identity residual (identity grid warped by a mild per-node
/// gamma) so the baked cube carries a real, recognisable shift.
fn non_identity_residual(size: usize) -> ColorLut {
    let mut lut = ColorLut::identity(size);
    for v in lut.data.iter_mut() {
        *v = v.clamp(0.0, 1.0).powf(0.92);
    }
    lut
}

/// #2035: cache hit bakes straight from the LRUs (no file read / decode);
/// a different quality misses and falls through to the real decode.
#[test]
fn cached_fit_bakes_without_file_read_and_respects_quality() {
    use raw_core::pipeline::RenderQuality;
    use raw_core::view::auto_profile::cache as auto_cache;

    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("bogus_cube_2035.dng");
    std::fs::write(&path, b"garbage bytes that cannot decode as a raw").expect("write");
    let cpath = std::ffi::CString::new(path.to_str().unwrap()).unwrap();

    // Pre-insert BOTH artifacts under the file's Full-quality key.
    let cached_curve = ProfileCurve::identity();
    let cached_residual = non_identity_residual(5);
    let key = auto_cache::CacheKey::from_path(&path, RenderQuality::Full)
        .expect("temp file is stattable");
    auto_cache::insert(key.clone(), cached_curve.clone());
    auto_cache::insert_lut(key, cached_residual.clone());

    // Full quality (quality_preview = 0) → cache HIT → rc 0 and the cube is
    // the bake of exactly the cached pair — impossible via the decode path,
    // which can only fail (rc=7) on the garbage file.
    let n = 9u32;
    let mut out = vec![0f32; 9 * 9 * 9 * 3];
    let rc = unsafe {
        maple_compute_auto_profile_lut(
            cpath.as_ptr(),
            std::ptr::null(), // no sidecar → default model → Profile::Auto
            0,
            n,
            out.as_mut_ptr(),
        )
    };
    assert_eq!(
        rc, 0,
        "a fully-cached fit must bake without touching the (undecodable) file"
    );
    let expected = bake_auto_profile_lut(&cached_curve, &cached_residual, 9);
    assert_eq!(
        out, expected,
        "the baked cube must compose exactly the cached artifacts"
    );

    // Preview quality → DIFFERENT key (the #2035 discriminant) → miss → the
    // real read+decode runs and fails on the garbage bytes. Pre-#2035 this
    // would have silently baked the Full-fit artifacts for a Preview caller.
    let rc = unsafe {
        maple_compute_auto_profile_lut(cpath.as_ptr(), std::ptr::null(), 1, n, out.as_mut_ptr())
    };
    assert_eq!(
        rc, 7,
        "a Preview-quality call must MISS the Full-keyed cache and hit the real \
         decode (which fails on the garbage file) — not be served cross-quality \
         artifacts"
    );

    // Non-Auto sidecar → the early profile guard returns rc 1 (no tail)
    // WITHOUT touching the file at all — same structural proof: the garbage
    // RAW can only produce rc 7 if the read+decode path ran (Copilot review
    // on #2053; the fit's own top guard would return the identical rc 1).
    let xmp_path = dir.path().join("neutral.xmp");
    std::fs::write(
        &xmp_path,
        r#"<?xml version="1.0"?>
        <x:xmpmeta xmlns:x="adobe:ns:meta/">
          <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
            <rdf:Description xmlns:papp="http://ns.justmaple.app/1.0/"
              papp:Profile="Neutral"/>
          </rdf:RDF>
        </x:xmpmeta>"#,
    )
    .expect("write xmp");
    let cxmp = std::ffi::CString::new(xmp_path.to_str().unwrap()).unwrap();
    let rc = unsafe {
        maple_compute_auto_profile_lut(cpath.as_ptr(), cxmp.as_ptr(), 0, n, out.as_mut_ptr())
    };
    assert_eq!(
        rc, 1,
        "a non-Auto model must exit with rc 1 (no tail) before any file I/O — \
         reaching the decode would produce rc 7 on the garbage file"
    );
}
