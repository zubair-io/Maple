//! Retained saved tiles reuse shared scene-linear composition (#3955).
use super::MapleRawHandleInner;
use raw_core::pipeline::{RenderQuality, TileRect};

impl MapleRawHandleInner {
    pub(super) fn render_tile_f32(
        &self,
        rect: TileRect,
        quality: RenderQuality,
        wb_anchor: Option<(f32, f32)>,
        ae_gain: f32,
    ) -> raw_core::Result<(u32, u32, Vec<f32>)> {
        match &self.saved {
            Some(saved) => saved.render_scene_linear_tile_f32(
                &self.raw, &self.original, &self.model, rect, quality, wb_anchor, ae_gain,
            ),
            None => raw_core::pipeline::render_scene_linear_tile_from_raw_with_quality_and_wb_anchor_and_ae_gain_f32(
                &self.raw, &self.model, rect, quality, wb_anchor, ae_gain,
            ),
        }
    }

    pub(super) fn render_tile_fp16(
        &self,
        rect: TileRect,
        quality: RenderQuality,
        wb_anchor: Option<(f32, f32)>,
    ) -> raw_core::Result<(u32, u32, Vec<u16>)> {
        if self.saved.is_none() {
            return raw_core::pipeline::render_scene_linear_tile_from_raw_with_quality_and_wb_anchor(
                &self.raw, &self.model, rect, quality, wb_anchor,
            );
        }
        let (width, height, rgba) = self.render_tile_f32(rect, quality, wb_anchor, 1.0)?;
        Ok((
            width,
            height,
            rgba.into_iter()
                .map(raw_core::pipeline::f32_to_f16_bits)
                .collect(),
        ))
    }
}
