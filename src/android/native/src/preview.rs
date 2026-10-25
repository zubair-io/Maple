use raw_core::{
    gpu_host::{
        capture::{develop_capture_prefix_rgba_cancellable, LiveCreative},
        model::{build_full_chain_inputs, update_chain_inputs, NoiseProfileInputs},
        prepare::{auto_will_fit, chain_inputs_with_status},
    },
    types::AdjustmentModel,
    ExifOrientation, RawImage,
};
use raw_gpu::{CancelToken, FullChainInputs, GpuContext, LiveSession, PresentGeometry};
use std::{rc::Rc, sync::Arc};

#[path = "prefix_preparation.rs"]
mod preparation;
pub use preparation::Preparation;

/// A RAW photo uploads its capture decode (#5380) in sensor framing and binds
/// the decode's creative stage to every tick; a raster uploads its upright
/// pixels and keeps the white-balance pass.
pub struct Session {
    pub ctx: Rc<GpuContext>,
    pub model: AdjustmentModel,
    raw: Option<Arc<RawImage>>,
    bytes: Arc<Vec<u8>>,
    ext: String,
    detail: std::sync::OnceLock<crate::native_detail::SharedDetail>,
    prefix: AdjustmentModel,
    creative: Option<LiveCreative>,
    live: LiveSession,
    inputs: FullChainInputs<'static>,
    sampling: f32,
    edge: u32,
    auto_fit: bool,
    profile: raw_core::types::Profile,
    pub target_primaries: u32,
    #[cfg(target_os = "android")]
    pub surface: Option<raw_gpu::AndroidPresentSurface>,
}

#[cfg(test)]
#[path = "capture_preview_tests.rs"]
mod capture_preview_tests;
#[cfg(test)]
#[path = "capture_seam_tests.rs"]
mod capture_seam_tests;
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

/// The model the first frame is decoded at: capture sharpening refines on
/// the CPU after open, so opening never waits for it.
#[allow(deprecated)]
fn without_capture(model: &AdjustmentModel) -> AdjustmentModel {
    let defaults = AdjustmentModel::default();
    AdjustmentModel {
        capture_sharpening_amount: 0.,
        capture_sharpening_sigma: defaults.capture_sharpening_sigma,
        capture_sharpening_radius: defaults.capture_sharpening_radius,
        ..model.clone()
    }
}

fn capture_inputs(
    raw: &RawImage,
    bytes: &[u8],
    ext: &str,
    model: &AdjustmentModel,
    whites_anchor_ev: f32,
) -> Result<FullChainInputs<'static>, String> {
    let film = crate::film::resolve(&model.film_look)?;
    Ok(chain_inputs_with_status(
        raw,
        bytes,
        ext,
        model,
        film.map(|f| f.0),
        film.map_or(0, |f| f.1),
        whites_anchor_ev,
    )
    .0)
}

/// The slider pair `model` resolves to in the decode's slider frame.
fn slider_values(creative: &LiveCreative, model: &AdjustmentModel) -> (f32, f32) {
    let tick = creative.header.tick(model);
    (tick.temperature, tick.tint)
}

/// One tick's inputs. Allocates nothing beyond the reused curve and layer
/// storage `update_chain_inputs` refreshes in place.
fn update_inputs(
    model: &AdjustmentModel,
    inputs: &mut FullChainInputs<'static>,
    creative: Option<&LiveCreative>,
    sampling: f32,
    target: u32,
) -> Result<(), String> {
    update_chain_inputs(model, inputs);
    let film = crate::film::resolve(&model.film_look)?;
    inputs.film_lut_size = film.map_or(0, |f| f.0.size as u32);
    inputs.film_lut_key = film.map_or(0, |f| f.1);
    inputs.film_lut_data = std::borrow::Cow::Borrowed(film.map_or(&[], |f| f.0.data.as_slice()));
    if let Some(creative) = creative {
        creative.apply(model, inputs)?;
    }
    inputs.nr_sampling_scale = sampling;
    inputs.target_primaries = target;
    Ok(())
}

impl Session {
    pub fn detail_source(&self) -> crate::native_detail::SharedDetail {
        Arc::clone(self.detail.get_or_init(|| {
            crate::native_detail::DetailSource::new(
                self.raw.clone(),
                Arc::clone(&self.bytes),
                self.ext.clone(),
            )
        }))
    }
    pub fn source_is_raw(&self) -> bool {
        self.raw.is_some()
    }
    pub fn white_balance_values(&self) -> (f32, f32) {
        self.creative
            .as_ref()
            .map_or((self.model.temperature, self.model.tint), |creative| {
                slider_values(creative, &self.model)
            })
    }

    pub fn as_shot_white_balance_values(&self) -> (f32, f32) {
        let as_shot = AdjustmentModel::default();
        self.creative
            .as_ref()
            .map_or((as_shot.temperature, as_shot.tint), |creative| {
                slider_values(creative, &as_shot)
            })
    }
    fn orientation(&self) -> ExifOrientation {
        self.raw
            .as_ref()
            .map_or(ExifOrientation::Normal, |raw| raw.orientation)
    }
    fn oriented_dims(&self) -> (u32, u32) {
        let (w, h) = self.live.dims();
        if self.orientation().swaps_wh() {
            (h, w)
        } else {
            (w, h)
        }
    }
    pub fn uncropped_aspect(&self) -> f32 {
        let (w, h) = self.oriented_dims();
        w as f32 / h.max(1) as f32
    }
    pub fn aspect(&self) -> f32 {
        let (w, h) = self.oriented_dims();
        let crop = raw_core::stages::crop::CropPresentation::new(&self.model.crop, w, h);
        crop.dims.0 as f32 / crop.dims.1.max(1) as f32
    }
    #[cfg(test)]
    pub fn open(path: &str, xml: &str, edge: u32) -> Result<Self, String> {
        Self::open_with_context(Rc::new(GpuContext::new_blocking()?), path, xml, edge)
    }

    pub fn prepare_auto_white_balance(
        &self,
        xml: &str,
    ) -> Result<crate::auto_white_balance::AutoWhiteBalanceWork, String> {
        let raw = self
            .raw
            .clone()
            .ok_or("Auto white balance requires a RAW photo")?;
        crate::auto_white_balance::AutoWhiteBalanceWork::new(raw, xml)
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
            Some(
                raw_core::decode_cache::decode_bytes_cached(
                    &raw_core::decode_cache::CacheKey::from_bytes(&bytes),
                    &bytes,
                    &ext,
                )
                .map_err(|e| e.to_string())?,
            )
        } else {
            None
        };
        let (live, prefix, inputs, sampling, creative) = match &raw {
            Some(raw) => {
                let capture = develop_capture_prefix_rgba_cancellable(
                    raw,
                    &bytes,
                    &ext,
                    &without_capture(&model),
                    edge,
                    raw_core::CancelToken::never(),
                )?;
                let inputs = capture_inputs(raw, &bytes, &ext, &model, capture.whites_anchor_ev)?;
                (
                    LiveSession::new(&ctx, &capture.rgba, capture.width, capture.height)?,
                    capture.prefix_model,
                    inputs,
                    capture.nr_sampling_scale,
                    Some(capture.creative),
                )
            }
            None => {
                raw_core::pipeline::validate_raster_adjustments(&model)
                    .map_err(|e| e.to_string())?;
                let (w, h, pixels) = raw_core::pipeline::decode_raster_base(
                    &bytes,
                    edge,
                    raw_core::CancelToken::never(),
                )
                .map_err(|e| e.to_string())?;
                let film = crate::film::resolve(&model.film_look)?;
                let inputs = FullChainInputs {
                    input_shape: raw_gpu::InputShape::LinearRec2020Fp16,
                    ..build_full_chain_inputs(
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
                    )
                };
                (
                    LiveSession::new(&ctx, &pixels, w, h)?,
                    model.clone(),
                    inputs,
                    1.0,
                    None,
                )
            }
        };
        let auto_fit = auto_will_fit(&model, &bytes, &ext);
        let profile = model.profile;
        Ok(Self {
            ctx,
            model,
            raw,
            bytes,
            ext,
            prefix,
            detail: std::sync::OnceLock::new(),
            creative,
            live,
            inputs,
            sampling,
            edge,
            auto_fit,
            profile,
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

    /// Renders the resident decode; a pending CPU preparation keeps showing
    /// the last prepared capture until it lands. GPU capture-stage feedback
    /// during that wait is the capture refine of #5381.
    pub fn update_gpu(&mut self, cancel: &CancelToken) -> Result<Option<usize>, String> {
        if cancel.is_cancelled() {
            return Ok(None);
        }
        update_inputs(
            &self.model,
            &mut self.inputs,
            self.creative.as_ref(),
            self.sampling,
            self.target_primaries,
        )?;
        self.live
            .render_chain_to_f32(&self.ctx, &self.inputs, cancel)
    }

    pub fn frame_parts(&self) -> (&LiveSession, &FullChainInputs<'static>) {
        (&self.live, &self.inputs)
    }

    pub fn geometry(&self) -> PresentGeometry {
        use raw_core::stages::perspective::{aspect_ratio, Homography, Perspective};
        let (w, h) = self.oriented_dims();
        let crop = raw_core::stages::crop::CropPresentation::new(&self.model.crop, w, h);
        let transform = Homography(self.orientation().display_to_sensor_matrix())
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
            &self.live,
            index,
            self.geometry(),
        )?;
        Ok(!cancel.is_cancelled())
    }
}
