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

#[wasm_bindgen]
pub fn workflow_commit_xmp(xmp: &str, json: &str) -> Result<String, JsError> {
    SidecarWorkflow::commit_xmp(xmp, json).map_err(|e| JsError::new(&e))
}

#[wasm_bindgen]
pub fn workflow_snapshot_xmp(xmp: &str, json: &str) -> Result<String, JsError> {
    SidecarWorkflow::snapshot_xmp(xmp, json).map_err(|e| JsError::new(&e))
}

#[wasm_bindgen]
pub fn workflow_restore_xmp(xmp: &str, json: &str) -> Result<String, JsError> {
    SidecarWorkflow::restore_xmp(xmp, json).map_err(|e| JsError::new(&e))
}

#[wasm_bindgen]
pub fn workflow_reconcile_xmp(
    base: &str,
    current: &str,
    incoming: &str,
    now_ms: f64,
) -> Result<String, JsError> {
    raw_core::workflow::timestamp_ms(now_ms)
        .and_then(|now| SidecarWorkflow::reconcile_xmp(base, current, incoming, now))
        .map_err(|e| JsError::new(&e))
}

#[wasm_bindgen]
pub fn workflow_cursor_xmp(xmp: &str) -> Result<String, JsError> {
    SidecarWorkflow::cursor_xmp(xmp).map_err(|e| JsError::new(&e))
}
