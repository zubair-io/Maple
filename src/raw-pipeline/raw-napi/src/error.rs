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
//! genuine napi/marshalling-level failure (e.g. a panic surfaced by napi
//! itself), never for an expected "this name/image isn't valid" outcome; see
//! each `Task::compute`'s own doc comment.

use raw_core::filename::FilenameError;

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
