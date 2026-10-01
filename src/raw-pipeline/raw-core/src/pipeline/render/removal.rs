//! Saved calibration removals share every display/export colour and geometry
//! stage with ordinary RAW development (#3955). No inference or asset I/O here.
use super::{export, render_display_scene_with_removals, ExportDepth, ExportPixels, RawInput};
use crate::{
    film::FilmLut,
    image::RawImage,
    pipeline::{RenderQuality, ResolvedCalibrationRemovals},
    types::accepted_removal::ContentDigest,
    view::encode::TargetPrimaries,
    xmp::AdjustmentModel,
};

impl ResolvedCalibrationRemovals {
    /// Encode a deliverable using the same ICC-tagged PNG/JPEG/TIFF encoders
    /// as ordinary RAW export. Companions are already verified and retained.
    pub fn export_encoded(
        &self,
        raw: &RawImage,
        original: &ContentDigest,
        model: &AdjustmentModel,
        raw_source: Option<RawInput<'_>>,
        options: &crate::export::ExportOptions,
        film_lut: Option<&FilmLut>,
    ) -> crate::Result<crate::export::ExportedImage> {
        let (w, h, pixels) = self.render_export(
            raw,
            original,
            model,
            RenderQuality::Auto,
            raw_source,
            options.max_long_edge,
            options.target,
            options.format.depth(),
            film_lut,
        )?;
        crate::export::encode_pixels(w, h, pixels, options)
    }

    /// Render an accepted saved stack at display precision. The original digest
    /// and exact ordered records must match the prepared companions. Missing
    /// assets are rejected during preparation rather than yielding partial pixels.
    pub fn render_display(
        &self,
        raw: &RawImage,
        original: &ContentDigest,
        model: &AdjustmentModel,
        quality: RenderQuality,
        raw_source: Option<RawInput<'_>>,
        max_long_edge: Option<u32>,
        film_lut: Option<&FilmLut>,
    ) -> crate::Result<(u32, u32, Vec<u8>)> {
        Ok(self
            .render_display_with_geometry(
                raw,
                original,
                model,
                quality,
                raw_source,
                max_long_edge,
                film_lut,
            )?
            .pixels)
    }

    /// The crop input comes from this saved render's actual scene buffer.
    pub fn render_display_with_geometry(
        &self,
        raw: &RawImage,
        original: &ContentDigest,
        model: &AdjustmentModel,
        quality: RenderQuality,
        raw_source: Option<RawInput<'_>>,
        max_long_edge: Option<u32>,
        film_lut: Option<&FilmLut>,
    ) -> crate::Result<super::DisplayRender> {
        let (mut scene, context) = render_display_scene_with_removals(
            raw,
            model,
            quality,
            raw_source,
            max_long_edge,
            TargetPrimaries::Srgb,
            film_lut,
            Some((self, original)),
        )?;
        let crop_input_size = if raw.orientation.swaps_wh() {
            [scene.height, scene.width]
        } else {
            [scene.width, scene.height]
        };
        let (w, h, pixels) = export::finish_eight(&mut scene, raw.orientation, model);
        let auto_fit = (model.profile == crate::types::adjustment::Profile::Auto)
            .then_some(context.profile_curve.is_some() || context.profile_lut.is_some());
        let ExportPixels::Eight(rgb) = pixels else {
            unreachable!("Eight terminal returned Sixteen")
        };
        Ok(super::DisplayRender {
            pixels: (w, h, rgb),
            crop_input_size,
            auto_fit,
        })
    }

    /// Full or viewport-sized export, with one depth-specific quantize after the
    /// same develop, view transform, Auto fit, film and geometry as the display.
    /// This is a cold-render entry; retained live/tile preparation remains #3955.
    pub fn render_export(
        &self,
        raw: &RawImage,
        original: &ContentDigest,
        model: &AdjustmentModel,
        quality: RenderQuality,
        raw_source: Option<RawInput<'_>>,
        max_long_edge: Option<u32>,
        target: TargetPrimaries,
        depth: ExportDepth,
        film_lut: Option<&FilmLut>,
    ) -> crate::Result<(u32, u32, ExportPixels)> {
        let (mut scene, _) = render_display_scene_with_removals(
            raw,
            model,
            quality,
            raw_source,
            max_long_edge,
            target,
            film_lut,
            Some((self, original)),
        )?;
        Ok(match depth {
            ExportDepth::Eight => export::finish_eight(&mut scene, raw.orientation, model),
            ExportDepth::Sixteen => export::finish_sixteen(&mut scene, raw.orientation, model),
        })
    }
}
