//! Shared error-conversion helpers for `raw-napi`'s `#[napi]` bindings
//! (#3509).
//!
//! Every JS-visible failure this crate's bindings can produce is reported as
//! a plain `{ ok: false, error }` object (optionally with a numeric `code`)
//! rather than a rejected `Promise` / thrown `Error` — matching the shapes
//! `@justmaple/maple`'s `NativeBinding` interface (`src/maple/src/native.ts`,
//! `src/maple/src/types.ts`) already returns from the `bun:ffi` backend. A
//! caller going through `callNative(...)` must see an identical shape
//! regardless of which backend (bun:ffi or this napi addon) answered it, so
//! [`filename_error_code`] deliberately duplicates
//! `raw-ffi/src/filename.rs`'s numeric `error_code` mapping rather than
//! inventing a different one — those numbers are part of the wire contract
//! `src/maple/src/types.ts`'s `FilenameResult`/`validateFilename` return
//! types already commit to, not a detail internal to raw-ffi's C ABI.
//!
//! A real `Err(napi::Error)` — which DOES reject the JS `Promise` for the
//! `Task`/`AsyncTask`-based bindings in `raster_probe.rs` — is reserved for a
//! genuine napi/marshalling-level failure, never for an expected "this
//! name/image isn't valid" outcome; see each `Task::compute`'s own doc
//! comment.
//!
//! napi does NOT catch panics in `Task::compute`: its libuv `execute`
//! callback (`napi/src/async_work.rs`) calls `compute()` from inside an
//! `extern "C" fn` with no `catch_unwind`, so a decoder panic unwinding out of
//! it aborts the whole Node/Bun process (#4733). Every `compute` body
//! therefore runs inside [`guarded_compute`], which turns a panic into the
//! same `{ ok: false, error }` value an ordinary failure produces.

use std::panic::{catch_unwind, AssertUnwindSafe};

use raw_core::filename::FilenameError;

use crate::pipeline::{RasterAnalyzeResult, RasterPipelineResult};
use crate::raster_probe::{RasterDecodeResult, RasterProbeResult};
use crate::raster_render::RasterBufResult;
use crate::raster_resize::{RasterFileResult, RasterTensorResult};

/// Stable numeric error code for a filename-engine rejection.
///
/// Matches `raw-ffi/src/filename.rs`'s `error_code()` function exactly
/// (identical variant-to-number mapping, same order as
/// `FilenameError::kind()`'s declaration) — this is the `code` value
/// `src/maple/src/types.ts`'s `FilenameResult` and `validateFilename` return
/// type already document, and what `native.ts`'s `bun:ffi` backend already
/// returns for the same rejection reason. Codes 1-2 and 8 are template/
/// sequence-only and unreachable from [`crate::filename::validate_filename`]
/// (no template, no sequence there); codes 3-7 are reachable from both
/// entries.
pub fn filename_error_code(e: &FilenameError) -> i32 {
    match e {
        FilenameError::UnterminatedToken { .. } => 1,
        FilenameError::UnknownToken(_) => 2,
        FilenameError::Empty => 3,
        FilenameError::PathSeparator(_) => 4,
        FilenameError::LeadingDot(_) => 5,
        FilenameError::TrailingDotOrSpace(_) => 6,
        FilenameError::ReservedName(_) => 7,
        FilenameError::SequencePadWidthTooLarge { .. } => 8,
    }
}

/// Render a `context: cause` message string for the plain `{ ok: false,
/// error }` shape every non-filename `NativeBinding` method uses
/// (`rasterProbeMetadata`, `rasterProbeMetadataBuf`, `rasterDecodeRgb8Buf`,
/// …) — those methods carry no numeric `code` field on the TypeScript side,
/// only `error`, matching `raw-ffi`'s own `set_last_error(format!("{ctx}:
/// {e}"))` convention (`raw-ffi/src/raster.rs`, `raster_v2.rs`) rather than a
/// bare `e.to_string()`, so the message text a caller sees names which
/// operation failed.
pub fn error_message<E: std::fmt::Display>(context: &str, e: E) -> String {
    format!("{context}: {e}")
}

/// A `Task::Output` that can express "this operation panicked" as its own
/// `{ ok: false, error }` value.
pub(crate) trait PanicResult {
    fn panicked(error: String) -> Self;
}

/// Panic barrier for a `Task::compute` body (#4733). `AssertUnwindSafe` is
/// sound: on the panic path the task's captures are never read again — napi
/// only hands the returned value to `resolve`, then drops the task.
pub(crate) fn guarded_compute<T, F>(task: &str, body: F) -> napi::Result<T>
where
    T: PanicResult,
    F: FnOnce() -> napi::Result<T>,
{
    catch_unwind(AssertUnwindSafe(body)).unwrap_or_else(|payload| {
        let cause = payload
            .downcast_ref::<&str>()
            .map(|s| (*s).to_string())
            .or_else(|| payload.downcast_ref::<String>().cloned())
            .unwrap_or_else(|| "unknown panic payload".to_string());
        Ok(T::panicked(error_message(
            &format!("{task} panicked"),
            cause,
        )))
    })
}

impl PanicResult for RasterFileResult {
    fn panicked(error: String) -> Self {
        Self {
            ok: false,
            error: Some(error),
        }
    }
}

impl PanicResult for RasterBufResult {
    fn panicked(error: String) -> Self {
        Self {
            ok: false,
            buffer: None,
            error: Some(error),
        }
    }
}

impl PanicResult for RasterTensorResult {
    fn panicked(error: String) -> Self {
        Self {
            ok: false,
            tensor: None,
            error: Some(error),
        }
    }
}

impl PanicResult for RasterProbeResult {
    fn panicked(error: String) -> Self {
        Self {
            ok: false,
            metadata: None,
            error: Some(error),
        }
    }
}

impl PanicResult for RasterDecodeResult {
    fn panicked(error: String) -> Self {
        Self {
            ok: false,
            buffer: None,
            width: None,
            height: None,
            error: Some(error),
        }
    }
}

impl PanicResult for RasterPipelineResult {
    fn panicked(error: String) -> Self {
        Self {
            ok: false,
            buffer: None,
            width: None,
            height: None,
            channels: None,
            error: Some(error),
        }
    }
}

impl PanicResult for RasterAnalyzeResult {
    fn panicked(error: String) -> Self {
        Self {
            ok: false,
            json: None,
            error: Some(error),
        }
    }
}
