//! The interruptible name-only imported Auto WB estimate on the web (#5923).
//!
//! The render worker runs the estimate synchronously, so a message posted to
//! the worker cannot reach it. The main thread instead stores 1 into
//! [`imported_wb_cancel_flag`]'s byte of this module's shared memory before it
//! posts work the worker must serve first, and 0 before it asks for an
//! estimate. The estimate observes the flag within one row or pass.

use raw_core::{image::RawImage, stages::imported_auto_wb::CachedEstimate, CancelToken, Error};
use std::sync::atomic::AtomicBool;
use wasm_bindgen::{prelude::*, JsCast};

static CANCEL: AtomicBool = AtomicBool::new(false);

/// A one-byte view of the cancel flag over the module's shared memory, which
/// the worker hands to the main thread.
#[wasm_bindgen]
pub fn imported_wb_cancel_flag() -> js_sys::Uint8Array {
    let memory: js_sys::WebAssembly::Memory = wasm_bindgen::memory().unchecked_into();
    let offset = CANCEL.as_ptr() as usize as u32;
    js_sys::Uint8Array::new_with_byte_offset_and_length(&memory.buffer(), offset, 1)
}

/// The session's pair as `[temperature, tint]`, or `None` when the main
/// thread cancelled the estimate: the cache stays unresolved, so the next ask
/// estimates again.
pub(crate) fn resolve(
    cache: &mut CachedEstimate,
    raw: &RawImage,
) -> Result<Option<Vec<f32>>, JsError> {
    resolve_with(cache, raw, &CANCEL)
}

fn resolve_with(
    cache: &mut CachedEstimate,
    raw: &RawImage,
    flag: &AtomicBool,
) -> Result<Option<Vec<f32>>, JsError> {
    match cache.resolve(raw, CancelToken::new(flag)) {
        Ok((temperature, tint)) => Ok(Some(vec![temperature, tint])),
        Err(Error::Cancelled) => Ok(None),
        Err(error) => Err(JsError::new(&error.to_string())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::Ordering;

    #[test]
    fn a_cancelled_estimate_keeps_nothing_and_the_next_ask_gets_the_pair() {
        let raw = raw_core::decode::decode(
            &std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../../test-fixtures/batch-transfer/source.dng"),
        )
        .unwrap();
        let expected =
            raw_core::stages::imported_auto_wb::estimate(&raw, CancelToken::never()).unwrap();
        let mut cache = CachedEstimate::default();
        let flag = AtomicBool::new(true);
        assert_eq!(resolve_with(&mut cache, &raw, &flag).unwrap(), None);
        assert_eq!(cache.pair(), None);
        flag.store(false, Ordering::Relaxed);
        assert_eq!(
            resolve_with(&mut cache, &raw, &flag).unwrap(),
            Some(vec![expected.0, expected.1])
        );
        assert_eq!(cache.pair(), Some(expected));
    }
}
