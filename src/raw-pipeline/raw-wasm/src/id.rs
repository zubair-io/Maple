//! Streaming fallback-form `maple_id` hasher, exposed to the Angular
//! `maple-common` package via wasm-bindgen (#1995).
//!
//! `raw_core::MapleId::fallback` requires the caller to hold a file's entire
//! bytes as one contiguous slice (its `sha1_full` term is `SHA1(all
//! bytes)`). That's the wrong shape in a browser: a 100+ MB RAW read via
//! `File.slice(offset, offset + chunkSize)` arrives in bounded pieces, and
//! buffering the whole file into one `Uint8Array` before hashing defeats the
//! point of chunked reads. [`FallbackIdHasher`] wraps
//! `raw_core::FallbackIdHasher` so JS can feed chunks as they arrive:
//!
//! ```js
//! const hasher = new FallbackIdHasher();
//! for (const chunk of chunks) hasher.update(chunk); // Uint8Array per chunk
//! const hex = hasher.finalize(BigInt(file.size)); // 32-char lowercase hex
//! ```
//!
//! This binding is intentionally a thin pass-through: all the hashing logic
//! (and its correctness-critical chunk-boundary-independence property) lives
//! in `raw_core::FallbackIdHasher`, which is thoroughly tested in
//! `raw-core/src/id.rs`. Wiring this into the Angular file-open path (the
//! actual `File.slice()` read loop) is separate follow-up work — this module
//! only builds the binding.
//!
//! No WASM-level (`wasm-bindgen-test`) tests here: `raw-wasm` has no existing
//! `wasm-bindgen-test` infrastructure to hook into (its `#[cfg(test)] mod
//! tests` blocks elsewhere, e.g. `auto_tone.rs`, run as plain host-target
//! `#[test]`s over logic that doesn't touch JS-specific types). This
//! binding's `update`/`finalize` signatures are plain Rust slices/integers
//! with no `JsValue`/`Uint8Array` marshalling of their own — wasm-bindgen
//! generates that glue — so a host-target `#[test]` below exercises the same
//! `FallbackIdHasher` methods JS would call, deferring true in-browser
//! coverage to whichever future task first exercises this from a real
//! `File.slice()` loop.
//!
//! The primary form has no streaming counterpart here either, matching
//! `raw-core`/`raw-ffi`: it only ever reads a bounded 64 KB head, which
//! fits trivially in a single `Uint8Array` already.

use wasm_bindgen::prelude::*;

/// Streaming fallback-form id hasher. Construct with `new FallbackIdHasher()`,
/// call `update(chunk)` any number of times in file order (chunk size is
/// caller-defined; an empty `Uint8Array` is a valid no-op), then call
/// `finalize(filesize)` exactly once to get the 32-character lowercase hex
/// fallback-form id.
///
/// `finalize` consumes the underlying hasher state. wasm-bindgen classes
/// don't take `self` by value here (a `None` inner after the first
/// `finalize` call is the guard) so a second `finalize` call throws a
/// `JsError` instead of panicking or silently returning a stale/empty hash.
#[wasm_bindgen]
pub struct FallbackIdHasher {
    inner: Option<raw_core::FallbackIdHasher>,
}

#[wasm_bindgen]
impl FallbackIdHasher {
    /// Start a new streaming fallback-id hash with no bytes fed yet.
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        FallbackIdHasher {
            inner: Some(raw_core::FallbackIdHasher::new()),
        }
    }

    /// Feed the next chunk of file bytes, in file order. Throws a `JsError`
    /// if called after `finalize`.
    pub fn update(&mut self, chunk: &[u8]) -> Result<(), JsError> {
        match self.inner.as_mut() {
            Some(hasher) => {
                hasher.update(chunk);
                Ok(())
            }
            None => Err(JsError::new(
                "FallbackIdHasher.update called after finalize",
            )),
        }
    }

    /// Finish the hash and return the 32-character lowercase hex
    /// fallback-form id. `filesize` is passed explicitly (matches
    /// `raw_core::FallbackIdHasher::finalize`'s contract — typically the
    /// total bytes fed via `update`, but the caller may pass the file's true
    /// on-disk size independently). Throws a `JsError` if called more than
    /// once.
    pub fn finalize(&mut self, filesize: u64) -> Result<String, JsError> {
        match self.inner.take() {
            Some(hasher) => Ok(hasher.finalize(filesize).to_hex()),
            None => Err(JsError::new(
                "FallbackIdHasher.finalize called more than once",
            )),
        }
    }
}

impl Default for FallbackIdHasher {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_raw_core_across_chunk_boundaries() {
        let mut bytes = vec![0u8; 5000];
        for (i, b) in bytes.iter_mut().enumerate() {
            *b = ((i * 37 + 11) & 0xff) as u8;
        }
        let expected = raw_core::MapleId::fallback(&bytes, bytes.len() as u64).to_hex();

        let mut hasher = FallbackIdHasher::new();
        for chunk in bytes.chunks(777) {
            hasher.update(chunk).unwrap();
        }
        let actual = hasher.finalize(bytes.len() as u64).unwrap();
        assert_eq!(actual, expected);
    }

    #[test]
    fn finalize_uses_explicit_filesize() {
        let bytes = [3u8; 100];
        let claimed_size = 999u64;
        let expected = raw_core::MapleId::fallback(&bytes, claimed_size).to_hex();

        let mut hasher = FallbackIdHasher::new();
        hasher.update(&bytes).unwrap();
        let actual = hasher.finalize(claimed_size).unwrap();
        assert_eq!(actual, expected);
    }

    // NOTE: the update-after-finalize / double-finalize error paths (both
    // return `Err(JsError::new(...))`) are NOT covered by a host-target
    // `#[test]` here: `JsError::new` calls into a wasm-bindgen-imported JS
    // `Error` constructor that panics with "cannot call wasm-bindgen
    // imported functions on non-wasm targets" outside an actual wasm/JS
    // runtime (verified — both would-be tests panicked when run via `cargo
    // test -p raw-wasm` on the host target). No existing test in this crate
    // exercises any `JsError`-returning branch for the same reason (grep
    // `JsError::new` vs `#[test]` across `src/`) — this isn't a gap specific
    // to this binding. The `Option::take()` guard logic itself has no
    // wasm-specific dependency and is straightforward to eyeball; true
    // coverage of the thrown-JsError behavior is deferred to whichever
    // future task first exercises this from a real browser context (see
    // module doc comment).
}
