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
use std::rc::Rc;

pub struct Session {
    pub ctx: Rc<GpuContext>,
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
    pub target_primaries: u32,
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
        check_raster_parity(&path);
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn staged_float_raster_android_binding_matches_cpu_export() {
        let path = std::env::temp_dir().join(format!(
            "maple-android-float-parity-{}.tiff",
            std::process::id()
        ));
        let _ = std::fs::remove_file(&path);
        let pixels: Vec<u8> = (0..64 * 48)
            .flat_map(|i| [1.2 + (i % 64) as f32 / 128.0, -0.1, 0.3005, 1.0])
            .flat_map(|v| half::f16::from_f32(v).to_bits().to_ne_bytes())
            .collect();
        crate::platform_raster::stage(
            &pixels,
            64,
            48,
            64 * 8,
            9,
            &crate::platform_raster::test_profile(moxcms::ColorProfile::new_srgb(), true),
            &path,
        )
        .unwrap();
        check_raster_parity(&path);
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn photo_switch_retains_worker_context_and_replaces_live_image() {
        let directory =
            std::env::temp_dir().join(format!("maple-worker-gpu-{}", std::process::id()));
        std::fs::create_dir_all(&directory).unwrap();
        let first = directory.join("first.png");
        let second = directory.join("second.png");
        image::RgbImage::from_pixel(64, 48, image::Rgb([80, 120, 200]))
            .save(&first)
            .unwrap();
        image::RgbImage::from_pixel(32, 24, image::Rgb([200, 80, 120]))
            .save(&second)
            .unwrap();
        let xml = "<rdf:Description xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\"/>";
        let first_session = Session::open(first.to_str().unwrap(), xml, 2048).unwrap();
        let context = Rc::clone(&first_session.ctx);
        first_session
            .live
            .render_to_buffer(&context, &first_session.inputs, &CancelToken::new())
            .unwrap()
            .unwrap();
        drop(first_session);
        let second_session =
            Session::open_with_context(Rc::clone(&context), second.to_str().unwrap(), xml, 2048)
                .unwrap();
        assert!(
            Rc::ptr_eq(&context, &second_session.ctx),
            "photo changes must retain the device and its caches"
        );
        assert_eq!(second_session.live.dims(), (32, 24));
        // The warm device must still render this different image against the CPU reference.
        check_session_raster_parity(second_session);
        std::fs::remove_dir_all(directory).unwrap();
    }

    fn check_raster_parity(path: &std::path::Path) {
        let xml = "<rdf:Description xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\"/>";
        check_session_raster_parity(Session::open(path.to_str().unwrap(), xml, 2048).unwrap());
    }

    fn check_session_raster_parity(mut session: Session) {
        for exposure in [0.0, 1.25, -1.5] {
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
                if session.target_primaries == 1 {
                    raw_core::view::encode::TargetPrimaries::P3
                } else {
                    raw_core::view::encode::TargetPrimaries::Srgb
                },
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
    }

    #[test]
    fn p3_android_target_matches_cpu_export() {
        let path =
            std::env::temp_dir().join(format!("maple-android-p3-{}.tiff", std::process::id()));
        let _ = std::fs::remove_file(&path);
        let pixels: Vec<u8> = (0..64 * 48)
            .flat_map(|i| [(i % 64) as f32 / 63.0, (i / 64) as f32 / 47.0, 0.05, 1.0])
            .flat_map(|value| half::f16::from_f32(value).to_bits().to_ne_bytes())
            .collect();
        crate::platform_raster::stage(
            &pixels,
            64,
            48,
            64 * 8,
            9,
            &crate::platform_raster::test_profile(moxcms::ColorProfile::new_display_p3(), true),
            &path,
        )
        .unwrap();
        let mut session = Session::open(
            path.to_str().unwrap(),
            "<rdf:Description xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\"/>",
            2048,
        )
        .unwrap();
        session.target_primaries = 1;
        check_session_raster_parity(session);
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
            let mut raster = AdjustmentModel::default();
            let allowed = [field.range.0, field.range.1].into_iter().all(|value| {
                crate::fields::set(&mut raster, index, value).unwrap();
                raw_core::pipeline::validate_raster_adjustments(&raster).is_ok()
            });
            assert_eq!(
                crate::fields::raster_allowed(index),
                allowed,
                "Raster availability: {}",
                field.name
            );
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
        let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
        let ext = std::path::Path::new(path)
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
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
            target_primaries: 0,
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
        self.inputs.target_primaries = self.target_primaries;
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
