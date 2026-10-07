//! Native raster patches through the shared non-RAW chain (#4317).
use crate::detail::DetailFrame;
use eframe::egui;
use raw_core::{pipeline, AdjustmentModel, CancelToken};
use std::sync::Arc;

#[derive(Default)]
pub(crate) struct RasterDetailRenderer {
    image: Option<pipeline::RasterDetailImage>,
    reference: Option<(AdjustmentModel, Arc<egui::ColorImage>)>,
}

impl RasterDetailRenderer {
    pub fn render(
        &mut self,
        bytes: &[u8],
        model: &AdjustmentModel,
        rect: pipeline::TileRect,
        cancel: CancelToken<'_>,
        obsolete: impl Fn() -> bool,
    ) -> Result<Option<DetailFrame>, String> {
        if cancel.is_cancelled() || obsolete() {
            return Ok(None);
        }
        let result = self.prepare_and_render(bytes, model, rect, cancel);
        match result {
            Ok(frame) if !cancel.is_cancelled() && !obsolete() => Ok(Some(frame)),
            Ok(_) | Err(raw_core::error::Error::Cancelled) => Ok(None),
            Err(error) => Err(error.to_string()),
        }
    }

    fn prepare_and_render(
        &mut self,
        bytes: &[u8],
        model: &AdjustmentModel,
        rect: pipeline::TileRect,
        cancel: CancelToken<'_>,
    ) -> raw_core::error::Result<DetailFrame> {
        pipeline::validate_raster_adjustments(model)?;
        let (model, film) =
            crate::film::renderable(model).map_err(raw_core::error::Error::Pipeline)?;
        let model = model.as_ref();
        if self.image.is_none() {
            self.image = Some(pipeline::RasterDetailImage::open(bytes, cancel)?);
        }
        if self
            .reference
            .as_ref()
            .is_none_or(|(cached, _)| cached != model)
        {
            self.reference = None;
            let (w, h, pixels) = pipeline::render_export_raster_cancellable(
                bytes,
                model,
                Some(1600),
                raw_core::view::encode::TargetPrimaries::Srgb,
                pipeline::ExportDepth::Eight,
                film.as_ref().map(|f| f.lut),
                cancel,
            )?;
            let pipeline::ExportPixels::Eight(rgb) = pixels else {
                unreachable!("eight-bit base")
            };
            if cancel.is_cancelled() {
                return Err(raw_core::error::Error::Cancelled);
            }
            self.reference = Some((
                model.clone(),
                Arc::new(egui::ColorImage::from_rgb([w as usize, h as usize], &rgb)),
            ));
        }
        let image = self.image.as_ref().expect("opened raster detail");
        let (w, h, rgb) =
            image.render_tile(model, rect, film.as_ref().map(|f| f.lut), 8_388_608, cancel)?;
        Ok(DetailFrame {
            native_size: image.dimensions(),
            rect,
            request: rect,
            whole_fallback: false,
            base: self.reference.as_ref().expect("raster base").1.clone(),
            patch: egui::ColorImage::from_rgb([w as usize, h as usize], &rgb),
        })
    }
}

#[cfg(test)]
#[path = "raster_detail_tests.rs"]
mod tests;
