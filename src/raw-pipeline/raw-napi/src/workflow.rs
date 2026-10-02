//! Synchronous, bounded string conversion, identical to C/WASM (#4036).
use napi::bindgen_prelude::*;
use raw_core::workflow::SidecarWorkflow;

#[napi(object)]
pub struct WorkflowResult {
    pub ok: bool,
    pub value: Option<String>,
    pub error: Option<String>,
}
fn result(value: std::result::Result<String, String>) -> WorkflowResult {
    match value {
        Ok(value) => WorkflowResult {
            ok: true,
            value: Some(value),
            error: None,
        },
        Err(error) => WorkflowResult {
            ok: false,
            value: None,
            error: Some(error),
        },
    }
}
#[napi]
pub fn workflow_validate_json(json: String) -> WorkflowResult {
    result(SidecarWorkflow::parse(&json).and_then(|record| record.to_json()))
}
#[napi]
pub fn workflow_read_xmp(xmp: String) -> WorkflowResult {
    result(
        SidecarWorkflow::from_xmp(&xmp)
            .and_then(|record| record.map_or_else(|| Ok("null".into()), |record| record.to_json())),
    )
}
#[napi]
pub fn workflow_embed_xmp(json: String, xmp: String) -> WorkflowResult {
    result(SidecarWorkflow::parse(&json).and_then(|record| record.embed_in_xmp(&xmp)))
}

#[napi]
pub fn workflow_checkpoint_xmp(xmp: String) -> WorkflowResult {
    result(SidecarWorkflow::checkpoint_xmp(&xmp))
}

#[napi]
pub fn workflow_variant_filename(primary_name: String, variant_id: String) -> WorkflowResult {
    result(raw_core::workflow::variant_filename(
        &primary_name,
        &variant_id,
    ))
}
