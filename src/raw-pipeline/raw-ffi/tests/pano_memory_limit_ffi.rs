//! The Apple memory limit through the C ABI (P1 of the panorama memory
//! review): a preview or stitch the memory model puts over the caller's
//! `memory_limit_bytes` is refused with −12 before any frame is developed,
//! and 0 leaves it unlimited.

#![cfg(all(feature = "pano", target_os = "macos"))]

use std::ffi::{CStr, CString};
use std::path::{Path, PathBuf};

use raw_core::test_support::synth_dng::SyntheticGreyDng;
use raw_ffi::{
    maple_last_error, maple_pano_preview_constrained, maple_pano_stitch_constrained,
    MaplePanoEdges, MaplePanoFeatureEngine, MaplePanoLocalAlign, MaplePanoRetention,
    MaplePanoStrategy,
};

fn frames(dir: &Path) -> Vec<CString> {
    (0..2)
        .map(|i| {
            let path: PathBuf = dir.join(format!("f{i}.dng"));
            SyntheticGreyDng::default()
                .write_to(&path)
                .expect("write DNG");
            CString::new(path.to_str().expect("UTF-8")).expect("no NUL")
        })
        .collect()
}

fn last_error() -> String {
    // SAFETY: a non-null result is a NUL-terminated thread-local string.
    unsafe {
        let ptr = maple_last_error();
        if ptr.is_null() {
            return String::new();
        }
        CStr::from_ptr(ptr).to_string_lossy().into_owned()
    }
}

fn preview(dir: &Path, limit: u64) -> i32 {
    let inputs = frames(dir);
    let ptrs: Vec<_> = inputs.iter().map(|c| c.as_ptr()).collect();
    let out = CString::new(dir.join("preview.png").to_str().unwrap()).unwrap();
    let cache = CString::new(dir.join("cache").to_str().unwrap()).unwrap();
    // SAFETY: every pointer is a live CString for the synchronous call.
    unsafe {
        maple_pano_preview_constrained(
            ptrs.as_ptr(),
            ptrs.len(),
            out.as_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null_mut(),
            MaplePanoEdges::default(),
            std::ptr::null_mut(),
            MaplePanoRetention::Keep,
            MaplePanoLocalAlign::Off,
            MaplePanoStrategy::Auto,
            MaplePanoFeatureEngine::Classical,
            std::ptr::null(),
            limit,
            cache.as_ptr(),
            None,
            std::ptr::null_mut(),
            std::ptr::null(),
        )
    }
}

fn stitch(dir: &Path, limit: u64) -> i32 {
    let inputs = frames(dir);
    let ptrs: Vec<_> = inputs.iter().map(|c| c.as_ptr()).collect();
    let out = CString::new(dir.join("pano.png").to_str().unwrap()).unwrap();
    // SAFETY: every pointer is a live CString for the synchronous call.
    unsafe {
        maple_pano_stitch_constrained(
            ptrs.as_ptr(),
            ptrs.len(),
            out.as_ptr(),
            std::ptr::null(),
            0,
            MaplePanoEdges::default(),
            std::ptr::null_mut(),
            MaplePanoRetention::Keep,
            MaplePanoLocalAlign::Off,
            MaplePanoStrategy::Auto,
            MaplePanoFeatureEngine::Classical,
            std::ptr::null(),
            limit,
            None,
            std::ptr::null_mut(),
            std::ptr::null(),
        )
    }
}

#[test]
fn a_preview_over_the_limit_is_refused_before_any_develop() {
    let dir = tempfile::tempdir().expect("tempdir");
    assert_eq!(preview(dir.path(), 1), -12);
    assert!(last_error().contains("memory"), "{}", last_error());
    assert!(!dir.path().join("cache").exists());
    assert!(!dir.path().join("preview.png").exists());
}

#[test]
fn a_stitch_over_the_limit_is_refused() {
    let dir = tempfile::tempdir().expect("tempdir");
    assert_eq!(stitch(dir.path(), 1), -12);
    assert!(last_error().contains("memory"), "{}", last_error());
    assert!(!dir.path().join("pano.png").exists());
}

#[test]
fn no_limit_gets_past_the_memory_check() {
    let dir = tempfile::tempdir().expect("tempdir");
    assert_ne!(preview(dir.path(), 0), -12);
    assert_ne!(stitch(dir.path(), 0), -12);
}
