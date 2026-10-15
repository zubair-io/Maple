use raw_core::{
    gpu_host::{
        model::{build_full_chain_inputs, update_chain_inputs, NoiseProfileInputs},
        prepare::{auto_will_fit, chain_inputs_with_status, develop_prefix_rgba},
        GpuWhiteBalance,
    },
    types::AdjustmentModel,
    ExifOrientation, RawImage,
};
use raw_gpu::{CancelToken, FullChainInputs, GpuContext, LiveSession, PresentGeometry};
use std::{rc::Rc, sync::Arc};

#[path = "prefix_preparation.rs"]
mod preparation;
pub use preparation::Preparation;
#[path = "fast_preview.rs"]
mod fast_preview;
use fast_preview::{without_capture, FastPreview};

pub struct Session {
    pub ctx: Rc<GpuContext>,
    pub model: AdjustmentModel,
    raw: Option<Arc<RawImage>>,
    bytes: Arc<Vec<u8>>,
    ext: String,
    prefix: AdjustmentModel,
    wb: Option<GpuWhiteBalance>,
    live: LiveSession,
    inputs: FullChainInputs<'static>,
    sampling: f32,
    edge: u32,
    auto_fit: bool,
    profile: raw_core::types::Profile,
    fast: Option<FastPreview>,
    active_fast: bool,
    pub target_primaries: u32,
    #[cfg(target_os = "android")]
    pub surface: Option<raw_gpu::AndroidPresentSurface>,
}

#[cfg(test)]
#[path = "capture_preview_tests.rs"]
mod capture_preview_tests;
#[cfg(test)]
#[path = "preview_interactive_tests.rs"]
mod interactive_tests;
#[cfg(test)]
#[path = "preview_tests.rs"]
mod tests;

pub fn is_raw(ext: &str) -> bool {
    matches!(
        ext,
        "cr2"
            | "cr3"
            | "nef"
            | "arw"
            | "dng"
            | "raf"
            | "orf"
            | "rw2"
            | "pef"
            | "srw"
            | "x3f"
            | "3fr"
            | "mef"
            | "erf"
            | "mrw"
            | "raw"
            | "fff"
    )
}

impl Session {
    pub fn source_is_raw(&self) -> bool {
        self.raw.is_some()
    }
    pub fn white_balance_values(&self) -> (f32, f32) {
        self.wb
            .as_ref()
            .map_or((self.model.temperature, self.model.tint), |wb| {
                wb.slider_values(&self.model)
            })
    }

    pub fn as_shot_white_balance_values(&self) -> (f32, f32) {
        let as_shot = AdjustmentModel::default();
        self.wb
            .as_ref()
            .map_or((as_shot.temperature, as_shot.tint), |wb| {
                wb.slider_values(&as_shot)
            })
    }
    pub fn aspect(&self) -> f32 {
        let (w, h) = self.live.dims();
        let orientation = self
            .raw
            .as_ref()
            .map_or(ExifOrientation::Normal, |raw| raw.orientation);
        let (w, h) = if orientation.swaps_wh() {
            (h, w)
        } else {
            (w, h)
        };
        let crop = raw_core::stages::crop::CropPresentation::new(&self.model.crop, w, h);
        crop.dims.0 as f32 / crop.dims.1.max(1) as f32
    }
    #[cfg(test)]
    pub fn open(path: &str, xml: &str, edge: u32) -> Result<Self, String> {
        Self::open_with_context(Rc::new(GpuContext::new_blocking()?), path, xml, edge)
    }

    pub fn open_with_context(
        ctx: Rc<GpuContext>,
        path: &str,
        xml: &str,
        edge: u32,
    ) -> Result<Self, String> {
        let model = crate::xmp::parse(xml)?;
        let bytes = Arc::new(std::fs::read(path).map_err(|e| e.to_string())?);
        let ext = std::path::Path::new(path)
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        let edge = edge.clamp(1, ctx.device.limits().max_texture_dimension_2d);
        let raw = if is_raw(&ext) {
            Some(Arc::new(
                raw_core::decode::decode_bytes(&bytes, &ext).map_err(|e| e.to_string())?,
            ))
        } else {
            None
        };
        let base_model = without_capture(&model);
        let (pixels, w, h, prefix, anchor, sampling) = if let Some(raw) = &raw {
            develop_prefix_rgba(raw, &bytes, &ext, &base_model, edge)?
        } else {
            raw_core::pipeline::validate_raster_adjustments(&model).map_err(|e| e.to_string())?;
            let (w, h, pixels) = raw_core::pipeline::decode_raster_base(
                &bytes,
                edge,
                raw_core::CancelToken::never(),
            )
            .map_err(|e| e.to_string())?;
            (pixels, w, h, model.clone(), 0.0, 1.0)
        };
        let film = crate::film::resolve(&model.film_look)?;
        let inputs = if let Some(raw) = &raw {
            chain_inputs_with_status(
                raw,
                &bytes,
                &ext,
                &model,
                film.map(|f| f.0),
                film.map_or(0, |f| f.1),
                anchor,
            )
            .0
        } else {
            let mut inputs = build_full_chain_inputs(
                &model,
                vec![],
                0,
                vec![],
                NoiseProfileInputs {
                    profile: vec![],
                    iso: 0,
                },
                film.map(|f| f.0),
                film.map_or(0, |f| f.1),
                0.0,
                1,
            );
            inputs.input_shape = raw_gpu::InputShape::LinearRec2020Fp16;
            inputs
        };
        let wb = raw
            .as_ref()
            .map(|raw| GpuWhiteBalance::resolve(raw))
            .transpose()?;
        let live = LiveSession::new(&ctx, &pixels, w, h)?;
        let fast = raw
            .as_ref()
            .map(|raw| {
                let inputs = chain_inputs_with_status(
                    raw,
                    &bytes,
                    &ext,
                    &base_model,
                    film.map(|f| f.0),
                    film.map_or(0, |f| f.1),
                    anchor,
                )
                .0;
                FastPreview::new(&ctx, &pixels, w, h, prefix.clone(), inputs, sampling)
            })
            .transpose()?;
        let auto_fit = auto_will_fit(&model, &bytes, &ext);
        let profile = model.profile;
        Ok(Self {
            ctx,
            model,
            raw,
            bytes,
            ext,
            prefix,
            wb,
            live,
            inputs,
            sampling,
            edge,
            auto_fit,
            profile,
            fast,
            active_fast: false,
            target_primaries: 0,
            #[cfg(target_os = "android")]
            surface: None,
        })
    }

    #[cfg(test)]
    pub fn update(&mut self) -> Result<usize, String> {
        let cancel = CancelToken::new();
        if let Some(mut preparation) = self.preparation() {
            preparation.run(&cancel)?;
            self.apply_preparation(&mut preparation, &cancel)?;
        }
        self.update_gpu(&cancel)?
            .ok_or_else(|| "Render cancelled".into())
    }

    pub fn update_gpu(&mut self, cancel: &CancelToken) -> Result<Option<usize>, String> {
        if cancel.is_cancelled() {
            return Ok(None);
        }
        self.active_fast = self.needs_preparation() && self.fast.is_some();
        if self.active_fast {
            let fast = self.fast.as_mut().unwrap();
            fast_preview::update_inputs(
                &self.model,
                &mut fast.inputs,
                self.wb.as_ref(),
                fast.sampling,
                self.target_primaries,
                true,
            )?;
            fast.live
                .render_chain_to_f32(&self.ctx, &fast.inputs, cancel)
        } else {
            fast_preview::update_inputs(
                &self.model,
                &mut self.inputs,
                self.wb.as_ref(),
                self.sampling,
                self.target_primaries,
                false,
            )?;
            self.live
                .render_chain_to_f32(&self.ctx, &self.inputs, cancel)
        }
    }

    pub fn frame_parts(&self) -> (&LiveSession, &FullChainInputs<'static>) {
        if self.active_fast {
            let fast = self.fast.as_ref().unwrap();
            (&fast.live, &fast.inputs)
        } else {
            (&self.live, &self.inputs)
        }
    }

    pub fn geometry(&self) -> PresentGeometry {
        use raw_core::stages::perspective::{aspect_ratio, Homography, Perspective};
        let orientation = self
            .raw
            .as_ref()
            .map_or(ExifOrientation::Normal, |raw| raw.orientation);
        let (w, h) = self.frame_parts().0.dims();
        let (w, h) = if orientation.swaps_wh() {
            (h, w)
        } else {
            (w, h)
        };
        let crop = raw_core::stages::crop::CropPresentation::new(&self.model.crop, w, h);
        let transform = Homography(orientation.display_to_sensor_matrix())
            .mul(&Perspective::from_model(&self.model).inverse_matrix(aspect_ratio(w, h)))
            .mul(&crop.inverse);
        if transform == Homography::IDENTITY {
            PresentGeometry::IDENTITY
        } else {
            PresentGeometry::from_inverse(transform.0)
        }
    }

    #[cfg(target_os = "android")]
    pub fn render(&mut self, cancel: &CancelToken) -> Result<bool, String> {
        let Some(index) = self.update_gpu(cancel)? else {
            return Ok(false);
        };
        if cancel.is_cancelled() {
            return Ok(false);
        }
        self.surface.as_ref().ok_or("No Android surface")?.present(
            &self.ctx,
            self.frame_parts().0,
            index,
            self.geometry(),
        )?;
        Ok(!cancel.is_cancelled())
    }
}
