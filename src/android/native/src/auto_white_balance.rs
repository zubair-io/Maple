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

/// The shared estimator for a session's name-only imported Auto WB (#4669),
/// run off the GPU thread after the As Shot first frame, then adopted by the
/// session on its render thread.
pub struct ImportedAutoWhiteBalanceWork {
    pub(crate) raw: Arc<RawImage>,
    pub(crate) estimate: raw_core::stages::imported_auto_wb::CachedEstimate,
}
impl ImportedAutoWhiteBalanceWork {
    pub fn run(&mut self) -> Result<(), String> {
        self.estimate
            .resolve(&self.raw, raw_core::CancelToken::never())
            .map(|_| ())
            .map_err(|error| error.to_string())
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn work_can_cross_the_gpu_thread_boundary() {
        fn send_sync<T: Send + Sync>() {}
        send_sync::<super::AutoWhiteBalanceWork>();
        send_sync::<super::ImportedAutoWhiteBalanceWork>();
    }
}
