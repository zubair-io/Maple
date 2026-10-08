//! Source-owned native frame evidence for repeated detail windows (#4378).
use crate::{
    error::{Error, Result},
    image::RawImage,
    pipeline::RenderQuality,
    stages::highlight_recovery::{FrameAnchor, ScenePrior},
    xmp::AdjustmentModel,
};
use std::sync::{Arc, OnceLock};

/// Exact native-density highlight evidence. The owned immutable source prevents
/// context/source replacement and allocator-address reuse, without copying RAW
/// samples or retaining full-frame RGB. Requested quality is never relabeled.
/// The scene prior is sampled once, on the first tile that defers to tier 3.
pub struct HighlightFrameContext {
    raw: Arc<RawImage>,
    quality: RenderQuality,
    model: AdjustmentModel,
    scene: OnceLock<Option<[f32; 3]>>,
}
impl HighlightFrameContext {
    /// Peak sampler mosaic area, admitted before any native-prefix preparation.
    /// This does not describe total retained/session byte usage.
    pub fn preparation_working_pixels(
        raw: &RawImage,
        model: &AdjustmentModel,
        quality: RenderQuality,
    ) -> u64 {
        super::highlight_frame::scratch_pixels(raw, model, quality)
    }
    pub fn prepare(
        raw: Arc<RawImage>,
        model: &AdjustmentModel,
        quality: RenderQuality,
    ) -> Result<Self> {
        if !raw.cfa.is_bayer_2x2() || raw.width == 0 || raw.height == 0 {
            return Err(Error::Pipeline(
                "native highlight context requires a nonempty Bayer source".into(),
            ));
        }
        if model.auto_lateral_ca == crate::types::adjustment::AutoLateralCa::On {
            return Err(Error::Pipeline(
                "native highlight context requires full-frame lateral-CA preparation".into(),
            ));
        }
        Ok(Self {
            raw,
            quality,
            model: model.clone(),
            scene: OnceLock::new(),
        })
    }
    pub fn raw(&self) -> &RawImage {
        &self.raw
    }
    pub fn quality(&self) -> RenderQuality {
        self.quality
    }
    /// True when this evidence is exact for `model` on the same retained source.
    pub fn reusable_for(
        &self,
        raw: &Arc<RawImage>,
        model: &AdjustmentModel,
        quality: RenderQuality,
    ) -> bool {
        Arc::ptr_eq(&self.raw, raw) && self.quality == quality && self.prefix_matches(model)
    }
    fn prefix_matches(&self, model: &AdjustmentModel) -> bool {
        self.model.hot_pixel_suppression == model.hot_pixel_suppression
            && self.model.demosaic == model.demosaic
            && model.auto_lateral_ca != crate::types::adjustment::AutoLateralCa::On
            && self.model.highlight_recovery == model.highlight_recovery
    }
    pub(super) fn anchor(
        &self,
        origin: (u32, u32),
        model: &AdjustmentModel,
    ) -> Result<FrameAnchor<'_>> {
        if !self.prefix_matches(model) {
            return Err(Error::Pipeline(
                "native highlight context prefix changed; prepare from the new model".into(),
            ));
        }
        Ok(super::highlight_frame::anchor(
            &self.raw,
            self.quality,
            origin,
            self,
        ))
    }
}
#[cfg(test)]
impl HighlightFrameContext {
    pub(super) fn scene_sampled(&self) -> bool {
        self.scene.get().is_some()
    }
}
impl ScenePrior for HighlightFrameContext {
    fn scene(&self) -> Option<[f32; 3]> {
        *self.scene.get_or_init(|| {
            super::highlight_frame::scene_prior(&self.raw, &self.model, self.quality)
        })
    }
}
