//! `renderFilenameTemplate` / `validateFilename` napi bindings (#3509).
//! Thin wrappers over `raw_core::filename`, mirroring
//! `raw-ffi/src/filename.rs`'s `maple_render_filename_template_buf` /
//! `maple_validate_filename` C-ABI functions but returning native JS
//! objects instead of caller-owned output buffers.
//!
//! Both functions are plain synchronous `#[napi]` functions, NOT
//! `Task`/`AsyncTask`-wrapped: `raw_core::filename::render_filename` /
//! `validate_filename` are pure string operations with no I/O and no
//! meaningful CPU cost (same reasoning `#3508`'s plan already applied when it
//! kept `renderFilenameTemplate`/`validateFilename` synchronous there too).
//!
//! Error shape matches `src/maple/src/types.ts`'s `FilenameResult` /
//! `validateFilename` return type exactly — `{ ok: false, code, error }` with
//! the SAME numeric `code` the `bun:ffi` backend already returns for the
//! same rejection reason (see `error::filename_error_code`), so a caller
//! going through `callNative(...)` sees an identical shape from either
//! backend.

use napi::bindgen_prelude::*;
use napi_derive::napi;
use raw_core::filename::{self, RenderInputs, SequenceOptions};

use crate::error::filename_error_code;

/// Mirrors `src/maple/src/types.ts`'s `FilenameTemplateArgs`. Field names are
/// `snake_case` here and camelCase on the JS side (napi-derive's default
/// `#[napi(object)]` casing) — `original_stem` -> `originalStem`,
/// `captured_at` -> `capturedAt`, `sequence_start` -> `sequenceStart`,
/// `sequence_index` -> `sequenceIndex`, `sequence_pad_width` ->
/// `sequencePadWidth`, matching that interface's field names exactly.
///
/// `sequence_start`/`sequence_index`/`sequence_pad_width` are `i64` rather
/// than `raw_core`'s `u64`/`usize`: napi's JS-number bridge (`napi_get_value_
/// int64`/`napi_create_int64`) only implements `FromNapiValue` for signed
/// integers up to `i64` — `u64`/`usize` only implement the outbound half
/// (`ToNapiValue`, surfaced as a JS `BigInt`), so they cannot appear as an
/// inbound `#[napi(object)]` field. `render_filename_template` below rejects
/// a negative value rather than silently reinterpreting its bit pattern.
#[napi(object)]
pub struct FilenameTemplateArgs {
    pub template: String,
    pub original_stem: String,
    pub ext: String,
    pub captured_at: Option<String>,
    pub sequence_start: i64,
    pub sequence_index: i64,
    pub sequence_pad_width: i64,
}

/// Mirrors `src/maple/src/types.ts`'s `FilenameResult`:
/// `{ ok: true; name: string } | { ok: false; code: number; error: string }`.
/// `name`/`code`/`error` are modelled as `Option` (rather than a real Rust
/// enum, which `#[napi(object)]` cannot derive a tagged union for) — exactly
/// one of `name` or `code`+`error` is populated, matching which half of the
/// TS union a given result stands for.
#[napi(object)]
pub struct FilenameResult {
    pub ok: bool,
    pub name: Option<String>,
    pub code: Option<i32>,
    pub error: Option<String>,
}

/// Render one filename from a batch-rename template — see
/// `raw_core::filename::render_filename` for the token/validation rules this
/// wraps unchanged. Ports `raw-ffi/src/filename.rs`'s
/// `maple_render_filename_template_buf` (line 214), minus its caller-owned
/// output-buffer marshalling: napi's `String` return already avoids the
/// C-ABI's "does it fit in `out_cap`" dance, so there is no code-9 sizing
/// failure to reproduce here.
///
/// Returns `Err` (rejecting the JS `Promise` — well, throwing, since this is
/// a synchronous function) only for a malformed argument the JS binding
/// layer itself should never produce (a negative sequence value); every
/// engine-level rejection (unknown token, reserved name, …) comes back as
/// `Ok(FilenameResult { ok: false, .. })`, matching `validateFilename`/every
/// other `NativeBinding` method's "expected failure is a value, not a
/// throw" convention.
#[napi]
pub fn render_filename_template(args: FilenameTemplateArgs) -> Result<FilenameResult> {
    let sequence_start: u64 = args.sequence_start.try_into().map_err(|_| {
        Error::new(
            Status::InvalidArg,
            "sequence_start must be a non-negative integer".to_string(),
        )
    })?;
    let sequence_index: u64 = args.sequence_index.try_into().map_err(|_| {
        Error::new(
            Status::InvalidArg,
            "sequence_index must be a non-negative integer".to_string(),
        )
    })?;
    let sequence_pad_width: usize = args.sequence_pad_width.try_into().map_err(|_| {
        Error::new(
            Status::InvalidArg,
            "sequence_pad_width must be a non-negative integer".to_string(),
        )
    })?;

    let inputs = RenderInputs {
        original_stem: &args.original_stem,
        ext: &args.ext,
        index: sequence_index,
        captured_at: args.captured_at.as_deref(),
    };
    let sequence = SequenceOptions {
        start: sequence_start,
        pad_width: sequence_pad_width,
    };

    Ok(
        match filename::render_filename(&args.template, &inputs, &sequence) {
            Ok(name) => FilenameResult {
                ok: true,
                name: Some(name),
                code: None,
                error: None,
            },
            Err(e) => FilenameResult {
                ok: false,
                name: None,
                code: Some(filename_error_code(&e)),
                error: Some(e.to_string()),
            },
        },
    )
}

/// Mirrors `src/maple/src/types.ts`'s `validateFilename` return type:
/// `{ ok: true } | { ok: false; code: number; error: string }`.
#[napi(object)]
pub struct ValidateFilenameResult {
    pub ok: bool,
    pub code: Option<i32>,
    pub error: Option<String>,
}

/// Validate a filename directly (no template) — the same rules
/// [`render_filename_template`] enforces on its rendered output. Ports
/// `raw-ffi/src/filename.rs`'s `maple_validate_filename` (line 313).
#[napi]
pub fn validate_filename(name: String) -> ValidateFilenameResult {
    match filename::validate_filename(&name) {
        Ok(()) => ValidateFilenameResult {
            ok: true,
            code: None,
            error: None,
        },
        Err(e) => ValidateFilenameResult {
            ok: false,
            code: Some(filename_error_code(&e)),
            error: Some(e.to_string()),
        },
    }
}
