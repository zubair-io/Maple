//! One-shot shared-core AWB runs off the live renderer's serial GPU thread.
use raw_core::{
    stages::auto_adjustments::{compute_auto_adjustments, AUTO_WB_ALGORITHM_VERSION},
    types::AdjustmentModel,
    RawImage,
};
use std::sync::Arc;

pub struct AutoWhiteBalanceWork {
    raw: Arc<RawImage>,
    model: AdjustmentModel,
}
impl AutoWhiteBalanceWork {
    pub fn new(raw: Arc<RawImage>, xml: &str) -> Result<Self, String> {
        Ok(Self {
            raw,
            model: crate::xmp::parse(xml)?,
        })
    }
    pub fn run(&self) -> Result<String, String> {
        let result =
            compute_auto_adjustments(&self.raw, &self.model).map_err(|error| error.to_string())?;
        Ok(
            serde_json::json!({ "temperature": result.temperature, "tint": result.tint,
            "algorithmVersion": AUTO_WB_ALGORITHM_VERSION })
            .to_string(),
        )
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn work_can_cross_the_gpu_thread_boundary() {
        fn send_sync<T: Send + Sync>() {}
        send_sync::<super::AutoWhiteBalanceWork>();
    }
}
