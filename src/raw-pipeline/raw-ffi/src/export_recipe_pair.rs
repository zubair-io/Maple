//! Two recipe renders of one source from a single read and a single sensor
//! decode (#6034). Each staging file holds exactly the bytes
//! `maple_export_recipe_to_file` writes for the same recipe.
use crate::error::{set_last_error, with_large_stack};
use crate::export_recipe::{adjustment_model, film_lut, text, write_staging};
use raw_core::export_recipe::{ExportRecipe, RecipeSource};
use std::{ffi::c_char, path::Path};

const SECOND_FAILED: i32 = 101;

struct Staging {
    recipe_json: String,
    path: String,
}

fn recipe(json: &str) -> Result<ExportRecipe, String> {
    let recipe = ExportRecipe::parse(json)?;
    recipe.validate()?;
    Ok(recipe)
}

fn render_pair(
    source_path: &str,
    xml: &str,
    film_path: Option<&str>,
    first: &Staging,
    second: &Staging,
) -> Result<i32, String> {
    let first_recipe = recipe(&first.recipe_json)?;
    let model = adjustment_model(xml)?;
    let film = film_lut(&model, film_path)?;
    let bytes = std::fs::read(source_path).map_err(|e| format!("original read: {e}"))?;
    let ext = Path::new(source_path)
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("");
    let source = RecipeSource::open(&bytes, ext)?;
    let exported = source.export(&model, &first_recipe, film.as_ref())?;
    write_staging(&first.path, &exported.bytes)?;
    drop(exported);
    // The first file is complete from here on, so nothing the second render
    // does may report it as failed, a panic included.
    let second_result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let exported = source.export(&model, &recipe(&second.recipe_json)?, film.as_ref())?;
        write_staging(&second.path, &exported.bytes)
    }))
    .unwrap_or_else(|_| Err("second recipe render panicked".into()));
    Ok(second_result.map_or_else(
        |error| {
            set_last_error(error);
            SECOND_FAILED
        },
        |()| 0,
    ))
}

/// Render one source under immutable XMP to two exclusively created staging
/// files, `first_*` then `second_*`, reading and decoding the source once.
/// The caller owns cleanup and final publication.
///
/// Returns 0 when both files are written. 101 means the first file is complete
/// and the second is not (`maple_last_error` says why). 1 means the first
/// render failed and the second was not attempted.
///
/// # Safety
/// Each non-null pointer must be a valid NUL-terminated UTF-8 string for this
/// call. Only `film_path` may be null.
#[no_mangle]
pub unsafe extern "C" fn maple_export_recipe_pair_to_files(
    raw_path: *const c_char,
    xmp_xml: *const c_char,
    film_path: *const c_char,
    first_recipe_json: *const c_char,
    first_out_path: *const c_char,
    second_recipe_json: *const c_char,
    second_out_path: *const c_char,
) -> i32 {
    let inputs = (|| -> Result<_, String> {
        Ok((
            text(raw_path)?,
            text(xmp_xml)?,
            if film_path.is_null() {
                None
            } else {
                Some(text(film_path)?)
            },
            Staging {
                recipe_json: text(first_recipe_json)?,
                path: text(first_out_path)?,
            },
            Staging {
                recipe_json: text(second_recipe_json)?,
                path: text(second_out_path)?,
            },
        ))
    })();
    let (source, xml, film_path, first, second) = match inputs {
        Ok(values) => values,
        Err(e) => {
            set_last_error(e);
            return 1;
        }
    };
    with_large_stack(move || {
        render_pair(&source, &xml, film_path.as_deref(), &first, &second).unwrap_or_else(|error| {
            set_last_error(error);
            1
        })
    })
}
