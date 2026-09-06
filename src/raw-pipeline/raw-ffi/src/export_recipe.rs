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
    unsafe fn text(ptr: *const c_char) -> Result<String, String> {
        if ptr.is_null() {
            return Err("missing export argument".into());
        }
        CStr::from_ptr(ptr)
            .to_str()
            .map(str::to_owned)
            .map_err(|e| e.to_string())
    }
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
