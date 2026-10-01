//! Native object-removal inference adapters (#3941 / epic #1472).
//!
//! Deliberate qualification stage: pinned experimental graphs, CPU execution
//! only. No model here is release-qualified. Authoring UI, model provisioning,
//! photographic quality and physical-device gates remain under #3941.
//! All color conversion, prompts, mask selection and compositing stay raw-core.
#![cfg(any(feature = "ml", feature = "ml-static"))]

mod detection;
mod models;
mod reconstruction;
mod selection;

pub use detection::{Detection, PersonDetector};
pub use maple_ort::{OrtRuntime, RuntimeError};
pub use ort::session::RunOptions as RemovalRunOptions;
pub use reconstruction::RemovalReconstructor;
pub use selection::{SelectionEmbedding, SmartSelector};

#[derive(Debug, thiserror::Error)]
pub enum RemovalInferenceError {
    #[error("invalid removal input: {0}")]
    Input(String),
    #[error("removal model verification: {0}")]
    Model(String),
    #[error("removal runtime: {0}")]
    Runtime(#[from] RuntimeError),
    #[error("removal inference: {0}")]
    Inference(#[from] ort::Error),
}

pub type Result<T> = std::result::Result<T, RemovalInferenceError>;

fn valid_floats(values: &[f32], count: usize, low: f32, high: f32) -> Result<()> {
    if values.len() != count
        || values
            .iter()
            .any(|v| !v.is_finite() || *v < low || *v > high)
    {
        return Err(RemovalInferenceError::Input(
            "tensor shape or domain mismatch".into(),
        ));
    }
    Ok(())
}
