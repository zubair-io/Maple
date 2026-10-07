//! Retained native-resolution patch rendering for the Linux zoom canvas (#4317).
//! One decoded RAW is shared immutably by preview/detail workers; pans reuse anchors.
use eframe::egui;
use raw_core::{
    pipeline::{self, DetailContext, DetailRenderOptions, RawInput, RenderQuality, TileRect},
    types::adjustment::AdjustmentModel,
    RawImage,
};

pub struct DetailFrame {
    pub native_size: (u32, u32),
    pub rect: TileRect,
    pub request: TileRect,
    pub whole_fallback: bool,
    pub base: std::sync::Arc<egui::ColorImage>,
    pub patch: egui::ColorImage,
}

#[cfg(test)]
#[path = "detail_cancel_tests.rs"]
mod cancellation_tests;

#[derive(Default)]
pub struct DetailRenderer {
    reference: Option<(
        AdjustmentModel,
        DetailContext,
        std::sync::Arc<egui::ColorImage>,
    )>,
}

impl DetailRenderer {
    /// Render one native patch, including the shared core's filter overlap.
    /// The memory cap covers working pixels rather than just the output patch.
    /// Each patch carries its shared anchored base, so dropping a superseded
    /// first result cannot leave a later patch without its matching reference.
    /// Rejections are explicit so the
    /// canvas can retain its bounded whole-image preview.
    pub fn render(
        &mut self,
        raw: &RawImage,
        bytes: &[u8],
        ext: &str,
        model: &AdjustmentModel,
        rect: TileRect,
    ) -> Result<DetailFrame, String> {
        self.render_cancellable(raw, bytes, ext, model, rect, || false)
            .map(|frame| frame.expect("never-cancel detail render"))
    }

    /// Stop between the shared base and tile kernels when the request changes.
    /// This boundary-only wrapper keeps the never-cancel tile binding.
    /// The worker also passes its host flag to supported tile kernels (#4317).
    pub(crate) fn render_cancellable(
        &mut self,
        raw: &RawImage,
        bytes: &[u8],
        ext: &str,
        model: &AdjustmentModel,
        rect: TileRect,
        cancelled: impl Fn() -> bool,
    ) -> Result<Option<DetailFrame>, String> {
        self.render_with_token(
            raw,
            bytes,
            ext,
            model,
            rect,
            raw_core::CancelToken::never(),
            cancelled,
        )
    }

    #[allow(clippy::too_many_arguments)]
    pub(crate) fn render_with_token(
        &mut self,
        raw: &RawImage,
        bytes: &[u8],
        ext: &str,
        model: &AdjustmentModel,
        rect: TileRect,
        cancel: raw_core::CancelToken<'_>,
        cancelled: impl Fn() -> bool,
    ) -> Result<Option<DetailFrame>, String> {
        if cancelled() {
            return Ok(None);
        }
        if !raw_core::stages::perspective::Perspective::from_model(model).is_identity() {
            return Err("Native detail requires no perspective corrections".into());
        }
        let (model, film) = crate::film::renderable(model)?;
        let model = model.as_ref();
        if self
            .reference
            .as_ref()
            .is_none_or(|(cached, _, _)| cached != model)
        {
            // Release old anchors before allocating a replacement reference.
            self.reference = None;
            let result = pipeline::render_detail_base_cancellable(
                raw,
                model,
                RawInput::Bytes { bytes, ext },
                DetailRenderOptions {
                    quality: RenderQuality::Preview,
                    max_long_edge: 1600,
                    film_lut: film.as_ref().map(|film| film.lut),
                },
                cancel,
            );
            let (w, h, rgb, context) = match result {
                Ok(result) => result,
                Err(raw_core::error::Error::Cancelled) => return Ok(None),
                Err(error) => return Err(error.to_string()),
            };
            if cancelled() {
                return Ok(None);
            }
            self.reference = Some((
                model.clone(),
                context,
                std::sync::Arc::new(egui::ColorImage::from_rgb([w as usize, h as usize], &rgb)),
            ));
        }
        let (_, context, base) = self.reference.as_ref().expect("prepared detail reference");
        if cancelled() {
            return Ok(None);
        }
        let base = base.clone();
        let result = pipeline::render_detail_tile_cancellable(
            raw,
            context,
            rect,
            film.as_ref().map(|film| film.lut),
            8_388_608,
            cancel,
        );
        let (w, h, rgb) = match result {
            Ok(result) => result,
            Err(raw_core::error::Error::Cancelled) => return Ok(None),
            Err(error) => {
                self.reference = None;
                return Err(error.to_string());
            }
        };
        if cancelled() {
            return Ok(None);
        }
        Ok(Some(DetailFrame {
            native_size: pipeline::native_render_dims(raw),
            rect,
            request: rect,
            whole_fallback: false,
            base,
            patch: egui::ColorImage::from_rgb([w as usize, h as usize], &rgb),
        }))
    }
}
