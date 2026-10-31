//! Gate for `maple_pano_preview` + `maple_pano_stitch_aligned` (#4578),
//! through the actual C entry points on the first three pano_01 frames:
//!
//! - the preview writes a ~2048 px PNG and a solved alignment;
//! - a composite-only option change reuses that alignment (rc 0), a
//!   geometry option change does not (rc 1, reason in `maple_last_error`);
//! - a full stitch from the preview's alignment is pixel-identical to a
//!   fresh `maple_pano_stitch` with the same options.
//!
//! Skip-passes when fixtures, `MAPLE_PANO_MODELS`, or `ORT_DYLIB_PATH` are
//! absent. Run in release:
//! ```text
//! MAPLE_PANO_MODELS=~/.cache/maple-pano/models \
//! ORT_DYLIB_PATH=~/.cache/maple-pano/ort/onnxruntime-osx-arm64-1.23.2/lib/libonnxruntime.dylib \
//! cargo test --release -p raw-ffi --features pano --test pano_preview_ffi_gates -- --nocapture
//! ```

#![cfg(all(feature = "pano", target_os = "macos"))]

use std::ffi::{c_char, CStr, CString};
use std::path::{Path, PathBuf};
use std::time::Instant;

use raw_ffi::{
    maple_last_error, maple_pano_preview, maple_pano_stitch, maple_pano_stitch_aligned,
    MaplePanoFeatureEngine, MaplePanoLocalAlign, MaplePanoPreviewSizes, MaplePanoRetention,
    MaplePanoStrategy,
};

const FRAMES: usize = 3;
const PANO_01_FRAME_PX: u64 = 20_813_856;

fn fixture_frames() -> Result<Vec<PathBuf>, String> {
    for var in ["MAPLE_PANO_MODELS", "ORT_DYLIB_PATH"] {
        std::env::var(var).map_err(|_| format!("{var} not set"))?;
    }
    pano_01_frames()
}

fn pano_01_frames() -> Result<Vec<PathBuf>, String> {
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .map(|d| d.join("test-fixtures/raws/pano_01"))
        .find(|d| d.is_dir())
        .ok_or("test-fixtures/raws/pano_01 absent")?;
    let mut frames: Vec<PathBuf> = std::fs::read_dir(&dir)
        .map_err(|e| e.to_string())?
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.extension().is_some_and(|e| e.eq_ignore_ascii_case("dng")))
        .collect();
    frames.sort();
    frames.truncate(FRAMES);
    (frames.len() == FRAMES)
        .then_some(frames)
        .ok_or_else(|| format!("need {FRAMES} DNGs in {}", dir.display()))
}

fn c(p: &Path) -> CString {
    CString::new(p.to_str().expect("UTF-8 path")).expect("no NUL")
}

fn last_error() -> String {
    unsafe {
        let ptr = maple_last_error();
        if ptr.is_null() {
            String::new()
        } else {
            CStr::from_ptr(ptr).to_string_lossy().into_owned()
        }
    }
}

struct Frames {
    _owned: Vec<CString>,
    ptrs: Vec<*const c_char>,
}

impl Frames {
    fn new(paths: &[PathBuf]) -> Self {
        let owned: Vec<CString> = paths.iter().map(|p| c(p)).collect();
        let ptrs = owned.iter().map(|s| s.as_ptr()).collect();
        Self {
            _owned: owned,
            ptrs,
        }
    }
}

fn preview(
    frames: &Frames,
    out: &Path,
    alignment_in: Option<&Path>,
    alignment_out: Option<&Path>,
    local_align: MaplePanoLocalAlign,
    strategy: MaplePanoStrategy,
    engine: MaplePanoFeatureEngine,
) -> (i32, f64, MaplePanoPreviewSizes) {
    let (out, a_in, a_out) = (c(out), alignment_in.map(c), alignment_out.map(c));
    let mut sizes = MaplePanoPreviewSizes::default();
    let t = Instant::now();
    let rc = unsafe {
        maple_pano_preview(
            frames.ptrs.as_ptr(),
            frames.ptrs.len(),
            out.as_ptr(),
            a_in.as_ref().map_or(std::ptr::null(), |s| s.as_ptr()),
            a_out.as_ref().map_or(std::ptr::null(), |s| s.as_ptr()),
            &mut sizes,
            MaplePanoRetention::Keep,
            local_align,
            strategy,
            engine,
            None,
            std::ptr::null_mut(),
            std::ptr::null(),
        )
    };
    (rc, t.elapsed().as_secs_f64(), sizes)
}

fn rgb16(path: &Path) -> image::ImageBuffer<image::Rgb<u16>, Vec<u16>> {
    image::open(path)
        .unwrap_or_else(|e| panic!("{}: {e}", path.display()))
        .into_rgb16()
}

#[test]
fn preview_alignment_reuse_and_identical_full_stitch() {
    let paths = match fixture_frames() {
        Ok(p) => p,
        Err(reason) => {
            eprintln!("pano_preview_ffi_gates: SKIP-PASS — {reason}");
            return;
        }
    };
    let frames = Frames::new(&paths);
    let tmp = tempfile::tempdir().expect("temp dir");
    let at = |name: &str| tmp.path().join(name);

    let (rc, fresh_s, _) = preview(
        &frames,
        &at("preview.png"),
        None,
        Some(&at("alignment.json")),
        MaplePanoLocalAlign::Mesh,
        MaplePanoStrategy::Auto,
        MaplePanoFeatureEngine::Ml,
    );
    assert_eq!(rc, 0, "fresh preview: {}", last_error());
    let shot = rgb16(&at("preview.png"));
    let long_edge = shot.width().max(shot.height());
    assert!(
        (1900..=2048).contains(&long_edge),
        "preview long edge {long_edge}"
    );

    let (rc, reused_s, _) = preview(
        &frames,
        &at("preview-off.png"),
        Some(&at("alignment.json")),
        None,
        MaplePanoLocalAlign::Off,
        MaplePanoStrategy::Auto,
        MaplePanoFeatureEngine::Ml,
    );
    assert_eq!(rc, 0, "composite-only change must reuse: {}", last_error());
    eprintln!("pano_preview_ffi_gates: preview fresh {fresh_s:.1}s, reused {reused_s:.1}s");

    let (rc, _, _) = preview(
        &frames,
        &at("preview-tile.png"),
        Some(&at("alignment.json")),
        None,
        MaplePanoLocalAlign::Mesh,
        MaplePanoStrategy::Tile,
        MaplePanoFeatureEngine::Ml,
    );
    assert_eq!(rc, 1, "geometry change must not reuse");
    assert!(
        last_error().contains("strategy auto → tile"),
        "{}",
        last_error()
    );

    let (fresh_png, aligned_png, alignment) = (
        c(&at("fresh.png")),
        c(&at("aligned.png")),
        c(&at("alignment.json")),
    );
    let t = Instant::now();
    let rc = unsafe {
        maple_pano_stitch(
            frames.ptrs.as_ptr(),
            frames.ptrs.len(),
            fresh_png.as_ptr(),
            MaplePanoRetention::Keep,
            MaplePanoLocalAlign::Mesh,
            MaplePanoStrategy::Auto,
            MaplePanoFeatureEngine::Ml,
            None,
            std::ptr::null_mut(),
            std::ptr::null(),
        )
    };
    let fresh_stitch_s = t.elapsed().as_secs_f64();
    assert_eq!(rc, 0, "fresh stitch: {}", last_error());
    let t = Instant::now();
    let rc = unsafe {
        maple_pano_stitch_aligned(
            frames.ptrs.as_ptr(),
            frames.ptrs.len(),
            aligned_png.as_ptr(),
            alignment.as_ptr(),
            0,
            MaplePanoRetention::Keep,
            MaplePanoLocalAlign::Mesh,
            MaplePanoStrategy::Auto,
            MaplePanoFeatureEngine::Ml,
            None,
            std::ptr::null_mut(),
            std::ptr::null(),
        )
    };
    let aligned_stitch_s = t.elapsed().as_secs_f64();
    assert_eq!(rc, 0, "aligned stitch must reuse: {}", last_error());
    eprintln!(
        "pano_preview_ffi_gates: full stitch fresh {fresh_stitch_s:.1}s, \
         from alignment {aligned_stitch_s:.1}s"
    );

    let (fresh, aligned) = (rgb16(&at("fresh.png")), rgb16(&at("aligned.png")));
    assert_eq!(fresh.dimensions(), aligned.dimensions());
    assert!(
        fresh.as_raw() == aligned.as_raw(),
        "stitch from the preview's alignment must be pixel-identical to a fresh stitch"
    );
}

/// The preview's full-stitch size report matches the stitch it previews,
/// and a canvas cap bounds the output (#5454). Classical engine, so it runs
/// wherever the pano_01 RAWs are present.
#[test]
fn preview_sizes_predict_the_full_stitch_and_a_cap_bounds_it() {
    let paths = match pano_01_frames() {
        Ok(p) => p,
        Err(reason) => {
            eprintln!("pano_preview_ffi_gates: SKIP-PASS — {reason}");
            return;
        }
    };
    let frames = Frames::new(&paths);
    let tmp = tempfile::tempdir().expect("temp dir");
    let at = |name: &str| tmp.path().join(name);

    let (rc, _, sizes) = preview(
        &frames,
        &at("preview.png"),
        None,
        Some(&at("alignment.json")),
        MaplePanoLocalAlign::Mesh,
        MaplePanoStrategy::Auto,
        MaplePanoFeatureEngine::Classical,
    );
    assert_eq!(rc, 0, "preview: {}", last_error());

    let stitch = |out: &Path, cap: u64| {
        let (out, alignment) = (c(out), c(&at("alignment.json")));
        unsafe {
            maple_pano_stitch_aligned(
                frames.ptrs.as_ptr(),
                frames.ptrs.len(),
                out.as_ptr(),
                alignment.as_ptr(),
                cap,
                MaplePanoRetention::Keep,
                MaplePanoLocalAlign::Mesh,
                MaplePanoStrategy::Auto,
                MaplePanoFeatureEngine::Classical,
                None,
                std::ptr::null_mut(),
                std::ptr::null(),
            )
        }
    };
    assert_eq!(
        stitch(&at("fresh.png"), 0),
        0,
        "full stitch: {}",
        last_error()
    );
    let fresh = rgb16(&at("fresh.png"));

    // The preview solves on proxy-accuracy matches, so its canvas bounds
    // drift a few percent from the refined solve's (3.9 % in height on
    // pano_01's first three frames) — close enough to budget memory with.
    let within = |estimate: u32, actual: u32| (estimate as f64 / actual as f64 - 1.0).abs() < 0.06;
    assert!(
        within(sizes.full_width, fresh.width()) && within(sizes.full_height, fresh.height()),
        "preview full-canvas estimate {sizes:?} vs stitched {:?}",
        fresh.dimensions()
    );
    assert_eq!(
        sizes.largest_frame_px, PANO_01_FRAME_PX,
        "pano_01 frames are 5272 × 3948 (DefaultCropSize)"
    );
    assert_eq!(
        Some(sizes.scratch_bytes),
        maple_pano::frame_store::FrameStore::required_bytes(&vec![(5272, 3948); paths.len()]),
        "the preview reports exactly what the stitch's frame store reserves"
    );

    let cap = fresh.width() as u64 * fresh.height() as u64 / 4;
    assert_eq!(
        stitch(&at("capped.png"), cap),
        0,
        "capped stitch must still reuse: {}",
        last_error()
    );
    let capped = rgb16(&at("capped.png"));
    let capped_px = capped.width() as u64 * capped.height() as u64;
    assert!(
        capped_px <= cap && capped_px as f64 >= cap as f64 * 0.9,
        "capped stitch {:?} = {capped_px} px against cap {cap}",
        capped.dimensions()
    );

    // Past the 8× natural-to-cap ratio the degenerate-geometry guard uses:
    // a small output must not read as runaway geometry.
    let tiny_cap = fresh.width() as u64 * fresh.height() as u64 / 16;
    assert_eq!(
        stitch(&at("tiny.png"), tiny_cap),
        0,
        "a 1/16-area output cap must still stitch: {}",
        last_error()
    );
}
