//! `maple_sample_mask_range_oriented` — the colour-range eyedropper (#362)
//! for the Apple host's mask panel. Same transport as
//! `maple_sample_white_balance_oriented`: a RAW path, an optional XMP path,
//! a display-oriented normalised click point, and a `#[repr(C)]` out struct
//! carrying the four seeded `papp:Range*` coordinates (the host keeps the
//! layer's own band width and feather).
//!
//! Return codes: `0` ok; `1` null argument; `2` non-UTF-8 path; `3` read /
//! decode / develop failure; `11` point outside the image; `13` too dark;
//! `15` neutral (no hue to select). Every non-zero code also sets
//! `maple_last_error` with the user-facing message.

use std::borrow::Cow;
use std::os::raw::c_char;

use raw_core::stages::mask_range_sample::{
    sample_mask_range, seed_skin_mask_range_if_default_inert, stage_input_model, RangeSampleError,
    RangeSeed,
};

use crate::error::{catch_panic_rc, set_last_error, with_large_stack};
use crate::model::{load_xmp_model_owned, LoadModel};
use crate::scene_linear_chain::{chain_inputs_from_params, MapleAdjustmentParams};
use crate::scene_linear_chain_curves::{inject_tone_curves, MapleToneCurves};
use crate::white_balance_sample::display_point_to_sensor;

#[repr(C)]
pub struct MapleRangeSeed {
    pub hue_deg: f32,
    pub chroma_min: f32,
    pub l_min: f32,
    pub l_max: f32,
}

fn code_for(err: &RangeSampleError) -> i32 {
    match err {
        RangeSampleError::Develop(_) => 3,
        RangeSampleError::OutsideImage => 11,
        RangeSampleError::TooDark => 13,
        RangeSampleError::Neutral => 15,
    }
}

/// Sample the colour under an uncropped DISPLAY-oriented image point and
/// return the range seed for it. Apple first inverts its crop/straighten
/// and canvas transforms (`WhiteBalancePickGeometry`); this boundary uses
/// the decoder's own EXIF orientation to address the un-oriented probe,
/// exactly as the white-balance sampler does (#3308).
///
/// # Safety
/// `raw_path` must be a valid NUL-terminated C string; `xmp_path` may be
/// null; `out` must point to writable storage for one `MapleRangeSeed`.
#[no_mangle]
pub unsafe extern "C" fn maple_sample_mask_range_oriented(
    raw_path: *const c_char,
    xmp_path: *const c_char,
    nx: f32,
    ny: f32,
    out: *mut MapleRangeSeed,
) -> i32 {
    if raw_path.is_null() || out.is_null() {
        return 1;
    }
    let raw_str = match unsafe { std::ffi::CStr::from_ptr(raw_path) }.to_str() {
        Ok(s) => s.to_owned(),
        Err(_) => {
            set_last_error("raw_path is not valid UTF-8".into());
            return 2;
        }
    };
    let xmp_owned: Option<String> = if xmp_path.is_null() {
        None
    } else {
        match unsafe { std::ffi::CStr::from_ptr(xmp_path) }.to_str() {
            Ok(s) => Some(s.to_owned()),
            Err(_) => {
                set_last_error("xmp_path is not valid UTF-8".into());
                return 2;
            }
        }
    };
    let out_usize = out as usize;
    with_large_stack(move || {
        let out_ptr = out_usize as *mut MapleRangeSeed;
        let model = match load_xmp_model_owned(xmp_owned.as_deref()) {
            LoadModel::Ok(m) => m,
            LoadModel::Err(code) => return code,
        };
        let raw_bytes = match std::fs::read(&raw_str) {
            Ok(b) => b,
            Err(e) => {
                set_last_error(format!("raw read: {}", e));
                return 3;
            }
        };
        let ext = std::path::Path::new(&raw_str)
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_ascii_lowercase())
            .unwrap_or_default();
        let raw_img = match raw_core::decode::decode_bytes(&raw_bytes, &ext) {
            Ok(r) => r,
            Err(e) => {
                set_last_error(format!("raw decode: {}", e));
                return 3;
            }
        };
        let (nx, ny) = display_point_to_sensor(raw_img.orientation, nx, ny);
        match sample_mask_range(&raw_img, &model, nx, ny) {
            Ok(sample) => {
                let seed = RangeSeed::from_sample(&sample);
                unsafe {
                    *out_ptr = MapleRangeSeed {
                        hue_deg: seed.hue_deg,
                        chroma_min: seed.chroma_min,
                        l_min: seed.l_min,
                        l_max: seed.l_max,
                    };
                }
                0
            }
            Err(e) => {
                set_last_error(e.to_string());
                code_for(&e)
            }
        }
    })
}

/// Evaluate whether the default skin-tone range (`55° ± 25°`) is inert over
/// `mask_ptr`. When `params` is non-null, `rgba_ptr` is developed to the
/// `local_adjustments` stage input using `params` and upstream scene-linear
/// `curves` (excluding downstream display curves and post-mask stages). When
/// `params` is null, `rgba_ptr` is read directly as an already-developed
/// pre-`local_adjustments` scene-linear Rec.2020 `RGBAf` buffer.
/// Writes the adaptive `MapleRangeSeed` to `out` and returns `0` when
/// adaptation is needed, `1` when the default skin-tone range should be kept
/// unchanged, `2` on invalid arguments, or `8` on chain failure.
///
/// # Safety
/// `rgba_ptr` must point to `width * height * 4` `f32` values; `params` and
/// `curves` may be null or valid pointers for the duration of the call;
/// `mask_ptr` must point to `mask_len` (`width * height`) `u8` values; `out`
/// must point to writable storage for one `MapleRangeSeed`.
#[no_mangle]
pub unsafe extern "C" fn maple_seed_skin_mask_range_if_default_inert(
    rgba_ptr: *const f32,
    width: usize,
    height: usize,
    params: *const MapleAdjustmentParams,
    curves: *const MapleToneCurves,
    mask_ptr: *const u8,
    mask_len: usize,
    out: *mut MapleRangeSeed,
) -> i32 {
    catch_panic_rc("maple_seed_skin_mask_range_if_default_inert", || {
        if rgba_ptr.is_null() || mask_ptr.is_null() || out.is_null() {
            return 2;
        }
        let Some(pixel_count) = width.checked_mul(height) else {
            return 2;
        };
        let Some(float_count) = pixel_count.checked_mul(4) else {
            return 2;
        };
        if pixel_count == 0
            || mask_len != pixel_count
            || u32::try_from(width).is_err()
            || u32::try_from(height).is_err()
        {
            return 2;
        }
        let rgba = unsafe { std::slice::from_raw_parts(rgba_ptr, float_count) };
        let mask = unsafe { std::slice::from_raw_parts(mask_ptr, mask_len) };
        let stage_rgba: Cow<'_, [f32]> = if params.is_null() {
            Cow::Borrowed(rgba)
        } else {
            let p = unsafe { &*params };
            let mut ci = match unsafe { chain_inputs_from_params(p) } {
                Ok(ci) => ci,
                Err(e) => {
                    set_last_error(e);
                    return 8;
                }
            };
            if !curves.is_null() {
                unsafe { inject_tone_curves(&mut ci.model, &*curves) };
            }
            let stage_model = stage_input_model(&ci.model);
            let opts = ci.options(true);
            match raw_core::pipeline::apply_scene_linear_chain_f32(
                rgba,
                width as u32,
                height as u32,
                &stage_model,
                &opts,
            ) {
                Ok(v) => Cow::Owned(v),
                Err(e) => {
                    set_last_error(format!("seed_skin_mask_range: {}", e));
                    return 8;
                }
            }
        };
        match seed_skin_mask_range_if_default_inert(&stage_rgba, width, height, mask) {
            Some(seed) => {
                unsafe {
                    *out = MapleRangeSeed {
                        hue_deg: seed.hue_deg,
                        chroma_min: seed.chroma_min,
                        l_min: seed.l_min,
                        l_max: seed.l_max,
                    };
                }
                0
            }
            None => 1,
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::CString;

    fn out() -> MapleRangeSeed {
        MapleRangeSeed {
            hue_deg: 0.0,
            chroma_min: 0.0,
            l_min: 0.0,
            l_max: 0.0,
        }
    }

    #[test]
    fn null_arguments_are_rejected() {
        let mut o = out();
        assert_eq!(
            unsafe {
                maple_sample_mask_range_oriented(
                    std::ptr::null(),
                    std::ptr::null(),
                    0.5,
                    0.5,
                    &mut o,
                )
            },
            1
        );
        let p = CString::new("/nonexistent.dng").unwrap();
        assert_eq!(
            unsafe {
                maple_sample_mask_range_oriented(
                    p.as_ptr(),
                    std::ptr::null(),
                    0.5,
                    0.5,
                    std::ptr::null_mut(),
                )
            },
            1
        );
    }

    #[test]
    fn unreadable_raw_reports_code_3() {
        let mut o = out();
        let p = CString::new("/nonexistent/maple-362.dng").unwrap();
        assert_eq!(
            unsafe {
                maple_sample_mask_range_oriented(p.as_ptr(), std::ptr::null(), 0.5, 0.5, &mut o)
            },
            3
        );
    }

    /// The error codes are the contract the host keys its messages on.
    #[test]
    fn sample_error_codes_are_stable() {
        assert_eq!(code_for(&RangeSampleError::OutsideImage), 11);
        assert_eq!(code_for(&RangeSampleError::TooDark), 13);
        assert_eq!(code_for(&RangeSampleError::Neutral), 15);
        assert_eq!(code_for(&RangeSampleError::Develop("x".into())), 3);
    }

    #[test]
    fn skin_mask_seed_ffi_validates_and_adapts() {
        let mut o = out();
        assert_eq!(
            unsafe {
                maple_seed_skin_mask_range_if_default_inert(
                    std::ptr::null(),
                    8,
                    8,
                    std::ptr::null(),
                    std::ptr::null(),
                    std::ptr::null(),
                    64,
                    &mut o,
                )
            },
            2
        );
        let mask = [255_u8; 64];
        let mut covered = Vec::with_capacity(64 * 4);
        for _ in 0..64 {
            covered.extend_from_slice(&[0.35_f32, 0.22, 0.14, 1.0]);
        }
        assert_eq!(
            unsafe {
                maple_seed_skin_mask_range_if_default_inert(
                    covered.as_ptr(),
                    8,
                    8,
                    std::ptr::null(),
                    std::ptr::null(),
                    mask.as_ptr(),
                    mask.len(),
                    &mut o,
                )
            },
            1
        );

        let mut params: MapleAdjustmentParams = unsafe { std::mem::zeroed() };
        params.temperature = 6500.0;
        params.decoded_temperature = 6500.0;
        params.skip_agx = 1;
        let blue_boost = [0.0_f32, 0.06, 1.0, 0.06];
        let mut display_only: MapleToneCurves = unsafe { std::mem::zeroed() };
        display_only.display_blue_ptr = blue_boost.as_ptr();
        display_only.display_blue_len = blue_boost.len();
        assert_eq!(
            unsafe {
                maple_seed_skin_mask_range_if_default_inert(
                    covered.as_ptr(),
                    8,
                    8,
                    &params,
                    &display_only,
                    mask.as_ptr(),
                    mask.len(),
                    &mut o,
                )
            },
            1
        );

        let mut upstream_curves: MapleToneCurves = unsafe { std::mem::zeroed() };
        upstream_curves.blue_ptr = blue_boost.as_ptr();
        upstream_curves.blue_len = blue_boost.len();
        assert_eq!(
            unsafe {
                maple_seed_skin_mask_range_if_default_inert(
                    covered.as_ptr(),
                    8,
                    8,
                    &params,
                    &upstream_curves,
                    mask.as_ptr(),
                    mask.len(),
                    &mut o,
                )
            },
            0
        );
        assert!(o.hue_deg < 20.0);
    }
}
