//! Read-only gesture mapping on a retained native RAW (#3934).
use crate::{
    error::{catch_panic_rc, set_last_error},
    handle::{MapleRawHandle, MapleRawHandleInner},
    model::{load_xmp_model_from_doc, LoadModel},
};
use std::ffi::{c_char, CStr};

/// Batched oriented post-perspective, PRE-user-crop points -> native pre-lens
/// DefaultCrop points. Request {schema:1,points:[[u,v],...]}; response contains
/// source_size and ordered nullable points. Null must break a gesture, never
/// become edge paint. Hosts undo their actual viewport/crop presentation first.
/// Codes: 0 success, 1 null, 5 invalid, 99 panic, 100 capacity probe.
/// No RAW decode, image allocation, inference or filesystem access.
/// # Safety
/// handle remains live; xmp/request are valid UTF-8 C strings; length is
/// writable. Non-null output is writable for cap bytes, all buffers disjoint.
#[no_mangle]
pub unsafe extern "C" fn maple_removal_map_points_buf(
    handle: *const MapleRawHandle,
    xmp: *const c_char,
    request: *const c_char,
    output: *mut u8,
    cap: usize,
    length: *mut usize,
) -> i32 {
    catch_panic_rc("maple_removal_map_points_buf", || {
        if length.is_null() {
            return 1;
        }
        *length = 0;
        if handle.is_null() || xmp.is_null() || request.is_null() {
            return 1;
        }
        if cap > isize::MAX as usize {
            return 5;
        }
        let Some(inner) = ((*handle).inner as *const MapleRawHandleInner).as_ref() else {
            return 1;
        };
        let result = (|| {
            let xmp = CStr::from_ptr(xmp).to_str().map_err(|e| e.to_string())?;
            let request = CStr::from_ptr(request)
                .to_str()
                .map_err(|e| e.to_string())?;
            let model = match load_xmp_model_from_doc(Some(xmp)) {
                LoadModel::Ok(model) => model,
                LoadModel::Err(code) => {
                    return Err(format!("removal geometry XMP invalid ({code})"))
                }
            };
            raw_core::pipeline::map_removal_display_points(&inner.raw, &model, request)
        })();
        let data = match result {
            Ok(data) => data,
            Err(e) => {
                set_last_error(e);
                return 5;
            }
        };
        *length = data.len();
        if output.is_null() || cap < data.len() {
            return 100;
        }
        std::ptr::copy_nonoverlapping(data.as_ptr(), output, data.len());
        0
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::handle::{maple_close_raw_handle, maple_open_raw_handle_bytes};
    use std::ffi::CString;
    #[test]
    fn real_retained_geometry_matches_core_and_preserves_short_or_invalid_outputs() {
        let raw = include_bytes!("../../../../test-fixtures/removal/basic/source.dng");
        let ext = CString::new("dng").unwrap();
        let xmp=CString::new(r#"<rdf:Description xmlns:rdf="x" xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/" crs:PerspectiveX="100"/>"#).unwrap();
        let request =
            CString::new(r#"{"schema":1,"points":[[0.0,0.5],[0.8,0.5],[1.1,0.5]]}"#).unwrap();
        let mut handle = std::ptr::null_mut();
        unsafe {
            assert_eq!(
                maple_open_raw_handle_bytes(
                    raw.as_ptr(),
                    raw.len(),
                    ext.as_ptr(),
                    std::ptr::null(),
                    &mut handle
                ),
                0
            );
            let mut length = 0;
            assert_eq!(
                maple_removal_map_points_buf(
                    handle,
                    xmp.as_ptr(),
                    request.as_ptr(),
                    std::ptr::null_mut(),
                    0,
                    &mut length
                ),
                100
            );
            let mut output = vec![42; length];
            let cap = output.len();
            assert_eq!(
                maple_removal_map_points_buf(
                    handle,
                    xmp.as_ptr(),
                    request.as_ptr(),
                    output.as_mut_ptr(),
                    cap - 1,
                    &mut length
                ),
                100
            );
            assert!(output.iter().all(|v| *v == 42));
            assert_eq!(
                maple_removal_map_points_buf(
                    handle,
                    xmp.as_ptr(),
                    request.as_ptr(),
                    output.as_mut_ptr(),
                    cap,
                    &mut length
                ),
                0
            );
            let source = raw_core::decode_raw(raw, "dng").unwrap();
            let model = raw_core::xmp::parse(xmp.to_str().unwrap()).unwrap();
            let expected = raw_core::pipeline::map_removal_display_points(
                &source,
                &model,
                request.to_str().unwrap(),
            )
            .unwrap();
            assert_eq!(output, expected.as_bytes());
            let result: serde_json::Value = serde_json::from_slice(&output).unwrap();
            assert!(result["points"][0].is_null());
            let invalid = CString::new(r#"{"schema":2,"points":[]}"#).unwrap();
            output.fill(42);
            assert_eq!(
                maple_removal_map_points_buf(
                    handle,
                    xmp.as_ptr(),
                    invalid.as_ptr(),
                    output.as_mut_ptr(),
                    cap,
                    &mut length
                ),
                5
            );
            assert_eq!(length, 0);
            assert!(output.iter().all(|v| *v == 42));
            assert_eq!(
                maple_removal_map_points_buf(
                    std::ptr::null(),
                    xmp.as_ptr(),
                    request.as_ptr(),
                    output.as_mut_ptr(),
                    cap,
                    &mut length
                ),
                1
            );
            assert_eq!(length, 0);
            maple_close_raw_handle(handle);
        }
    }
}
