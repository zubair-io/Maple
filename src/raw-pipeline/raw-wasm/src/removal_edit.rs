//! Cold saved-edit controls use the same validator and identity as Apple.
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub fn removal_saved_list(records: &str) -> Result<String, JsError> {
    raw_core::pipeline::saved_removal_list(records).map_err(|e| JsError::new(&e))
}

#[wasm_bindgen]
pub fn removal_saved_edit(records: &str, request: &str) -> Result<String, JsError> {
    raw_core::pipeline::edit_saved_removal(records, request).map_err(|e| JsError::new(&e))
}

#[wasm_bindgen]
pub fn removal_saved_prefix(records: &str, id: &str) -> Result<String, JsError> {
    raw_core::pipeline::saved_removal_prefix(records, id).map_err(|e| JsError::new(&e))
}
