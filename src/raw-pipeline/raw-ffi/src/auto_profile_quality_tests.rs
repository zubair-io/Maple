//! #1472: AMaZE must never select Preview artifacts across the C boundary.
//! Distinct cached fits on an undecodable file prove both quality selection
//! and that a cache hit does not depend on a new RAW decode.
use raw_core::pipeline::RenderQuality;
#[cfg(feature = "gpu")]
use raw_core::view::auto_profile::PROFILE_CURVE_FLAT_LEN;
use raw_core::view::auto_profile::{bake_auto_profile_lut, cache, lut::ColorLut, ProfileCurve};

fn seed(path: &std::path::Path) -> Vec<(i32, ProfileCurve, ColorLut)> {
    [
        (0, RenderQuality::Full, 0.8f32),
        (1, RenderQuality::Preview, 1.0),
        (2, RenderQuality::Amaze, 1.2),
        (3, RenderQuality::Auto, 1.4),
    ]
    .into_iter()
    .map(|(wire, quality, gamma)| {
        let mut curve = ProfileCurve::identity();
        for anchor in &mut curve.r.anchors {
            anchor.1 = anchor.0.powf(gamma);
        }
        let mut residual = ColorLut::identity(5);
        for value in &mut residual.data {
            *value = value.powf(gamma);
        }
        let key = cache::CacheKey::from_path(path, quality).unwrap();
        cache::insert(key.clone(), curve.clone());
        cache::insert_lut(key, residual.clone());
        (wire, curve, residual)
    })
    .collect()
}

#[test]
fn cube_selects_exact_full_preview_amaze_and_auto_cache_entries() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("quality-cube.dng");
    std::fs::write(&path, b"not a decodable RAW").unwrap();
    let cpath = std::ffi::CString::new(path.to_str().unwrap()).unwrap();
    for (wire, curve, residual) in seed(&path) {
        let mut output = vec![f32::NAN; 9 * 9 * 9 * 3];
        let rc = unsafe {
            crate::auto_profile::maple_compute_auto_profile_lut(
                cpath.as_ptr(),
                std::ptr::null(),
                wire,
                9,
                output.as_mut_ptr(),
            )
        };
        assert_eq!(rc, 0, "quality={wire}: cached fit must bypass decode");
        assert_eq!(
            output,
            bake_auto_profile_lut(&curve, &residual, 9),
            "quality={wire}"
        );
    }
}

#[cfg(feature = "gpu")]
#[test]
fn separate_artifacts_select_exact_full_preview_amaze_and_auto_cache_entries() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("quality-gpu.dng");
    std::fs::write(&path, b"not a decodable RAW").unwrap();
    let cpath = std::ffi::CString::new(path.to_str().unwrap()).unwrap();
    for (wire, curve, residual) in seed(&path) {
        let mut output_curve = [f32::NAN; PROFILE_CURVE_FLAT_LEN];
        let mut present = 0;
        let mut size = 0;
        let mut output_lut = vec![f32::NAN; residual.data.len()];
        let rc = unsafe {
            crate::gpu_auto_profile::maple_gpu_fit_auto_profile(
                cpath.as_ptr(),
                std::ptr::null(),
                wire,
                output_curve.as_mut_ptr(),
                &mut present,
                output_lut.as_mut_ptr(),
                output_lut.len(),
                &mut size,
            )
        };
        assert_eq!(rc, 0, "quality={wire}: cached fit must bypass decode");
        assert_eq!(present, 1);
        assert_eq!(size, residual.size as u32);
        assert_eq!(output_curve.as_slice(), curve.to_flat(), "quality={wire}");
        assert_eq!(output_lut, residual.data, "quality={wire}");
    }
}
