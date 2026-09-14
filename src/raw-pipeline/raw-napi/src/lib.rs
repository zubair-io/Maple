//! napi-rs 3 binding crate for `@justmaple/maple` (#3509, epic #3495).
//!
//! Exposes the SAME operations `@justmaple/maple`'s `NativeBinding` interface
//! (`src/maple/src/native.ts`) reaches today through `bun:ffi` — not the whole
//! of `raw-core`'s surface that `raw-ffi` serves for Apple/Windows/GPU-live
//! use cases. The point is a second binding technology for the same package,
//! so it runs under plain Node rather than only under Bun.
//!
//! Every operation is CPU-bound, so each is implemented with napi-rs's
//! `Task`/`AsyncTask` pair, which runs the work on N-API's own libuv worker
//! pool — off the JS thread for free, with no Tokio runtime and no JS-level
//! `Worker` thread. (This is why the `napi` dependency deliberately does not
//! enable the `async` feature; see the manifest.)
//!
//! Module map:
//!   - `filename` — `renderFilenameTemplate` / `validateFilename`
//!   - `raster_probe` — header probe / native-size RGB8 decode
//!   - `raster_render` — the v2 render entry points (fit/filter/format/effort)
//!   - `raster_resize` — the Tier-1 resize-to-file/-buf + tensor extraction
//!   - `pipeline` — the bitmap recipe executor + analyze
//!   - `develop_common` — shared big-stack-decode / XMP-load / atomic-write
//!     helpers for the two `develop_*` modules below
//!   - `develop_export` — RAW-develop export: `exportDevelopedToFile` /
//!     `exportRecipeToFile`
//!   - `develop_preview` — thumbnail extraction + RAW-develop preview:
//!     `renderThumbnailAvifToFile` / `renderThumbnailPreviewJpegToFile` /
//!     `renderDevelopJpegToFile`

#[macro_use]
extern crate napi_derive;

mod develop_common;
mod develop_export;
mod develop_preview;
#[cfg(test)]
mod develop_tests;
mod error;
mod filename;
#[cfg(test)]
mod filename_tests;
mod pipeline;
#[cfg(test)]
mod pipeline_tests;
mod raster_probe;
#[cfg(test)]
mod raster_probe_tests;
mod raster_render;
#[cfg(test)]
mod raster_render_tests;
mod raster_resize;

pub use develop_export::{export_developed_to_file, export_recipe_to_file};
pub use develop_preview::{
    render_develop_jpeg_to_file, render_thumbnail_avif_to_file,
    render_thumbnail_preview_jpeg_to_file,
};
pub use filename::{
    render_filename_template, validate_filename, FilenameResult, FilenameTemplateArgs,
    ValidateFilenameResult,
};
pub use pipeline::{
    raster_analyze_buf, raster_pipeline_buf, RasterAnalyzeResult, RasterPipelineResult,
};
pub use raster_probe::{
    raster_decode_rgb8_buf, raster_probe_metadata, raster_probe_metadata_buf, RasterDecodeResult,
    RasterMetadata, RasterProbeResult,
};
pub use raster_render::{raster_from_raw_render_buf, raster_render_buf, RasterBufResult};
pub use raster_resize::{
    raster_extract_tensor, raster_resize_to_buf, raster_resize_to_file, RasterFileResult,
    RasterTensorResult,
};

/// Smoke-test export: proves the crate builds into a loadable addon and that a
/// trivial `#[napi]` function round-trips through a host's N-API loader.
///
/// It reads `raw_core::PIPELINE_OUTPUT_VERSION` on purpose rather than
/// returning a bare literal — that is what makes the heavy `raw-core` graph
/// (rawler, rav1d, ravif, zune-jpeg, fast_image_resize) genuinely part of the
/// addon's link, so this one call is a real end-to-end toolchain proof and not
/// just a proof that `napi-derive` expands.
///
/// JS name is `mapleNapiVersion` — napi-derive lower-camel-cases `snake_case`
/// Rust function names by default; no `js_name` override is in play.
#[napi]
pub fn maple_napi_version() -> String {
    format!(
        "{} (raw-core pipeline output v{})",
        env!("CARGO_PKG_VERSION"),
        raw_core::PIPELINE_OUTPUT_VERSION
    )
}
