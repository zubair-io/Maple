//! RAW-develop export bindings (#3509 Task 6): `export_developed_to_file` /
//! `export_recipe_to_file`, mirroring `raw-ffi/src/export_file.rs`'s
//! `maple_export_developed_to_file` (line 42) and
//! `raw-ffi/src/export_recipe.rs`'s `maple_export_recipe_to_file` (line 28)
//! — the two RAW-develop C ABI entries with real logic (XMP parsing, film
//! LUT decode, `AdjustmentModel` construction) behind a file-to-file
//! contract: paths + options in, a file written to disk, `{ ok, error? }`
//! out, no buffer marshalling. Split from the sibling thumbnail/develop-
//! preview operations (`develop_preview.rs`) purely to stay inside the
//! repo's file-size budget (`tools/check-file-budget.sh`) — same split
//! rationale as Task 4's `raster_render.rs`/`raster_resize.rs`.
//!
//! Both operations decode the full RAW, so both run on
//! [`crate::develop_common::run_on_large_stack`]'s dedicated big-stack
//! thread — see that module's doc for why.
//!
//! Every JS-visible outcome is `Ok(RasterFileResult { ok: false, error })`,
//! never a rejected `Promise` — matching the `{ ok: boolean; error?: string
//! }` shape `exportDevelopedToFile`/`exportRecipeToFile` already return from
//! the `bun:ffi` backend (`src/maple/src/native.ts`), which
//! `src/maple/src/export.ts`'s `exportImage`/`exportRecipe` wrap.

use napi::bindgen_prelude::*;
use napi_derive::napi;
use raw_core::export::{export_from_raw, ExportFormat, ExportOptions};
use raw_core::export_recipe::{export_with_recipe, ExportRecipe};
use raw_core::pipeline::RawInput;
use raw_core::view::encode::TargetPrimaries;
use raw_core::xmp::AdjustmentModel;
use std::io::Write;
use std::path::Path;

use crate::develop_common::{atomic_write, load_xmp_model, run_on_large_stack};
use crate::raster_resize::RasterFileResult;

// ---------------------------------------------------------------------
// export_developed_to_file — mirrors `export_file.rs`'s
// `maple_export_developed_to_file` (line 42).
// ---------------------------------------------------------------------

/// See [`export_developed_to_file`] for the wire contract. Fields mirror
/// the C ABI's parameter list one-for-one.
pub struct ExportDevelopedToFileTask {
    pub(crate) raw_path: String,
    pub(crate) xmp_path: Option<String>,
    pub(crate) format: String,
    pub(crate) quality: u8,
    pub(crate) color_space: String,
    pub(crate) max_long_edge: u32,
    pub(crate) out_path: String,
}

impl Task for ExportDevelopedToFileTask {
    type Output = RasterFileResult;
    type JsValue = RasterFileResult;

    fn compute(&mut self) -> Result<Self::Output> {
        Ok(match self.run() {
            Ok(()) => RasterFileResult {
                ok: true,
                error: None,
            },
            Err(e) => RasterFileResult {
                ok: false,
                error: Some(e),
            },
        })
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

impl ExportDevelopedToFileTask {
    fn run(&self) -> std::result::Result<(), String> {
        if self.quality > 100 {
            return Err(format!(
                "quality must be in [1, 100] (got {})",
                self.quality
            ));
        }
        let export_format = ExportFormat::from_str(&self.format).ok_or_else(|| {
            format!(
                "unsupported format '{}' (expected jpeg | tiff | png | avif | webp)",
                self.format
            )
        })?;
        let quality = if self.quality == 0 { 92 } else { self.quality };
        let target = if self.color_space == "display-p3" {
            TargetPrimaries::P3
        } else {
            TargetPrimaries::Srgb
        };
        let max_long_edge = (self.max_long_edge > 0).then_some(self.max_long_edge);

        let raw_path = self.raw_path.clone();
        let xmp_path = self.xmp_path.clone();
        let out_path = self.out_path.clone();
        run_on_large_stack(move || {
            let model = load_xmp_model(xmp_path.as_deref())?;
            let path = Path::new(&raw_path);
            let raw_bytes = std::fs::read(path).map_err(|e| format!("raw read: {e}"))?;
            let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
            let raw_img = raw_core::decode::decode_bytes(&raw_bytes, ext)
                .map_err(|e| format!("decode: {e}"))?;
            let options = ExportOptions {
                format: export_format,
                quality,
                target,
                max_long_edge,
            };
            let exported = export_from_raw(
                &raw_img,
                &model,
                Some(RawInput::Bytes {
                    bytes: &raw_bytes,
                    ext,
                }),
                &options,
            )
            .map_err(|e| format!("export: {e}"))?;
            atomic_write(&out_path, &exported.bytes)
        })
    }
}

/// Develop `raw_path` with `xmp_path` applied (`None` = neutral defaults)
/// and encode to `out_path` in the requested deliverable format.
///
/// - `format` — `"jpeg"`, `"tiff"` (16-bit), `"png"`, `"avif"` or `"webp"`
///   (per `ExportFormat::from_str`).
/// - `quality` — JPEG/AVIF quality in `[1, 100]`; `0` selects the canonical
///   dialog default (92). Ignored by the lossless formats.
/// - `color_space` — `"display-p3"` selects Display P3 primaries (and ICC
///   tag); anything else selects sRGB.
/// - `max_long_edge` — long-edge cap in pixels; `0` renders native
///   resolution. Never upscales.
///
/// Always renders at `RenderQuality::Auto` (inside `export_from_raw`) —
/// export favours quality over latency. Resolves the same shape
/// `exportDevelopedToFile` already returns from the `bun:ffi` backend. The
/// parent dir of `out_path` must exist — matches `src/maple/src/export.ts`'s
/// `exportImage`, which `mkdir`s it before calling in.
#[napi]
pub fn export_developed_to_file(
    raw_path: String,
    xmp_path: Option<String>,
    format: String,
    quality: u8,
    color_space: String,
    max_long_edge: u32,
    out_path: String,
) -> AsyncTask<ExportDevelopedToFileTask> {
    AsyncTask::new(ExportDevelopedToFileTask {
        raw_path,
        xmp_path,
        format,
        quality,
        color_space,
        max_long_edge,
        out_path,
    })
}

// ---------------------------------------------------------------------
// export_recipe_to_file — mirrors `export_recipe.rs`'s
// `maple_export_recipe_to_file` (line 28).
// ---------------------------------------------------------------------

/// See [`export_recipe_to_file`] for the wire contract. Fields mirror the
/// C ABI's parameter list one-for-one.
pub struct ExportRecipeToFileTask {
    pub(crate) raw_path: String,
    pub(crate) xmp_xml: String,
    pub(crate) recipe_json: String,
    pub(crate) film_path: Option<String>,
    pub(crate) out_path: String,
}

impl Task for ExportRecipeToFileTask {
    type Output = RasterFileResult;
    type JsValue = RasterFileResult;

    fn compute(&mut self) -> Result<Self::Output> {
        Ok(match self.run() {
            Ok(()) => RasterFileResult {
                ok: true,
                error: None,
            },
            Err(e) => RasterFileResult {
                ok: false,
                error: Some(e),
            },
        })
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

impl ExportRecipeToFileTask {
    fn run(&self) -> std::result::Result<(), String> {
        let raw_path = self.raw_path.clone();
        let xml = self.xmp_xml.clone();
        let recipe_json = self.recipe_json.clone();
        let film_path = self.film_path.clone();
        let out_path = self.out_path.clone();
        run_on_large_stack(move || {
            let recipe = ExportRecipe::parse(&recipe_json)?;
            recipe.validate()?;
            let model = if xml.is_empty() {
                AdjustmentModel::default()
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
            let bytes = std::fs::read(&raw_path).map_err(|e| format!("original read: {e}"))?;
            let ext = Path::new(&raw_path)
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
            // `create_new`, NOT the tmp-then-rename `atomic_write` the other
            // four operations in this crate use: mirrors
            // `export_recipe.rs`'s own contract exactly — `out_path` is an
            // exclusively-created staging file, and the caller (the job
            // ledger on Apple/Windows; on Node, `src/maple/src/export.ts`'s
            // `exportRecipe`, which never does a further rename of its own)
            // owns what happens to it afterward. A pre-existing file at
            // `out_path` is therefore reported as an error rather than
            // silently overwritten.
            let mut file = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&out_path)
                .map_err(|e| format!("create export staging file: {e}"))?;
            file.write_all(&exported.bytes)
                .and_then(|()| file.sync_all())
                .map_err(|e| format!("write export staging file: {e}"))
        })
    }
}

/// Render `raw_path` under `xmp_xml` (immutable, caller-supplied XMP
/// document text — `""` renders the neutral default) and a validated
/// `recipe_json` (schema v1, see `raw_core::export_recipe::ExportRecipe`),
/// optionally resolving a film-look LUT from `film_path` (the directory
/// holding `<look-id>.mlut` files; required only when `model.film_look` is
/// set). Writes the exclusively-created `out_path` — this call fails if a
/// file already exists there. Resolves the same shape
/// `exportRecipeToFile` already returns from the `bun:ffi` backend.
#[napi]
pub fn export_recipe_to_file(
    raw_path: String,
    xmp_xml: String,
    recipe_json: String,
    film_path: Option<String>,
    out_path: String,
) -> AsyncTask<ExportRecipeToFileTask> {
    AsyncTask::new(ExportRecipeToFileTask {
        raw_path,
        xmp_xml,
        recipe_json,
        film_path,
        out_path,
    })
}
