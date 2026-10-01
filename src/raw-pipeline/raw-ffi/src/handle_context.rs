//! Bounded native highlight evidence retained by one immutable raw handle.
use super::MapleRawHandleInner;
use raw_core::{
    error::Result,
    image::RawImage,
    pipeline::{self, HighlightFrameContext, RenderQuality, TileRect},
    xmp::AdjustmentModel,
};
use std::sync::{Arc, Mutex, PoisonError};

#[derive(Default)]
pub(super) struct FrameCache(Mutex<Option<(RenderQuality, Arc<HighlightFrameContext>)>>);

impl MapleRawHandleInner {
    pub(super) fn new(
        raw: RawImage,
        model: AdjustmentModel,
        original: raw_core::types::accepted_removal::ContentDigest,
    ) -> Self {
        Self {
            raw: Arc::new(raw),
            model,
            frame: FrameCache::default(),
            original,
        }
    }

    fn frame_context(&self, quality: RenderQuality) -> Result<Option<Arc<HighlightFrameContext>>> {
        // Preserve the legacy core guards and fallback errors for formats or
        // whole-frame lateral-CA preparation that this context cannot own.
        if !self.raw.cfa.is_bayer_2x2()
            || self.model.auto_lateral_ca == raw_core::types::adjustment::AutoLateralCa::On
        {
            return Ok(None);
        }
        // The slot is emptied before preparation, so a panic inside a previous
        // preparation leaves no partial context behind the poisoned lock.
        let mut cached = self.frame.0.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some((previous_quality, context)) = cached.as_ref() {
            if *previous_quality == quality {
                return Ok(Some(Arc::clone(context)));
            }
        }
        // Drop prior evidence before allocating replacement preparation scratch.
        // Only a completed successful context is eligible for later pans.
        *cached = None;
        let prepared = Arc::new(HighlightFrameContext::prepare(
            Arc::clone(&self.raw),
            &self.model,
            quality,
        )?);
        *cached = Some((quality, Arc::clone(&prepared)));
        Ok(Some(prepared))
    }

    pub(super) fn render_tile_fp16(
        &self,
        rect: TileRect,
        quality: RenderQuality,
        wb_anchor: Option<(f32, f32)>,
    ) -> Result<(u32, u32, Vec<u16>)> {
        pipeline::reject_untileable_tile(&self.raw, &self.model, rect)?;
        match self.frame_context(quality)? {
            Some(context) => pipeline::render_scene_linear_tile_from_frame_context(
                &context,
                &self.model,
                rect,
                wb_anchor,
                1.0,
            ),
            None => pipeline::render_scene_linear_tile_from_raw_with_quality_and_wb_anchor(
                &self.raw,
                &self.model,
                rect,
                quality,
                wb_anchor,
            ),
        }
    }

    pub(super) fn render_tile_f32(
        &self,
        rect: TileRect,
        quality: RenderQuality,
        wb_anchor: Option<(f32, f32)>,
        ae_gain: f32,
    ) -> Result<(u32, u32, Vec<f32>)> {
        pipeline::reject_untileable_tile(&self.raw, &self.model, rect)?;
        match self.frame_context(quality)? {
            Some(context) => pipeline::render_scene_linear_tile_from_frame_context_f32(
                &context, &self.model, rect, wb_anchor, ae_gain,
            ),
            None => pipeline::render_scene_linear_tile_from_raw_with_quality_and_wb_anchor_and_ae_gain_f32(
                &self.raw, &self.model, rect, quality, wb_anchor, ae_gain,
            ),
        }
    }
}

#[cfg(test)]
#[path = "handle_context_tests.rs"]
mod tests;
