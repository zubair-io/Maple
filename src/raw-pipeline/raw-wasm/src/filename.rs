//! Filename-template engine, exposed to the Angular `maple-common` package
//! via wasm-bindgen (#2628). Thin pass-through: all engine logic (token
//! parsing, `{date:FORMAT}` strftime handling, the missing-date fallback,
//! and the shared cross-platform naming-rule validation) lives in
//! `raw_core::filename`, which carries its own thorough test suite in
//! `raw-core/src/filename/`. This binding's job is only JS-shape
//! marshalling: `Option<String>` for the nullable EXIF date, `u32` in place
//! of `raw_core`'s `usize` for the pad width (wasm-bindgen doesn't support
//! `usize` at the function-signature boundary — same reason every other
//! sizing param in this crate crosses as `u32`, e.g. `compute_profile_lut`'s
//! `n` in `lib.rs`).
//!
//! **Error shape is deliberately NOT this crate's usual `Result<_, JsError>`.**
//! `raw_core::filename::FilenameError::kind()` exists precisely so callers
//! can discriminate a rejection reason (`"reserved_name"`, `"empty"`, …)
//! without parsing a human-readable message — the batch-rename preview UIs
//! and the #2633 cross-surface parity harness both need that. `JsError` only
//! carries a message string, with no slot for an extra property, so
//! `render_filename_template`/`validate_filename` return `Result<_, JsValue>`
//! and [`to_js_error`] builds a genuine `js_sys::Error` (so `instanceof
//! Error`, `.message`, and stack traces all still work) with a `.kind`
//! string property set to the stable tag:
//!
//! ```js
//! try {
//!   renderFilenameTemplate("CON", "x", "dng", null, 0n, 0n, 0);
//! } catch (e) {
//!   e.kind    // "reserved_name"
//!   e.message // `filename "CON" is an OS-reserved device name`
//! }
//! ```
//!
//! No `wasm-bindgen-test` coverage here, matching `id.rs`'s precedent in
//! this same crate: `raw-wasm` has no existing `wasm-bindgen-test`
//! infrastructure, so the `#[cfg(test)] mod tests` below runs as a plain
//! host-target `#[test]` over the success paths (`to_js_error` calls into
//! wasm-bindgen-imported JS constructors that panic outside a real wasm/JS
//! runtime — see `id.rs`'s test module doc for the fuller explanation of why
//! that's not a gap specific to this binding).

use raw_core::filename as core_filename;
use wasm_bindgen::prelude::*;

/// Build a JS `Error` carrying `e`'s human-readable message AND a `.kind`
/// string property set to [`core_filename::FilenameError::kind`]'s stable
/// snake_case tag — see the module doc for why this exists instead of the
/// crate's usual `JsError::new(&e.to_string())`.
fn to_js_error(e: &core_filename::FilenameError) -> JsValue {
    let err = js_sys::Error::new(&e.to_string());
    // `Reflect::set` only fails for a non-extensible/frozen target, which a
    // freshly constructed `js_sys::Error` never is — the `Result` is
    // deliberately dropped rather than unwrapped: if this somehow failed,
    // the caller still gets a normal JS Error with a message, just without
    // `.kind`, which is a strictly better failure mode than panicking the
    // whole WASM module over an error-formatting helper.
    let _ = js_sys::Reflect::set(
        &err,
        &JsValue::from_str("kind"),
        &JsValue::from_str(e.kind()),
    );
    err.into()
}

/// Render one filename from a batch-rename template.
///
/// `template`, `original_stem`, `ext` mirror
/// `raw_core::filename::render_filename`'s inputs directly. `captured_at` is
/// EXIF `DateTimeOriginal` verbatim in its `"YYYY:MM:DD HH:MM:SS"` wire
/// format, or `null`/omitted from JS — either way `None` here, which renders
/// every `{date:FORMAT}` token as the documented fallback text instead of
/// throwing. `sequence_start` and `sequence_index` combine to produce
/// `{n}`'s value (`start + index`); `sequence_pad_width` is `{n}`'s minimum
/// digit width (a floor, not a cap — wider numbers are never truncated) and
/// must not exceed `raw_core::filename::MAX_SEQUENCE_PAD_WIDTH` (32).
///
/// Throws a JS `Error` (see [`to_js_error`] — `instanceof Error` holds, and
/// a `.kind` string property carries the stable rejection-reason tag) when
/// the template fails to parse, `sequence_pad_width` is too large, or the
/// rendered name fails the shared cross-platform naming-rule validation
/// (path separator, leading dot, trailing dot/space, OS-reserved device
/// name, or empty output) — see `raw_core::filename::validate_filename` for
/// the exact rule set.
#[wasm_bindgen]
pub fn render_filename_template(
    template: &str,
    original_stem: &str,
    ext: &str,
    captured_at: Option<String>,
    sequence_start: u64,
    sequence_index: u64,
    sequence_pad_width: u32,
) -> Result<String, JsValue> {
    let inputs = core_filename::RenderInputs {
        original_stem,
        ext,
        index: sequence_index,
        captured_at: captured_at.as_deref(),
    };
    let sequence = core_filename::SequenceOptions {
        start: sequence_start,
        pad_width: sequence_pad_width as usize,
    };
    core_filename::render_filename(template, &inputs, &sequence).map_err(|e| to_js_error(&e))
}

/// Validate a filename directly (no template) — the same rules
/// [`render_filename_template`] enforces on its rendered output, so a
/// manually-typed single-file rename gets identical rejection behaviour to
/// a templated batch rename. Returns nothing on success; throws the same
/// `.kind`-carrying JS `Error` shape as [`render_filename_template`] (minus
/// the template-parse-only and pad-width-only reasons, which can't occur
/// here — there is no template and no sequence to validate).
#[wasm_bindgen]
pub fn validate_filename(name: &str) -> Result<(), JsValue> {
    core_filename::validate_filename(name).map_err(|e| to_js_error(&e))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn renders_a_basic_template() {
        let got =
            render_filename_template("{original}.{ext}", "IMG_0001", "dng", None, 0, 0, 0).unwrap();
        assert_eq!(got, "IMG_0001.dng");
    }

    #[test]
    fn renders_sequence_and_date_tokens() {
        let got = render_filename_template(
            "{date:%Y%m%d}_{original}_{n}.{ext}",
            "IMG_0001",
            "dng",
            Some("2023:01:15 08:09:10".to_string()),
            10,
            2,
            3,
        )
        .unwrap();
        assert_eq!(got, "20230115_IMG_0001_012.dng");
    }

    #[test]
    fn missing_captured_at_falls_back() {
        let got = render_filename_template("{date:%Y}", "x", "dng", None, 0, 0, 0).unwrap();
        assert_eq!(got, "unknown-date");
    }

    #[test]
    fn matches_raw_core_directly() {
        let inputs = core_filename::RenderInputs {
            original_stem: "IMG_0042",
            ext: "cr3",
            index: 7,
            captured_at: Some("2023:11:02 08:15:00"),
        };
        let sequence = core_filename::SequenceOptions {
            start: 1,
            pad_width: 4,
        };
        let expected = core_filename::render_filename(
            "{date:%Y%m%d}_{original}_{n}.{ext}",
            &inputs,
            &sequence,
        )
        .unwrap();

        let got = render_filename_template(
            "{date:%Y%m%d}_{original}_{n}.{ext}",
            "IMG_0042",
            "cr3",
            Some("2023:11:02 08:15:00".to_string()),
            1,
            7,
            4,
        )
        .unwrap();
        assert_eq!(got, expected);
    }

    #[test]
    fn validate_filename_accepts_ordinary_name() {
        assert!(validate_filename("IMG_0001.dng").is_ok());
    }

    #[test]
    fn sequence_pad_width_at_the_maximum_succeeds() {
        let max = core_filename::MAX_SEQUENCE_PAD_WIDTH as u32;
        let got = render_filename_template("{n}", "x", "dng", None, 0, 0, max).unwrap();
        assert_eq!(got.len(), max as usize);
    }

    // The `to_js_error`-returning rejection paths of `render_filename_template`
    // / `validate_filename` are NOT covered by a host-target `#[test]` here —
    // `js_sys::Error::new` and `js_sys::Reflect::set` call wasm-bindgen-
    // imported JS constructors/functions that panic outside a real wasm/JS
    // runtime (verified, same as every other JS-interop-returning branch in
    // this crate — see `id.rs`'s test module doc for the fuller explanation).
    // `raw-core`'s own `filename::tests_validation` and `filename::tests`
    // modules exhaustively cover every rejection reason (including the
    // `.kind()` tag each one maps to) at the layer that actually produces it;
    // this binding is a thin `.map_err(to_js_error)` over that already-tested
    // `Result`. True coverage of the thrown-value shape (the `.kind`
    // property specifically) is deferred to whichever future task first
    // exercises this from a real browser context.
}
