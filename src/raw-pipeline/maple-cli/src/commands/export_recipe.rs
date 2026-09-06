//! Saved recipe execution. File delivery belongs to the shell; originals are read-only.
use raw_core::{
    decode::decode_bytes,
    export_recipe::{export_with_recipe, ExportRecipe},
    pipeline::RawInput,
    xmp,
};
use std::{fs, io::Write, path::Path};

pub fn run(
    raw: &Path,
    recipe_path: &Path,
    params: Option<&Path>,
    film_dir: Option<&Path>,
    index: u64,
) -> Result<i32, Box<dyn std::error::Error>> {
    let recipe = ExportRecipe::parse(&fs::read_to_string(recipe_path)?)?;
    recipe.validate()?;
    if recipe.destination != "directory" {
        return Err("CLI recipes require a directory destination".into());
    }
    let dir = Path::new(recipe.directory.as_deref().ok_or("missing directory")?);
    if !dir.is_absolute() {
        return Err("recipe directory must be absolute".into());
    }
    let model = match params {
        Some(path) => xmp::parse(&fs::read_to_string(path)?)?,
        None => xmp::AdjustmentModel::default(),
    };
    let stem = raw
        .file_stem()
        .and_then(|s| s.to_str())
        .ok_or("input filename is not UTF-8")?;
    let source = fs::canonicalize(raw)?;
    fs::create_dir_all(dir)?;
    let directory = fs::canonicalize(dir)?;
    let bytes = fs::read(&source)?;
    let ext = raw.extension().and_then(|s| s.to_str()).unwrap_or("");
    let captured = raw_core::api::read_exif(&bytes, ext)
        .ok()
        .and_then(|exif| exif.captured_at);
    let output = directory.join(recipe.filename(stem, captured.as_deref(), index)?);
    if output == source || fs::canonicalize(&output).ok().as_ref() == Some(&source) {
        return Err("export destination is the original; choose another directory or name".into());
    }
    if output.exists() {
        match recipe.overwrite_policy.as_str() {
            "skip" => {
                println!("skipped: {}", output.display());
                return Ok(0);
            }
            "error" => {
                return Err(format!(
                    "output already exists: {}; choose skip or replace",
                    output.display()
                )
                .into())
            }
            _ => {}
        }
    }
    let decoded = decode_bytes(&bytes, ext)?;
    let resolved_film_dir = film_dir
        .map(Path::to_path_buf)
        .unwrap_or_else(super::render::default_film_lut_dir);
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
        let path = resolved_film_dir.join(format!("{}.mlut", model.film_look));
        Some(raw_core::film::decode_mlut(
            &fs::read(&path).map_err(|e| format!("film LUT {}: {e}", path.display()))?,
        )?)
    };
    let exported = export_with_recipe(
        &decoded,
        &model,
        Some(RawInput::Bytes { bytes: &bytes, ext }),
        &recipe,
        film.as_ref(),
    )?;
    let mut staging = tempfile::Builder::new()
        .prefix(".maple-export-")
        .suffix(".tmp")
        .tempfile_in(&directory)?;
    staging.write_all(&exported.bytes)?;
    staging.as_file().sync_all()?;
    // Keep the exclusively created file, closing its handle before Windows publication.
    let (file, temp) = staging.keep()?;
    drop(file);
    let result = (|| -> Result<bool, Box<dyn std::error::Error>> {
        if recipe.overwrite_policy == "replace" {
            fs::rename(&temp, &output)?;
        } else {
            match fs::hard_link(&temp, &output) {
                Ok(()) => {}
                Err(e)
                    if e.kind() == std::io::ErrorKind::AlreadyExists
                        && recipe.overwrite_policy == "skip" =>
                {
                    return Ok(false)
                }
                Err(e) => return Err(format!("cannot publish {}: {e}", output.display()).into()),
            }
        }
        Ok(true)
    })();
    let _ = fs::remove_file(&temp);
    if !result? {
        println!("skipped: {}", output.display());
        return Ok(0);
    }
    println!(
        "exported: {} ({}x{}, {} bytes)",
        output.display(),
        exported.width,
        exported.height,
        exported.bytes.len()
    );
    Ok(0)
}
