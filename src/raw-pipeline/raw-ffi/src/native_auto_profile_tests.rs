use super::*;
use raw_core::{pipeline::RenderQuality, view::auto_profile::lut::ColorLut};

struct Output {
    curve: Vec<f32>,
    present: i32,
    lut: Vec<f32>,
    size: u32,
}
impl Output {
    fn new() -> Self {
        Self {
            curve: vec![-7.0; PROFILE_CURVE_FLAT_LEN],
            present: -1,
            lut: vec![-7.0; 5usize.pow(3) * 3],
            size: 99,
        }
    }
    fn call(&mut self, path: &Path, quality: i32, cancel: *const MapleCancelFlag) -> i32 {
        let path = std::ffi::CString::new(path.to_str().unwrap()).unwrap();
        unsafe {
            maple_prepare_native_auto_profile(
                path.as_ptr(),
                quality,
                self.curve.as_mut_ptr(),
                &mut self.present,
                self.lut.as_mut_ptr(),
                self.lut.len(),
                &mut self.size,
                cancel,
            )
        }
    }
    fn arrays_untouched(&self) {
        for data in [&self.curve, &self.lut] {
            assert!(data.iter().all(|v| *v == -7.0));
        }
    }
}
fn seed(
    path: &Path,
    quality: RenderQuality,
    origin: FitOrigin,
    tag: f32,
) -> (ProfileCurve, ColorLut) {
    let curve = ProfileCurve::identity();
    let mut lut = ColorLut::identity(5);
    lut.data[0] = tag;
    let key = CacheKey::from_path(path, quality)
        .unwrap()
        .with_origin(origin);
    raw_core::view::auto_profile::cache::insert(key.clone(), curve.clone());
    raw_core::view::auto_profile::cache::insert_lut(key, lut.clone());
    (curve, lut)
}
#[test]
fn native_cache_bypasses_decode_and_keeps_quality_and_proxy_origin_separate() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("native-origin.dng");
    std::fs::write(&path, b"not a decodable RAW").unwrap();
    for (wire, quality) in [
        (0, RenderQuality::Full),
        (1, RenderQuality::Preview),
        (2, RenderQuality::Amaze),
        (3, RenderQuality::Auto),
    ] {
        seed(&path, quality, FitOrigin::Standalone, -9.0);
        let (curve, lut) = seed(
            &path,
            quality,
            FitOrigin::Render(None),
            0.1 + wire as f32 / 10.0,
        );
        let mut out = Output::new();
        assert_eq!(out.call(&path, wire, std::ptr::null()), 0);
        assert_eq!(out.present, 1);
        assert_eq!(out.size, 5);
        assert_eq!(out.curve, curve.to_flat());
        assert_eq!(out.lut, lut.data);
    }
}
#[test]
fn cancelled_cached_and_missing_requests_leave_arrays_untouched() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("cancel-native.dng");
    std::fs::write(&path, b"not a RAW").unwrap();
    seed(&path, RenderQuality::Full, FitOrigin::Render(None), 0.25);
    let flag = crate::cancel::maple_cancel_flag_new();
    unsafe {
        crate::cancel::maple_cancel_flag_set(flag);
    }
    for path in [&path, &directory.path().join("missing.dng")] {
        let mut out = Output::new();
        assert_eq!(out.call(path, 0, flag), 4);
        assert_eq!((out.present, out.size), (0, 0));
        out.arrays_untouched();
    }
    unsafe {
        crate::cancel::maple_cancel_flag_free(flag);
    }
}
#[test]
fn too_small_and_invalid_quality_do_not_partially_copy_artifacts() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("capacity-native.dng");
    std::fs::write(&path, b"not a RAW").unwrap();
    seed(&path, RenderQuality::Full, FitOrigin::Render(None), 0.25);
    let mut out = Output::new();
    out.lut.truncate(1);
    assert_eq!(out.call(&path, 0, std::ptr::null()), -2);
    assert_eq!((out.present, out.size), (0, 5));
    out.arrays_untouched();
    let mut out = Output::new();
    assert_eq!(out.call(&path, 99, std::ptr::null()), -1);
    out.arrays_untouched();
}
#[test]
fn source_change_invalidates_completed_native_cache() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("changed-native.dng");
    std::fs::write(&path, b"not a RAW").unwrap();
    seed(&path, RenderQuality::Full, FitOrigin::Render(None), 0.25);
    std::fs::write(&path, b"changed bytes, still not a RAW").unwrap();
    let mut out = Output::new();
    assert_eq!(out.call(&path, 0, std::ptr::null()), 7);
    out.arrays_untouched();
}
