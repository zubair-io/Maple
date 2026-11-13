//! #5458: both Auto fit entries report a missing embedded preview with their
//! own return code, so hosts can say why Auto is showing Neutral.
use super::*;
use crate::auto_profile::{maple_compute_auto_profile_lut, MAPLE_AUTO_FIT_NO_PREVIEW};
use raw_core::test_support::synth_dng::SyntheticGreyDng;
use raw_core::view::auto_profile::PROFILE_CURVE_FLAT_LEN;

#[test]
fn preview_less_dng_reports_no_preview_from_every_fit_entry() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("synth-no-preview.dng");
    SyntheticGreyDng::default().write_to(&path).unwrap();
    let c_path = std::ffi::CString::new(path.to_str().unwrap()).unwrap();

    let mut cube = vec![0f32; 2 * 2 * 2 * 3];
    let rc = unsafe {
        maple_compute_auto_profile_lut(c_path.as_ptr(), std::ptr::null(), 1, 2, cube.as_mut_ptr())
    };
    assert_eq!(rc, MAPLE_AUTO_FIT_NO_PREVIEW);

    let mut curve = [0f32; PROFILE_CURVE_FLAT_LEN];
    let mut present = -1i32;
    let mut lut = vec![0f32; 8];
    let mut size = 999u32;
    for edge in [None, Some(64)] {
        let rc = unsafe {
            match edge {
                None => maple_gpu_fit_auto_profile(
                    c_path.as_ptr(),
                    std::ptr::null(),
                    1,
                    curve.as_mut_ptr(),
                    &mut present,
                    lut.as_mut_ptr(),
                    lut.len(),
                    &mut size,
                ),
                Some(edge) => sized::maple_gpu_fit_auto_profile_at_render_size(
                    c_path.as_ptr(),
                    std::ptr::null(),
                    1,
                    edge,
                    curve.as_mut_ptr(),
                    &mut present,
                    lut.as_mut_ptr(),
                    lut.len(),
                    &mut size,
                ),
            }
        };
        assert_eq!(rc, MAPLE_AUTO_FIT_NO_PREVIEW, "edge {edge:?}");
        assert_eq!((present, size), (0, 0), "edge {edge:?}");
    }
}
