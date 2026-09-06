//! Recipe render binding. The job ledger owns final naming and atomic publication.
use crate::error::{set_last_error, with_large_stack};
use raw_core::{
    export_recipe::{export_with_recipe, ExportRecipe},
    pipeline::RawInput,
};
use std::{
    ffi::{c_char, CStr},
    io::Write,
    path::Path,
};

unsafe fn text(ptr: *const c_char) -> Result<String, String> {
    if ptr.is_null() {
        return Err("missing export argument".into());
    }
    CStr::from_ptr(ptr)
        .to_str()
        .map(str::to_owned)
        .map_err(|e| e.to_string())
}

/// Render a source under immutable XMP and a validated recipe to an exclusively
/// created staging file. The caller owns cleanup and final publication.
/// # Safety
/// Each non-null pointer must be a valid NUL-terminated UTF-8 string for this call.
#[no_mangle]
pub unsafe extern "C" fn maple_export_recipe_to_file(
    raw_path: *const c_char,
    xmp_xml: *const c_char,
    recipe_json: *const c_char,
    film_path: *const c_char,
    out_path: *const c_char,
) -> i32 {
    let inputs = (|| -> Result<_, String> {
        Ok((
            text(raw_path)?,
            text(xmp_xml)?,
            text(recipe_json)?,
            if film_path.is_null() {
                None
            } else {
                Some(text(film_path)?)
            },
            text(out_path)?,
        ))
    })();
    let (source, xml, json, film_path, output) = match inputs {
        Ok(values) => values,
        Err(e) => {
            set_last_error(e);
            return 1;
        }
    };
    with_large_stack(move || {
        let result = (|| -> Result<(), String> {
            let recipe = ExportRecipe::parse(&json)?;
            recipe.validate()?;
            let model = if xml.is_empty() {
                raw_core::AdjustmentModel::default()
            } else {
                raw_core::xmp::parse(&xml).map_err(|e| e.to_string())?
            };
            let film = if model.film_look.is_empty() {
                None
            } else {
                if !model
                    .film_look
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
                {
                    return Err("invalid film LUT id".into());
                }
                let directory = film_path
                    .as_deref()
                    .ok_or("film LUT directory unavailable")?;
                let path = Path::new(directory).join(format!("{}.mlut", model.film_look));
                Some(
                    raw_core::film::decode_mlut(
                        &std::fs::read(&path)
                            .map_err(|e| format!("film LUT {}: {e}", path.display()))?,
                    )
                    .map_err(|e| e.to_string())?,
                )
            };
            let bytes = std::fs::read(&source).map_err(|e| format!("original read: {e}"))?;
            let ext = Path::new(&source)
                .extension()
                .and_then(|s| s.to_str())
                .unwrap_or("");
            let raw =
                raw_core::decode::decode_bytes(&bytes, ext).map_err(|e| format!("decode: {e}"))?;
            let exported = export_with_recipe(
                &raw,
                &model,
                Some(RawInput::Bytes { bytes: &bytes, ext }),
                &recipe,
                film.as_ref(),
            )?;
            let mut file = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(output)
                .map_err(|e| format!("create export staging file: {e}"))?;
            file.write_all(&exported.bytes)
                .and_then(|()| file.sync_all())
                .map_err(|e| format!("write export staging file: {e}"))?;
            Ok(())
        })();
        match result {
            Ok(()) => 0,
            Err(error) => {
                set_last_error(error);
                1
            }
        }
    })
}

/// Validate every required recipe field and supported execution capability without decoding.
/// Returns 0 on success, 1 on failure with same-thread `maple_last_error`.
/// # Safety
/// `recipe_json` must point to a NUL-terminated UTF-8 string, or be null (rejected).
#[no_mangle]
pub unsafe extern "C" fn maple_validate_export_recipe(recipe_json: *const c_char) -> i32 {
    let result = text(recipe_json)
        .and_then(|json| ExportRecipe::parse(&json))
        .and_then(|recipe| recipe.validate());
    match result {
        Ok(()) => 0,
        Err(error) => {
            set_last_error(error);
            1
        }
    }
}

/// Render the validated recipe's output name using the shared format extension and sequence.
/// Output is UTF-8, not NUL terminated. Returns 0 on success, 1 with last-error on failure.
/// # Safety
/// String pointers must be valid NUL-terminated UTF-8. `captured_at` may be null.
/// `out_buf` must address `out_cap` writable bytes and `out_len` a writable usize.
#[no_mangle]
pub unsafe extern "C" fn maple_export_recipe_filename_buf(
    recipe_json: *const c_char,
    original_stem: *const c_char,
    captured_at: *const c_char,
    sequence_index: u64,
    out_buf: *mut u8,
    out_cap: usize,
    out_len: *mut usize,
) -> i32 {
    if out_len.is_null() || out_buf.is_null() {
        set_last_error("missing filename output buffer".into());
        return 1;
    }
    *out_len = 0;
    let result = (|| -> Result<(), String> {
        let recipe = ExportRecipe::parse(&text(recipe_json)?)?;
        recipe.validate()?;
        let stem = text(original_stem)?;
        let date = if captured_at.is_null() {
            None
        } else {
            Some(text(captured_at)?)
        };
        let name = recipe.filename(&stem, date.as_deref(), sequence_index)?;
        if name.len() > out_cap {
            return Err("filename output buffer is too small".into());
        }
        std::ptr::copy_nonoverlapping(name.as_ptr(), out_buf, name.len());
        *out_len = name.len();
        Ok(())
    })();
    match result {
        Ok(()) => 0,
        Err(error) => {
            set_last_error(error);
            1
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::CString;
    #[test]
    fn preflight_rejects_unsupported_choices_and_nulls_without_rendering() {
        let json = CString::new(serde_json::to_string(&ExportRecipe::default()).unwrap()).unwrap();
        unsafe {
            assert_eq!(maple_validate_export_recipe(json.as_ptr()), 0);
            assert_eq!(maple_validate_export_recipe(std::ptr::null()), 1);
        }
        let unsupported = CString::new(json.to_str().unwrap().replace("jpeg", "heic")).unwrap();
        unsafe {
            assert_eq!(maple_validate_export_recipe(unsupported.as_ptr()), 1);
        }
    }
    #[test]
    fn filename_buffer_uses_recipe_extension_and_stable_index_without_truncation() {
        let mut recipe = ExportRecipe::default();
        recipe.naming_template = "{original}_{n}.{ext}".into();
        let json = CString::new(serde_json::to_string(&recipe).unwrap()).unwrap();
        let stem = CString::new("sample").unwrap();
        let mut bytes = [0u8; 64];
        let mut len = 999;
        unsafe {
            assert_eq!(
                maple_export_recipe_filename_buf(
                    json.as_ptr(),
                    stem.as_ptr(),
                    std::ptr::null(),
                    7,
                    bytes.as_mut_ptr(),
                    bytes.len(),
                    &mut len
                ),
                0
            );
            assert_eq!(&bytes[..len], b"sample_8.jpg");
            assert_eq!(
                maple_export_recipe_filename_buf(
                    json.as_ptr(),
                    stem.as_ptr(),
                    std::ptr::null(),
                    7,
                    bytes.as_mut_ptr(),
                    3,
                    &mut len
                ),
                1
            );
            assert_eq!(len, 0);
        }
    }
}
