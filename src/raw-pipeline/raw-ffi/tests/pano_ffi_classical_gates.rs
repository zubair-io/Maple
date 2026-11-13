//! `maple_pano_stitch` with the classical engine (#4554): a fresh install
//! has no ONNX models or runtime, and the merge must still work. The ML
//! environment is pointed at paths that do not exist, so any ORT or model
//! load on this path fails the stitch.
//!
//! Skip-passes when `test-fixtures/raws/pano_01/` is absent. Release only:
//! ```text
//! cargo test --release -p raw-ffi --features pano --test pano_ffi_classical_gates -- --nocapture
//! ```

#![cfg(all(feature = "pano", target_os = "macos"))]

use std::ffi::{c_char, CString};
use std::path::{Path, PathBuf};

use raw_ffi::{
    maple_last_error, maple_pano_stitch, MaplePanoFeatureEngine, MaplePanoLocalAlign,
    MaplePanoRetention, MaplePanoStrategy,
};

fn pano_01_frames() -> Option<Vec<PathBuf>> {
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let root = manifest
        .ancestors()
        .find(|dir| dir.join("test-fixtures").is_dir())?;
    let dir = root.join("test-fixtures/raws/pano_01");
    let mut frames: Vec<PathBuf> = std::fs::read_dir(dir)
        .ok()?
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| {
            p.extension()
                .and_then(|e| e.to_str())
                .is_some_and(|e| e.eq_ignore_ascii_case("dng"))
        })
        .collect();
    frames.sort();
    (frames.len() >= 2).then_some(frames)
}

fn stitch(frames: &[PathBuf], out: &Path, engine: MaplePanoFeatureEngine) -> i32 {
    let inputs: Vec<CString> = frames
        .iter()
        .map(|p| CString::new(p.to_str().expect("UTF-8 path")).expect("no NUL"))
        .collect();
    let ptrs: Vec<*const c_char> = inputs.iter().map(|c| c.as_ptr()).collect();
    let out_c = CString::new(out.to_str().expect("UTF-8 path")).expect("no NUL");
    // SAFETY: every pointer is a live CString for the synchronous call.
    unsafe {
        maple_pano_stitch(
            ptrs.as_ptr(),
            ptrs.len(),
            out_c.as_ptr(),
            MaplePanoRetention::Keep,
            MaplePanoLocalAlign::Mesh,
            MaplePanoStrategy::Auto,
            engine,
            None,
            std::ptr::null_mut(),
            std::ptr::null(),
        )
    }
}

fn last_error() -> String {
    // SAFETY: maple_last_error has no preconditions; a non-null result is a
    // NUL-terminated thread-local string that outlives this read.
    unsafe {
        let ptr = maple_last_error();
        if ptr.is_null() {
            return String::new();
        }
        std::ffi::CStr::from_ptr(ptr).to_string_lossy().into_owned()
    }
}

#[test]
fn classical_engine_stitches_pano_01_without_ml_runtime() {
    let Some(frames) = pano_01_frames() else {
        eprintln!("pano_ffi_classical_gates: SKIP-PASS — pano_01 fixtures absent");
        return;
    };
    let tmp = tempfile::tempdir().expect("temp dir");
    let missing = tmp.path().join("no-ml-installed");
    std::env::set_var("MAPLE_PANO_MODELS", &missing);
    std::env::set_var("ORT_DYLIB_PATH", missing.join("libonnxruntime.dylib"));

    let ml_rc = stitch(
        &frames[..2],
        &tmp.path().join("ml.png"),
        MaplePanoFeatureEngine::Ml,
    );
    assert_eq!(
        ml_rc,
        -6,
        "ML engine without models must report the ML environment unavailable: {}",
        last_error()
    );

    let out = tmp.path().join("classical.png");
    let started = std::time::Instant::now();
    let rc = stitch(&frames, &out, MaplePanoFeatureEngine::Classical);
    assert_eq!(rc, 0, "classical stitch failed: {}", last_error());

    let (width, height) = image::image_dimensions(&out).expect("read stitched PNG");
    eprintln!(
        "pano_ffi_classical_gates: {} frames → {width}×{height} in {:.1}s",
        frames.len(),
        started.elapsed().as_secs_f64()
    );
    assert!(
        width > height,
        "pano_01 is a wide rotation set; got {width}×{height}"
    );
}
