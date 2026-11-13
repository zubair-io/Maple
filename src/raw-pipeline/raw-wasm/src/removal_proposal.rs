//! The inference worker uses the exact portable proposal preparation (#3941).
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub fn removal_generation_plan(
    source: &str,
    intent: &[u8],
    hole_radius: u32,
    fringe_radius: f32,
) -> Result<String, JsError> {
    raw_core::pipeline::plan_removal_generation(source, intent, hole_radius, fringe_radius)
        .map_err(|e| JsError::new(&e))
}

#[wasm_bindgen]
pub struct RemovalGeneration {
    inner: raw_core::pipeline::PreparedRemovalGeneration,
}

#[wasm_bindgen]
impl RemovalGeneration {
    #[wasm_bindgen(constructor)]
    pub fn new(
        request: &str,
        prior: &str,
        scene: &[f32],
        intent: &[u8],
        protected: &[u8],
    ) -> Result<Self, JsError> {
        raw_core::pipeline::PreparedRemovalGeneration::prepare(
            request, prior, scene, intent, protected,
        )
        .map(|inner| Self { inner })
        .map_err(|e| JsError::new(&e))
    }
    pub fn request(&self) -> String {
        self.inner.request().into()
    }
    pub fn rgb(&self) -> Vec<f32> {
        self.inner.rgb().into()
    }
    pub fn hole(&self) -> Vec<f32> {
        self.inner.hole().into()
    }
    pub fn finish(&self, generated: &[f32]) -> Result<Vec<u8>, JsError> {
        self.inner
            .finish(generated, raw_core::cancel::CancelToken::never())
            .map_err(|e| JsError::new(&e))
    }
}
