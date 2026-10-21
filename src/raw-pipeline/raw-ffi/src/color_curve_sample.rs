//! `maple_sample_color_curve_oriented` — the stage-input eyedropper (#5041)
//! for Oklab secondary color curves.
//!
//! Develops a fast 512px preview up to the input of Stage 22b (`stages::color_curves`,
//! i.e. after WB, Exposure, Tone Curve, Vibrance, Saturation, and 8-band HSL,
//! but before AgX and Color Grading), averages a 5x5 patch around `(nx, ny)`,
//! and returns normalized `(u_h, u_c, u_l)` in `[0, 1]` plus Oklab `(l, c, hue_deg)`.
//!
//! Return codes: `0` ok; `1` null argument; `2` non-UTF-8 path; `3` read /
//! decode / develop failure; `11` point outside the image; `13` too dark;
//! `15` neutral (below `CHROMA_GATE_C0 = 0.05`).

use std::os::raw::c_char;

use raw_core::stages::color_curve_sample::{sample_color_curve_input, ColorCurveSampleError};

use crate::error::{set_last_error, with_large_stack};
use crate::model::{load_xmp_model_owned, LoadModel};
use crate::white_balance_sample::display_point_to_sensor;

#[repr(C)]
pub struct MapleColorCurveSample {
    pub u_h: f32,
    pub u_c: f32,
    pub u_l: f32,
    pub l: f32,
    pub c: f32,
    pub hue_deg: f32,
}

fn code_for(err: &ColorCurveSampleError) -> i32 {
    match err {
        ColorCurveSampleError::Develop(_) => 3,
        ColorCurveSampleError::OutsideImage => 11,
        ColorCurveSampleError::TooDark => 13,
        ColorCurveSampleError::Neutral => 15,
    }
}

/// Sample the scene-linear Oklab stage input under an uncropped DISPLAY-oriented
/// image point `(nx, ny)` in `[0, 1]`.
///
/// # Safety
/// `raw_path` must be a valid NUL-terminated C string; `xmp_path` may be null;
/// `out` must point to writable storage for one `MapleColorCurveSample`.
#[no_mangle]
pub unsafe extern "C" fn maple_sample_color_curve_oriented(
    raw_path: *const c_char,
    xmp_path: *const c_char,
    nx: f32,
    ny: f32,
    out: *mut MapleColorCurveSample,
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
        let out_ptr = out_usize as *mut MapleColorCurveSample;
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
        match sample_color_curve_input(&raw_img, &model, nx, ny) {
            Ok(s) => {
                unsafe {
                    *out_ptr = MapleColorCurveSample {
                        u_h: s.u_h,
                        u_c: s.u_c,
                        u_l: s.u_l,
                        l: s.l,
                        c: s.chroma,
                        hue_deg: s.hue_deg,
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::CString;

    fn zero_out() -> MapleColorCurveSample {
        MapleColorCurveSample {
            u_h: 0.0,
            u_c: 0.0,
            u_l: 0.0,
            l: 0.0,
            c: 0.0,
            hue_deg: 0.0,
        }
    }

    #[test]
    fn null_arguments_are_rejected() {
        let mut o = zero_out();
        assert_eq!(
            unsafe {
                maple_sample_color_curve_oriented(
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
                maple_sample_color_curve_oriented(
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
    fn sample_error_codes_are_stable() {
        assert_eq!(code_for(&ColorCurveSampleError::OutsideImage), 11);
        assert_eq!(code_for(&ColorCurveSampleError::TooDark), 13);
        assert_eq!(code_for(&ColorCurveSampleError::Neutral), 15);
        assert_eq!(code_for(&ColorCurveSampleError::Develop("x".into())), 3);
    }
}
