//! Resident CPU detail viewport (#4352/#4112). Binding owns RAW/source custody.
use super::{
    display_prefix, finish, render_display_scene_with_context_cancellable, DetailContext, RawInput,
};
use crate::{
    cancel::CancelToken,
    error::{Error, Result},
    film::FilmLut,
    image::{Image, RawImage},
    pipeline::RenderQuality,
    view::{auto_profile, encode},
    xmp::AdjustmentModel,
};

pub struct CpuPreview {
    prefix: Image,
    working: Image,
    context: DetailContext,
    key: AdjustmentModel,
    quality: RenderQuality,
    cap: u32,
    film: Option<FilmLut>,
    source: SourceIdentity,
    uncurved_details: Option<(f32, f32, f32)>,
}
impl CpuPreview {
    pub fn open(
        raw: &RawImage,
        source: RawInput<'_>,
        model: AdjustmentModel,
        quality: RenderQuality,
        cap: u32,
        film: Option<&FilmLut>,
    ) -> Result<(Self, u32, u32, Vec<u8>, Option<bool>)> {
        let (working, context, prefix) = render_display_scene_with_context_cancellable(
            raw,
            &model,
            quality,
            Some(source),
            Some(cap),
            encode::TargetPrimaries::Srgb,
            film,
            CancelToken::never(),
            true,
        )?;
        // Auto2's canonical pinned-default route applies only its baked LUT;
        // edited models replay the returned curve, including identity rounding.
        // Derive this route once, without constructing default models per tick.
        let pinned = super::auto_fit::fit_develop_model(&model);
        let pinned_amounts = (pinned.sharpen_amount, pinned.nr_luminance, pinned.nr_color);
        let uncurved_details = (!auto_profile::apply_pipeline::auto1_enabled_by_env()
            && upstream_key(context.active_model.clone()) == upstream_key(pinned))
        .then_some(pinned_amounts);
        let mut session = Self {
            prefix: prefix.expect("capture requested"),
            working,
            context,
            key: upstream_key(model),
            quality,
            cap,
            film: film.cloned(),
            source: SourceIdentity::new(raw, source),
            uncurved_details,
        };
        let (w, h, pixels, fit) = session.pack(raw);
        Ok((session, w, h, pixels, fit))
    }
    pub fn render(
        &mut self,
        raw: &RawImage,
        source: RawInput<'_>,
        model: AdjustmentModel,
        quality: RenderQuality,
        cap: u32,
        film: Option<&FilmLut>,
        cancel: CancelToken<'_>,
    ) -> Result<(u32, u32, Vec<u8>, Option<bool>)> {
        if cancel.is_cancelled() {
            return Err(Error::Cancelled);
        }
        let amounts = (model.sharpen_amount, model.nr_luminance, model.nr_color);
        let key = upstream_key(model);
        if !self.source.matches(raw, source)
            || key != self.key
            || quality != self.quality
            || cap != self.cap
            || film != self.film.as_ref()
            || self.prefix.pixels.is_empty()
        {
            // This prefix is invalid for the requested model. Release its
            // allocations before a full sensor develop; a failed rebuild is
            // explicitly empty and the next request must prepare again.
            self.prefix.pixels = Vec::new();
            self.working.pixels = Vec::new();
            let (replacement, w, h, pixels, fit) =
                Self::open(raw, source, with_amounts(key, amounts), quality, cap, film)?;
            if cancel.is_cancelled() {
                return Err(Error::Cancelled);
            }
            *self = replacement;
            return Ok((w, h, pixels, fit));
        }
        let model = with_amounts(key, amounts);
        self.working.pixels.copy_from_slice(&self.prefix.pixels);
        self.working.space = self.prefix.space;
        self.working.whites_anchor_ev = self.prefix.whites_anchor_ev;
        self.working.nr_sampling_scale = self.prefix.nr_sampling_scale;
        super::super::sized_detail::apply(&mut self.working, raw, &model, cancel)?;
        let full = (self.working.width, self.working.height);
        display_prefix::apply_retained(
            &mut self.working,
            &model,
            film,
            encode::TargetPrimaries::Srgb,
            ((0, 0), full),
        );
        let pixels = bytemuck::cast_slice_mut(&mut self.working.pixels);
        if self.uncurved_details != Some(amounts) {
            if let Some(curve) = &self.context.profile_curve {
                auto_profile::apply_curve(pixels, curve);
            }
        }
        if let Some(lut) = &self.context.profile_lut {
            lut.apply_with_strength(pixels, auto_profile::lut::lut_strength_from_env());
        }
        if self.context.auto_guard {
            encode::gamut_guard_display_encoded_srgb(&mut self.working);
        }
        if cancel.is_cancelled() {
            return Err(Error::Cancelled);
        }
        self.context.model = model;
        Ok(self.pack(raw))
    }
    fn pack(&mut self, raw: &RawImage) -> (u32, u32, Vec<u8>, Option<bool>) {
        let pixels = encode::dither_and_quantize(&mut self.working);
        let (w, h, pixels) = finish::apply_geometry(
            pixels,
            self.working.width,
            self.working.height,
            raw.orientation,
            &crate::stages::perspective::Perspective::from_model(&self.context.model),
            &self.context.model.crop,
        );
        let fit = (self.context.model.profile == crate::types::adjustment::Profile::Auto)
            .then_some(self.context.profile_curve.is_some() || self.context.profile_lut.is_some());
        (w, h, pixels, fit)
    }
}
fn upstream_key(model: AdjustmentModel) -> AdjustmentModel {
    AdjustmentModel {
        sharpen_amount: 0.0,
        nr_luminance: 0.0,
        nr_color: 0.0,
        ..model
    }
}
fn with_amounts(model: AdjustmentModel, amounts: (f32, f32, f32)) -> AdjustmentModel {
    AdjustmentModel {
        sharpen_amount: amounts.0,
        nr_luminance: amounts.1,
        nr_color: amounts.2,
        ..model
    }
}

#[cfg(all(test, feature = "test-support"))]
#[path = "cpu_preview_tests.rs"]
mod tests;

// Source bytes and decoded metadata are immutable in the owning WASM session.
// These identities reject accidentally borrowing another decoded source; no
// 100MP file hash is recomputed in the slider loop.
struct SourceIdentity {
    samples: usize,
    sample_count: usize,
    dimensions: (u32, u32),
    orientation: crate::image::ExifOrientation,
    crop: Option<crate::image::CropRect>,
    input: SourceInput,
}
enum SourceInput {
    Bytes {
        pointer: usize,
        length: usize,
        ext: String,
    },
    Path(std::path::PathBuf),
}
impl SourceIdentity {
    fn new(raw: &RawImage, source: RawInput<'_>) -> Self {
        Self {
            samples: raw.raw_data.as_ptr() as usize,
            sample_count: raw.raw_data.len(),
            dimensions: (raw.width, raw.height),
            orientation: raw.orientation,
            crop: raw.crop_rect,
            input: match source {
                RawInput::Bytes { bytes, ext } => SourceInput::Bytes {
                    pointer: bytes.as_ptr() as usize,
                    length: bytes.len(),
                    ext: ext.to_owned(),
                },
                RawInput::Path(path) => SourceInput::Path(path.to_owned()),
            },
        }
    }
    fn matches(&self, raw: &RawImage, source: RawInput<'_>) -> bool {
        self.samples == raw.raw_data.as_ptr() as usize
            && self.sample_count == raw.raw_data.len()
            && self.dimensions == (raw.width, raw.height)
            && self.orientation == raw.orientation
            && self.crop == raw.crop_rect
            && match (&self.input, source) {
                (
                    SourceInput::Bytes {
                        pointer,
                        length,
                        ext,
                    },
                    RawInput::Bytes { bytes, ext: actual },
                ) => *pointer == bytes.as_ptr() as usize && *length == bytes.len() && ext == actual,
                (SourceInput::Path(path), RawInput::Path(actual)) => path == actual,
                _ => false,
            }
    }
}
