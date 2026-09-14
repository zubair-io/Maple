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
//! Module map (filled in by later tasks in the same plan):
//!   - `filename`   — `renderFilenameTemplate` / `validateFilename`
//!   - `raster`     — probe / decode / resize / render / tensor
//!   - `pipeline`   — the bitmap recipe executor + analyze
//!   - `develop`    — RAW-develop export + thumbnail extraction

#[macro_use]
extern crate napi_derive;

mod error;
mod filename;
#[cfg(test)]
mod filename_tests;

pub use filename::{
    render_filename_template, validate_filename, FilenameResult, FilenameTemplateArgs,
    ValidateFilenameResult,
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
