//! Cold client import hydration through the existing Rust WB resolver (#3434).
use crate::error::{set_last_error, with_large_stack};
use std::ffi::{c_char, CStr};

/// Resolve a partial sidecar against the actual RAW metadata/profile. This cold
/// operation decodes no display pixels and runs once during sidecar hydration.
/// It reuses existing resolution/calibration math without new model wire fields.
///
/// # Safety
/// `xmp` is NUL-terminated UTF-8; `out` points to two writable f32s.
/// `raw_path` is a NUL-terminated UTF-8 RAW path, or NULL for the existing
/// post-DCP / SDR resolver (no camera frame).
#[no_mangle]
pub unsafe extern "C" fn maple_resolve_imported_white_balance_file(
    raw_path: *const c_char,
    xmp: *const c_char,
    out: *mut f32,
) -> i32 {
    if xmp.is_null() || out.is_null() {
        set_last_error("Imported WB: null argument".into());
        return 1;
    }
    let input = unsafe { CStr::from_ptr(xmp) }.to_str().and_then(|xml| {
        if raw_path.is_null() {
            Ok((None, xml.to_owned()))
        } else {
            unsafe { CStr::from_ptr(raw_path) }
                .to_str()
                .map(|path| (Some(path.to_owned()), xml.to_owned()))
        }
    });
    let (path, xml) = match input {
        Ok(input) => input,
        Err(_) => {
            set_last_error("Imported WB: input is not UTF-8".into());
            return 2;
        }
    };
    let result = std::sync::Arc::new(std::sync::Mutex::new(None));
    let worker_result = result.clone();
    let rc = with_large_stack(move || {
        let resolved = raw_core::xmp::parse(&xml).and_then(|model| {
            let Some(path) = path else {
                return Ok(raw_core::stages::white_balance::resolve_wb(&model));
            };
            raw_core::decode::decode(std::path::Path::new(&path)).and_then(|raw| {
                let (profile, source) = raw_core::color::dcp::profile_for_with_source(&raw)?;
                let fallback =
                    matches!(source, raw_core::color::dcp::ProfileSource::RawlerFallback)
                        || (matches!(raw.cfa, raw_core::image::CfaPattern::LinearRgb)
                            && raw.white_level <= 255);
                let pair = if fallback {
                    raw_core::stages::white_balance::resolve_wb(&model)
                } else {
                    let frame = raw_core::stages::wb_camera::SliderFrame::resolve(&raw, &profile);
                    raw_core::stages::wb_camera::resolve_target_versioned(
                        &model,
                        &frame,
                        &profile,
                        raw.as_shot_neutral,
                    )
                };
                Ok(pair)
            })
        });
        match resolved {
            Ok((temperature, tint)) if temperature.is_finite() && tint.is_finite() => {
                *worker_result.lock().expect("Imported WB result lock") = Some([temperature, tint]);
                0
            }
            Ok(_) => {
                set_last_error("Imported WB: non-finite target".into());
                3
            }
            Err(error) => {
                set_last_error(format!("Imported WB: {error}"));
                3
            }
        }
    });
    if rc == 0 {
        let pair = result
            .lock()
            .expect("Imported WB result lock")
            .expect("worker result");
        unsafe {
            out.write(pair[0]);
            out.add(1).write(pair[1]);
        }
    }
    rc
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_bad_inputs_without_mutating_the_output() {
        let path = std::ffi::CString::new("/missing-maple-import.dng").unwrap();
        let xml = std::ffi::CString::new("<rdf:Description/>").unwrap();
        let mut output = [123.0; 2];
        assert_eq!(
            unsafe {
                maple_resolve_imported_white_balance_file(
                    path.as_ptr(),
                    std::ptr::null(),
                    output.as_mut_ptr(),
                )
            },
            1
        );
        assert_eq!(
            unsafe {
                maple_resolve_imported_white_balance_file(
                    path.as_ptr(),
                    xml.as_ptr(),
                    output.as_mut_ptr(),
                )
            },
            3
        );
        assert_eq!(output, [123.0; 2]);
    }

    #[test]
    fn frameless_partial_imports_use_existing_post_dcp_resolution_for_every_scale() {
        for version in 1..=5 {
            for axis in [
                "crs:Temperature=\"8500\"",
                "crs:Tint=\"40\"",
                "crs:Temperature=\"6500\"",
                "crs:Tint=\"0\"",
            ] {
                let xml = format!("<rdf:Description xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\" xmlns:crs=\"http://ns.adobe.com/camera-raw-settings/1.0/\" xmlns:papp=\"http://ns.justmaple.app/photo/1.0/\" crs:WhiteBalance=\"Custom\" {axis} papp:WbScaleVersion=\"{version}\"/>");
                let model = raw_core::xmp::parse(&xml).unwrap();
                let expected = raw_core::stages::white_balance::resolve_wb(&model);
                let text = std::ffi::CString::new(xml).unwrap();
                let mut output = [123.0; 2];
                assert_eq!(
                    unsafe {
                        maple_resolve_imported_white_balance_file(
                            std::ptr::null(),
                            text.as_ptr(),
                            output.as_mut_ptr(),
                        )
                    },
                    0
                );
                assert_eq!(output, [expected.0, expected.1], "V{version} {axis}");
            }
        }
    }

    #[test]
    fn rejects_non_utf8_and_invalid_xmp_without_publishing_partial_output() {
        let invalid_utf8 = [0xffu8, 0];
        let mut output = [123.0; 2];
        assert_eq!(
            unsafe {
                maple_resolve_imported_white_balance_file(
                    std::ptr::null(),
                    invalid_utf8.as_ptr().cast(),
                    output.as_mut_ptr(),
                )
            },
            2
        );
        let invalid = std::ffi::CString::new("<rdf:Description crs:Tint=\"NaN\"/>").unwrap();
        assert_eq!(
            unsafe {
                maple_resolve_imported_white_balance_file(
                    std::ptr::null(),
                    invalid.as_ptr(),
                    output.as_mut_ptr(),
                )
            },
            3
        );
        assert_eq!(output, [123.0; 2]);
        assert_eq!(
            unsafe {
                maple_resolve_imported_white_balance_file(
                    std::ptr::null(),
                    invalid.as_ptr(),
                    std::ptr::null_mut(),
                )
            },
            1
        );
    }

    #[test]
    fn agrees_exactly_with_full_develop_resolution_on_calibrated_nonzero_tint_fixtures() {
        for name in ["source.dng", "target.dng"] {
            let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../../test-fixtures/batch-transfer")
                .join(name);
            let raw = raw_core::decode::decode(&path).unwrap();
            let profile = raw_core::color::dcp::profile_for(&raw).unwrap();
            let frame = raw_core::stages::wb_camera::SliderFrame::resolve(&raw, &profile);
            assert!(
                crate::scene_linear_f32::wb_frame_export(&raw)
                    .as_shot_tint
                    .abs()
                    > 0.5
            );
            let c_path = std::ffi::CString::new(path.to_str().unwrap()).unwrap();
            for version in 1..=5 {
                for axis in [
                    "crs:Temperature=\"8500\"",
                    "crs:Tint=\"40\"",
                    "crs:Temperature=\"6500\"",
                    "crs:Tint=\"0\"",
                ] {
                    let xml = format!("<rdf:Description xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\" xmlns:crs=\"http://ns.adobe.com/camera-raw-settings/1.0/\" xmlns:papp=\"http://ns.justmaple.app/photo/1.0/\" crs:WhiteBalance=\"Custom\" {axis} papp:WbScaleVersion=\"{version}\"/>");
                    let model = raw_core::xmp::parse(&xml).unwrap();
                    let expected = raw_core::stages::wb_camera::resolve_target_versioned(
                        &model,
                        &frame,
                        &profile,
                        raw.as_shot_neutral,
                    );
                    let c_xml = std::ffi::CString::new(xml).unwrap();
                    let mut actual = [0.0; 2];
                    assert_eq!(
                        unsafe {
                            maple_resolve_imported_white_balance_file(
                                c_path.as_ptr(),
                                c_xml.as_ptr(),
                                actual.as_mut_ptr(),
                            )
                        },
                        0
                    );
                    assert_eq!(actual, [expected.0, expected.1], "{name} V{version} {axis}");
                }
            }
        }
    }
}
