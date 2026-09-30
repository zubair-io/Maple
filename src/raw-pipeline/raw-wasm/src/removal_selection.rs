//! Thin WASM selection and durable-mask bridge (#3934), shared with C-FFI.
use wasm_bindgen::prelude::*;

/// Compose once on source/stack changes, retaining the returned base for live
/// grading. Coordinates describe the un-oriented DefaultCrop source window.
#[wasm_bindgen]
pub fn removal_composite_window(
    input: &[f32],
    width: u32,
    height: u32,
    blob: &[u8],
    window: &[f32],
) -> Result<Vec<f32>, JsError> {
    let window: [f32; 4] = window
        .try_into()
        .map_err(|_| JsError::new("source window needs four values"))?;
    let patches = if blob.is_empty() {
        Vec::new()
    } else {
        raw_core::pipeline::patches_from_blob(blob).map_err(|e| JsError::new(&e))?
    };
    raw_core::pipeline::composite_window_into_f32(input, width, height, &patches, window)
        .map_err(|e| JsError::new(&e.to_string()))
}

#[wasm_bindgen]
pub fn removal_selection(
    source_width: u32,
    source_height: u32,
    request: &str,
) -> Result<Vec<u8>, JsError> {
    raw_core::stages::removal_selection::rasterize_json(source_width, source_height, request)
        .map_err(|e| JsError::new(&e))
}

#[wasm_bindgen]
pub struct RemovalMask {
    mask: raw_core::types::removal_mask::RemovalMask,
}

#[wasm_bindgen]
impl RemovalMask {
    #[wasm_bindgen(constructor)]
    pub fn new(bytes: &[u8]) -> Result<RemovalMask, JsError> {
        raw_core::pipeline::removal_mask_from_bytes(bytes)
            .map(|mask| Self { mask })
            .map_err(|e| JsError::new(&e))
    }

    pub fn geometry(&self) -> Vec<u32> {
        vec![
            self.mask.source_width,
            self.mask.source_height,
            self.mask.x,
            self.mask.y,
            self.mask.width,
            self.mask.height,
        ]
    }

    /// Transfer pixels once to the UI/model worker. This consumes the handle;
    /// it is never part of a slider tick or saved XMP payload.
    pub fn take_pixels(self) -> Vec<u8> {
        self.mask.pixels
    }
}
