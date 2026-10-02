//! Pure shared workflow conversion; invoked at save, never slider/render ticks (#4036).
use raw_core::workflow::SidecarWorkflow;
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub fn workflow_validate_json(json: &str) -> Result<String, JsError> {
    SidecarWorkflow::parse(json)
        .and_then(|record| record.to_json())
        .map_err(|e| JsError::new(&e))
}

#[wasm_bindgen]
pub fn workflow_read_xmp(xmp: &str) -> Result<String, JsError> {
    SidecarWorkflow::from_xmp(xmp)
        .and_then(|record| record.map_or_else(|| Ok("null".into()), |record| record.to_json()))
        .map_err(|e| JsError::new(&e))
}

#[wasm_bindgen]
pub fn workflow_embed_xmp(json: &str, xmp: &str) -> Result<String, JsError> {
    SidecarWorkflow::parse(json)
        .and_then(|record| record.embed_in_xmp(xmp))
        .map_err(|e| JsError::new(&e))
}

#[wasm_bindgen]
pub fn workflow_checkpoint_xmp(xmp: &str) -> Result<String, JsError> {
    SidecarWorkflow::checkpoint_xmp(xmp).map_err(|e| JsError::new(&e))
}

#[wasm_bindgen]
pub fn workflow_variant_filename(primary_name: &str, variant_id: &str) -> Result<String, JsError> {
    raw_core::workflow::variant_filename(primary_name, variant_id).map_err(|e| JsError::new(&e))
}
