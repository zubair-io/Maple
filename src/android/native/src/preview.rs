use raw_core::{
    gpu_host::{
        model::{build_full_chain_inputs, prefix_matches, update_chain_inputs, NoiseProfileInputs},
        prepare::{auto_will_fit, chain_inputs_with_status, develop_prefix_rgba},
        GpuWhiteBalance,
    },
    types::AdjustmentModel,
    ExifOrientation, RawImage,
};
use raw_gpu::{CancelToken, FullChainInputs, GpuContext, LiveSession, PresentGeometry};

pub struct Session {
    pub ctx: GpuContext,
    pub model: AdjustmentModel,
    raw: Option<RawImage>,
    bytes: Vec<u8>,
    ext: String,
    prefix: AdjustmentModel,
    wb: Option<GpuWhiteBalance>,
    live: LiveSession,
    inputs: FullChainInputs<'static>,
    sampling: f32,
    edge: u32,
    auto_fit: bool,
    profile: raw_core::types::Profile,
    #[cfg(target_os = "android")]
    pub surface: Option<raw_gpu::AndroidPresentSurface>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn raster_android_binding_matches_cpu_export() {
        let path =
            std::env::temp_dir().join(format!("maple-android-parity-{}.png", std::process::id()));
        image::RgbImage::from_fn(64, 48, |x, y| {
            image::Rgb([(x * 4) as u8, (y * 5) as u8, 110])
        })
        .save(&path)
        .unwrap();
        let xml = "<rdf:Description xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\"/>";
        let mut session = Session::open(path.to_str().unwrap(), xml, 2048).unwrap();
        for exposure in [0.0, 1.25] {
            let field = raw_core::types::ADJUSTMENT_SCHEMA
                .iter()
                .position(|f| f.name == "exposure")
                .unwrap();
            crate::fields::set(&mut session.model, field, exposure).unwrap();
            session.update().unwrap();
            let gpu = session
                .live
                .render_to_buffer(&session.ctx, &session.inputs, &CancelToken::new())
                .unwrap()
                .unwrap();
            let (w, h, cpu) = raw_core::pipeline::render_export_raster(
                &session.bytes,
                &session.model,
                None,
                raw_core::view::encode::TargetPrimaries::Srgb,
                raw_core::pipeline::ExportDepth::Eight,
                None,
            )
            .unwrap();
            let raw_core::pipeline::ExportPixels::Eight(cpu) = cpu else {
                panic!("eight-bit export");
            };
            assert_eq!(session.live.dims(), (w, h));
            let worst = gpu
                .iter()
                .zip(&cpu)
                .map(|(a, b)| a.abs_diff(*b))
                .max()
                .unwrap();
            assert!(
                worst <= 2,
                "Raster CPU/GPU byte difference {worst}, exposure {exposure}"
            );
        }
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn raw_android_binding_matches_cpu_reference_and_reuses_pool() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../test-fixtures/batch-transfer/source.dng");
        let xml = "<rdf:Description xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\"/>";
        let mut session = Session::open(path.to_str().unwrap(), xml, 2048).unwrap();
        for exposure in [0.0, 1.25, -0.75] {
            let field = raw_core::types::ADJUSTMENT_SCHEMA
                .iter()
                .position(|f| f.name == "exposure")
                .unwrap();
            crate::fields::set(&mut session.model, field, exposure).unwrap();
            session.update().unwrap();
            let gpu = session
                .live
                .render_to_buffer(&session.ctx, &session.inputs, &CancelToken::new())
                .unwrap()
                .unwrap();
            let raw = session.raw.as_ref().unwrap();
            let (w, h, cpu) = raw_core::pipeline::render_from_raw_with_quality_and_source(
                raw,
                &session.model,
                raw_core::pipeline::RenderQuality::Amaze,
                Some(raw_core::pipeline::RawInput::Bytes {
                    bytes: &session.bytes,
                    ext: &session.ext,
                }),
            )
            .unwrap();
            assert_eq!(session.live.dims(), (w, h));
            assert_eq!(gpu.len(), cpu.len());
            let worst = gpu
                .iter()
                .zip(&cpu)
                .map(|(a, b)| a.abs_diff(*b))
                .max()
                .unwrap();
            assert!(
                worst <= 2,
                "CPU/GPU maximum byte difference {worst}, exposure {exposure}"
            );
        }
        let allocations = session.live.pool_alloc_count(&session.ctx);
        session.update().unwrap();
        assert_eq!(allocations, session.live.pool_alloc_count(&session.ctx));
    }

    #[test]
    fn generated_scalar_access_validates_ranges_and_marks_manual_wb() {
        let mut model = AdjustmentModel::default();
        for (index, field) in raw_core::types::ADJUSTMENT_SCHEMA.iter().enumerate() {
            if field.kind != raw_core::types::FieldKind::F32 {
                continue;
            }
            crate::fields::set(&mut model, index, field.default_f32).unwrap();
            assert_eq!(crate::fields::get(&model, index), Some(field.default_f32));
            assert!(crate::fields::set(&mut model, index, f32::NAN).is_err());
        }
        assert!(model.temperature_seen && model.tint_seen);
        assert_eq!(model.wb_source, raw_core::types::WbSource::Manual);
    }
}

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
    pub fn white_balance_values(&self) -> (f32, f32) {
        self.wb
            .as_ref()
            .map_or((self.model.temperature, self.model.tint), |wb| {
                wb.slider_values(&self.model)
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
    pub fn open(path: &str, xml: &str, edge: u32) -> Result<Self, String> {
        let model = raw_core::xmp::parse(xml).map_err(|e| e.to_string())?;
        let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
        let ext = std::path::Path::new(path)
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        let ctx = GpuContext::new_blocking()?;
        let edge = edge.clamp(1, ctx.device.limits().max_texture_dimension_2d);
        let raw = if is_raw(&ext) {
            Some(raw_core::decode::decode_bytes(&bytes, &ext).map_err(|e| e.to_string())?)
        } else {
            None
        };
        let (pixels, w, h, prefix, anchor, sampling) = if let Some(raw) = &raw {
            develop_prefix_rgba(raw, &bytes, &ext, &model, edge)?
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
        let wb = raw.as_ref().map(GpuWhiteBalance::resolve).transpose()?;
        let live = LiveSession::new(&ctx, &pixels, w, h)?;
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
            #[cfg(target_os = "android")]
            surface: None,
        })
    }

    pub fn update(&mut self) -> Result<usize, String> {
        if let Some(raw) = &self.raw {
            let profile_changed = self.profile != self.model.profile;
            if profile_changed {
                self.auto_fit = auto_will_fit(&self.model, &self.bytes, &self.ext);
                self.profile = self.model.profile;
            }
            let ae = if self.auto_fit && self.model.profile == raw_core::types::Profile::Auto {
                raw_core::types::adjustment::AutoExposureMode::Off
            } else {
                self.model.auto_exposure
            };
            if profile_changed || !prefix_matches(&self.model, &self.prefix, ae) {
                let (pixels, w, h, prefix, anchor, sampling) =
                    develop_prefix_rgba(raw, &self.bytes, &self.ext, &self.model, self.edge)?;
                self.live = LiveSession::new(&self.ctx, &pixels, w, h)?;
                let film = crate::film::resolve(&self.model.film_look)?;
                self.inputs = chain_inputs_with_status(
                    raw,
                    &self.bytes,
                    &self.ext,
                    &self.model,
                    film.map(|f| f.0),
                    film.map_or(0, |f| f.1),
                    anchor,
                )
                .0;
                self.prefix = prefix;
                self.sampling = sampling;
            }
        }
        update_chain_inputs(&self.model, &mut self.inputs);
        let film = crate::film::resolve(&self.model.film_look)?;
        self.inputs.film_lut_size = film.map_or(0, |f| f.0.size as u32);
        self.inputs.film_lut_key = film.map_or(0, |f| f.1);
        self.inputs.film_lut_data =
            std::borrow::Cow::Borrowed(film.map_or(&[], |f| f.0.data.as_slice()));
        if let Some(wb) = &self.wb {
            wb.apply(&self.model, &mut self.inputs);
        }
        self.inputs.nr_sampling_scale = self.sampling;
        self.inputs.target_primaries = 0;
        self.live
            .render_chain_to_f32(&self.ctx, &self.inputs, &CancelToken::new())?
            .ok_or_else(|| "Render cancelled".into())
    }

    pub fn geometry(&self) -> PresentGeometry {
        use raw_core::stages::perspective::{aspect_ratio, Homography, Perspective};
        let orientation = self
            .raw
            .as_ref()
            .map_or(ExifOrientation::Normal, |raw| raw.orientation);
        let (w, h) = self.live.dims();
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
    pub fn render(&mut self) -> Result<(), String> {
        let index = self.update()?;
        self.surface.as_ref().ok_or("No Android surface")?.present(
            &self.ctx,
            &self.live,
            index,
            self.geometry(),
        )
    }
}
