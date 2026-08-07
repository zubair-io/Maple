//! Filename-template engine FFI (#2628) — `maple_render_filename_template`
//! and `maple_validate_filename`, thin marshalling over `raw_core::filename`.
//! Same C ABI serves both Apple (C-FFI) and Windows (P/Invoke, per the
//! Milestone 23 file-management design doc's "Platform routing" — this is
//! the ONE piece of that epic that IS shared code, precisely because it's
//! pure string logic with no platform dependency). Pure functions — no
//! filesystem access, no worker-thread dispatch needed (unlike the decode
//! entries in `render.rs`, there is no large-stack RAW decode here).

use crate::error::set_last_error;
use raw_core::filename::{self, FilenameError, RenderInputs, SequenceOptions};
use std::ffi::{c_char, CStr};

/// Output of [`maple_render_filename_template`]. On success
/// (`error_code == 0`) `name_ptr`/`name_len` point at a heap-allocated UTF-8
/// buffer (NOT null-terminated) the caller must free via
/// [`maple_free_filename_result`] — same crossing-the-boundary ownership
/// convention as `MapleImageBuffer` (`buffers.rs`). On failure `name_ptr` is
/// null, `name_len` is 0, and `error_code` is one of the codes documented on
/// [`maple_render_filename_template`]; [`crate::error::maple_last_error`]
/// carries the human-readable reason.
#[repr(C)]
pub struct MapleFilenameResult {
    pub name_ptr: *mut u8,
    pub name_len: usize,
    pub error_code: i32,
}

impl MapleFilenameResult {
    fn err(code: i32) -> Self {
        Self {
            name_ptr: std::ptr::null_mut(),
            name_len: 0,
            error_code: code,
        }
    }

    fn ok(name: String) -> Self {
        let boxed = name.into_bytes().into_boxed_slice();
        let len = boxed.len();
        let ptr = Box::into_raw(boxed) as *mut u8;
        Self {
            name_ptr: ptr,
            name_len: len,
            error_code: 0,
        }
    }
}

/// Free a result populated by [`maple_render_filename_template`]. A null
/// `result` pointer, or a result whose `name_ptr` is already null (an error
/// result — nothing was allocated), is a no-op.
#[no_mangle]
pub unsafe extern "C" fn maple_free_filename_result(result: *mut MapleFilenameResult) {
    if result.is_null() {
        return;
    }
    let r = &mut *result;
    if !r.name_ptr.is_null() {
        let slice = std::slice::from_raw_parts_mut(r.name_ptr, r.name_len);
        drop(Box::from_raw(slice as *mut [u8]));
    }
    r.name_ptr = std::ptr::null_mut();
    r.name_len = 0;
}

/// Maps a [`FilenameError`] to the stable positive error code documented on
/// [`maple_render_filename_template`] / [`maple_validate_filename`]. Order
/// matches [`FilenameError::kind`]'s declaration order in `raw-core`.
fn error_code(e: &FilenameError) -> i32 {
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

/// Borrow a `*const c_char` as `&str`. Returns `None` for a null pointer or
/// invalid UTF-8 — callers map that to rc `-1`, matching every other
/// pointer-marshalling entry in this crate (e.g. `id.rs`'s
/// `maple_id_primary`).
unsafe fn cstr_to_str<'a>(ptr: *const c_char) -> Option<&'a str> {
    if ptr.is_null() {
        return None;
    }
    CStr::from_ptr(ptr).to_str().ok()
}

/// Render one filename from a batch-rename template (#2628). Pure function —
/// no filesystem access, no clock read.
///
/// `template_ptr`, `original_stem_ptr`, `ext_ptr` are required, NUL-terminated
/// UTF-8 C strings. `captured_at_ptr` is OPTIONAL (may be null) — EXIF
/// `DateTimeOriginal` verbatim in its `"YYYY:MM:DD HH:MM:SS"` wire format;
/// null, or a string that doesn't parse in that exact shape, renders every
/// `{date:FORMAT}` token as the documented fallback text instead of failing
/// the call. `sequence_start`/`sequence_index`/`sequence_pad_width` feed
/// `{n}` — see `raw_core::filename::SequenceOptions` for the exact contract.
///
/// Returns a [`MapleFilenameResult`] (by value — no allocation for the
/// struct itself, only for its `name_ptr` buffer on success). The caller
/// MUST call [`maple_free_filename_result`] on the result exactly once,
/// whether it succeeded or not (a no-op on the error shape).
///
/// `error_code` values:
///   0   success
///  -1   a required pointer (`template_ptr`, `original_stem_ptr`,
///       `ext_ptr`) was null or not valid UTF-8, OR `captured_at_ptr` was
///       non-null but not valid UTF-8 (a null `captured_at_ptr` is valid —
///       see above)
///   1   template has an unterminated `{`
///   2   template contains an unrecognised `{...}` token
///   3   rendered filename is empty
///   4   rendered filename contains a path separator (`/` or `\`)
///   5   rendered filename starts with a leading dot
///   6   rendered filename ends with a trailing dot or space
///   7   rendered filename is an OS-reserved device name (Windows rules,
///       enforced on every platform — see `raw_core::filename` module doc)
///   8   `sequence_pad_width` exceeds `raw_core::filename::MAX_SEQUENCE_PAD_WIDTH`
///       (32) — rejected outright rather than performing the allocation a
///       caller-controlled width could otherwise force
#[no_mangle]
pub unsafe extern "C" fn maple_render_filename_template(
    template_ptr: *const c_char,
    original_stem_ptr: *const c_char,
    ext_ptr: *const c_char,
    captured_at_ptr: *const c_char,
    sequence_start: u64,
    sequence_index: u64,
    sequence_pad_width: usize,
) -> MapleFilenameResult {
    let Some(template) = cstr_to_str(template_ptr) else {
        set_last_error(
            "maple_render_filename_template: template is null or not valid UTF-8".into(),
        );
        return MapleFilenameResult::err(-1);
    };
    let Some(original_stem) = cstr_to_str(original_stem_ptr) else {
        set_last_error(
            "maple_render_filename_template: original_stem is null or not valid UTF-8".into(),
        );
        return MapleFilenameResult::err(-1);
    };
    let Some(ext) = cstr_to_str(ext_ptr) else {
        set_last_error("maple_render_filename_template: ext is null or not valid UTF-8".into());
        return MapleFilenameResult::err(-1);
    };
    let captured_at = if captured_at_ptr.is_null() {
        None
    } else {
        match cstr_to_str(captured_at_ptr) {
            Some(s) => Some(s),
            None => {
                set_last_error(
                    "maple_render_filename_template: captured_at is not valid UTF-8".into(),
                );
                return MapleFilenameResult::err(-1);
            }
        }
    };

    let inputs = RenderInputs {
        original_stem,
        ext,
        index: sequence_index,
        captured_at,
    };
    let sequence = SequenceOptions {
        start: sequence_start,
        pad_width: sequence_pad_width,
    };

    match filename::render_filename(template, &inputs, &sequence) {
        Ok(name) => MapleFilenameResult::ok(name),
        Err(e) => {
            set_last_error(format!("maple_render_filename_template: {}", e));
            MapleFilenameResult::err(error_code(&e))
        }
    }
}

/// `bun:ffi`-friendly counterpart to [`maple_render_filename_template`].
///
/// `bun:ffi` (the Self Hosted API's FFI consumer, `src/api/src/ffi/raw_ffi.ts`)
/// cannot marshal an arbitrary `#[repr(C)]` struct returned by value — it
/// only auto-converts scalar and `cstring`/`ptr` returns. Rather than change
/// [`maple_render_filename_template`]'s ABI (Apple's Swift binding and
/// Windows' P/Invoke shim both consume the by-value struct natively and have
/// no such limitation), this is an additive, purely mechanical
/// re-marshalling of the identical `raw_core::filename::render_filename`
/// call into the caller-owned-output-buffer shape this crate already uses
/// for `maple_histogram_file` (`render.rs`) — no allocation crosses the FFI
/// boundary, so there is nothing for the caller to free.
///
/// Same required/optional pointer contract as
/// [`maple_render_filename_template`]. `out_buf`/`out_cap` is a caller-owned
/// buffer; on success the rendered UTF-8 bytes (NOT null-terminated) are
/// written to `out_buf` and their length to `*out_len`. On any failure
/// `*out_len` is left untouched.
///
/// Returns the same error codes as [`maple_render_filename_template`], plus:
///   9   rendered filename does not fit in `out_cap` bytes — `*out_len` is
///       NOT written; the caller should retry with a larger buffer (a
///       filename's rendered length is bounded only by its template's
///       literal text plus a `{date:FORMAT}` string, so a generous fixed
///       buffer such as 1024 bytes comfortably covers every real template).
#[no_mangle]
pub unsafe extern "C" fn maple_render_filename_template_buf(
    template_ptr: *const c_char,
    original_stem_ptr: *const c_char,
    ext_ptr: *const c_char,
    captured_at_ptr: *const c_char,
    sequence_start: u64,
    sequence_index: u64,
    sequence_pad_width: usize,
    out_buf: *mut u8,
    out_cap: usize,
    out_len: *mut usize,
) -> i32 {
    let Some(template) = cstr_to_str(template_ptr) else {
        set_last_error(
            "maple_render_filename_template_buf: template is null or not valid UTF-8".into(),
        );
        return -1;
    };
    let Some(original_stem) = cstr_to_str(original_stem_ptr) else {
        set_last_error(
            "maple_render_filename_template_buf: original_stem is null or not valid UTF-8".into(),
        );
        return -1;
    };
    let Some(ext) = cstr_to_str(ext_ptr) else {
        set_last_error("maple_render_filename_template_buf: ext is null or not valid UTF-8".into());
        return -1;
    };
    let captured_at = if captured_at_ptr.is_null() {
        None
    } else {
        match cstr_to_str(captured_at_ptr) {
            Some(s) => Some(s),
            None => {
                set_last_error(
                    "maple_render_filename_template_buf: captured_at is not valid UTF-8".into(),
                );
                return -1;
            }
        }
    };

    let inputs = RenderInputs {
        original_stem,
        ext,
        index: sequence_index,
        captured_at,
    };
    let sequence = SequenceOptions {
        start: sequence_start,
        pad_width: sequence_pad_width,
    };

    match filename::render_filename(template, &inputs, &sequence) {
        Ok(name) => {
            let bytes = name.as_bytes();
            if bytes.len() > out_cap {
                set_last_error(format!(
                    "maple_render_filename_template_buf: rendered name ({} bytes) exceeds out_cap ({} bytes)",
                    bytes.len(),
                    out_cap
                ));
                return 9;
            }
            std::ptr::copy_nonoverlapping(bytes.as_ptr(), out_buf, bytes.len());
            *out_len = bytes.len();
            0
        }
        Err(e) => {
            set_last_error(format!("maple_render_filename_template_buf: {}", e));
            error_code(&e)
        }
    }
}

/// Validate a filename directly — the same rules
/// [`maple_render_filename_template`] enforces on its rendered output, so a
/// manually-typed single-file rename (no template involved) gets identical
/// rejection behaviour. `name_ptr` must be a NUL-terminated UTF-8 C string.
///
/// Returns `0` when valid, `-1` for a null/non-UTF-8 `name_ptr`, or one of
/// error codes 3–7 documented on [`maple_render_filename_template`] (codes 1
/// and 2 are template-parse errors and code 8 is a `SequenceOptions` bound —
/// none of the three can occur here, since there is no template and no
/// sequence to validate). [`crate::error::maple_last_error`] carries the
/// human-readable reason on any non-zero return.
#[no_mangle]
pub unsafe extern "C" fn maple_validate_filename(name_ptr: *const c_char) -> i32 {
    let Some(name) = cstr_to_str(name_ptr) else {
        set_last_error("maple_validate_filename: name is null or not valid UTF-8".into());
        return -1;
    };
    match filename::validate_filename(name) {
        Ok(()) => 0,
        Err(e) => {
            set_last_error(format!("maple_validate_filename: {}", e));
            error_code(&e)
        }
    }
}
