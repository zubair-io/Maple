//! Bounded interactive capture preview; final refinement keeps canonical CPU order.
//! The 512px phase applies GPU deconvolution after the resident AE base, an
//! interactive approximation. Refine uses the canonical capture-before-AE CPU
//! prefix; GPU capture is then disabled. Allocation/hardware qualification: #4623.
use super::*;
use raw_core::gpu_host::model::capture_sharpening_inputs;

pub(super) const FAST_EDGE: u32 = 512;

pub(super) struct FastPreview {
    pub live: LiveSession,
    pub prefix: AdjustmentModel,
    pub inputs: FullChainInputs<'static>,
    pub sampling: f32,
    /// Auto-exposure gain the prefix develop baked in (the live WB's
    /// HueSatMap undoes it, #5099); resampling keeps it.
    pub exposure: f32,
}

#[allow(deprecated)]
pub(super) fn without_capture(model: &AdjustmentModel) -> AdjustmentModel {
    let defaults = AdjustmentModel::default();
    AdjustmentModel {
        capture_sharpening_amount: 0.,
        capture_sharpening_sigma: defaults.capture_sharpening_sigma,
        capture_sharpening_radius: defaults.capture_sharpening_radius,
        ..model.clone()
    }
}

// Resample only the already developed viewport, using the shared core filter.
// This runs at open/preparation, never on a slider tick or on the sensor mosaic.
pub(super) fn bounded_pixels(pixels: &[f32], w: u32, h: u32) -> (Vec<f32>, u32, u32, f32) {
    let mut image =
        raw_core::image::Image::new(w, h, raw_core::image::ColorSpace::SceneLinearRec2020);
    for (target, source) in image.pixels.iter_mut().zip(pixels.chunks_exact(4)) {
        *target = [source[0], source[1], source[2]];
    }
    raw_core::pipeline::downsample_image_area(&mut image, FAST_EDGE);
    let ratio = image.width as f32 / w as f32;
    let rgba = image
        .pixels
        .iter()
        .flat_map(|p| [p[0], p[1], p[2], 1.])
        .collect();
    (rgba, image.width, image.height, ratio)
}

impl FastPreview {
    pub fn new(
        ctx: &GpuContext,
        pixels: &[f32],
        w: u32,
        h: u32,
        prefix: AdjustmentModel,
        inputs: FullChainInputs<'static>,
        (sampling, exposure): (f32, f32),
    ) -> Result<Self, String> {
        let (pixels, w, h, ratio) = bounded_pixels(pixels, w, h);
        let mut preview = Self {
            live: LiveSession::new(ctx, &pixels, w, h)?,
            prefix,
            inputs,
            sampling: sampling * ratio,
            exposure,
        };
        preview.inputs.nr_sampling_scale = preview.sampling;
        // Compile and allocate the existing capture pass before the first drag.
        // The hidden warm frame uses the actual photo; every draw starts again
        // from the immutable zero-capture upload, so no effect can accumulate.
        preview.inputs.capture_sharpening = Some(raw_gpu::CaptureSharpeningParams::default());
        preview
            .live
            .render_chain_to_f32(ctx, &preview.inputs, &CancelToken::new())?;
        preview.inputs.capture_sharpening = None;
        Ok(preview)
    }
}

pub(super) fn update_inputs(
    model: &AdjustmentModel,
    inputs: &mut FullChainInputs<'static>,
    wb: Option<&GpuWhiteBalance>,
    (sampling, exposure): (f32, f32),
    target: u32,
    capture: bool,
) -> Result<(), String> {
    update_chain_inputs(model, inputs);
    let film = crate::film::resolve(&model.film_look)?;
    inputs.film_lut_size = film.map_or(0, |f| f.0.size as u32);
    inputs.film_lut_key = film.map_or(0, |f| f.1);
    inputs.film_lut_data = std::borrow::Cow::Borrowed(film.map_or(&[], |f| f.0.data.as_slice()));
    if let Some(wb) = wb {
        wb.apply(model, exposure, inputs);
    }
    inputs.nr_sampling_scale = sampling;
    inputs.target_primaries = target;
    inputs.capture_sharpening = if capture {
        capture_sharpening_inputs(model)
    } else {
        None
    };
    Ok(())
}
