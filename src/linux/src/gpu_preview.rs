//! Resident RAW preview integration slice of #4317.
//! Owned by one render worker on the native UI's shared device.
use raw_core::{
    gpu_host::{
        model::{prefix_matches, update_chain_inputs},
        prepare::{auto_will_fit, chain_inputs_with_status, develop_prefix_rgba_cancellable},
        GpuWhiteBalance,
    },
    types::adjustment::{AdjustmentModel, AutoExposureMode, Profile},
    RawImage,
};
use raw_gpu::{CancelToken, GpuContext, LiveSession, PresentGeometry, PresentTexture};

pub struct GpuPreview {
    session: LiveSession,
    target: PresentTexture,
    prefix: AdjustmentModel,
    white_balance: GpuWhiteBalance,
    inputs: raw_gpu::FullChainInputs<'static>,
    auto_fit: bool,
    sampling_scale: f32,
    long_edge: u32,
    uploads: u64,
}

impl GpuPreview {
    pub fn open(
        ctx: &GpuContext,
        raw: &RawImage,
        bytes: &[u8],
        ext: &str,
        model: &AdjustmentModel,
        long_edge: u32,
    ) -> Result<Self, String> {
        Self::open_cancellable(ctx, raw, bytes, ext, model, long_edge, &CancelToken::new())?
            .ok_or_else(|| "Fresh preview unexpectedly cancelled".into())
    }

    pub fn open_cancellable(
        ctx: &GpuContext,
        raw: &RawImage,
        bytes: &[u8],
        ext: &str,
        model: &AdjustmentModel,
        long_edge: u32,
        cancel: &CancelToken,
    ) -> Result<Option<Self>, String> {
        let result = Self::prepare(ctx, raw, bytes, ext, model, long_edge, cancel);
        if cancel.is_cancelled() {
            return Ok(None);
        }
        result.map(Some)
    }

    fn prepare(
        ctx: &GpuContext,
        raw: &RawImage,
        bytes: &[u8],
        ext: &str,
        model: &AdjustmentModel,
        long_edge: u32,
        cancel: &CancelToken,
    ) -> Result<Self, String> {
        if cancel.is_cancelled() {
            return Err("Preview cancelled".into());
        }
        Self::validate(model)?;
        let long_edge = long_edge
            .max(1)
            .min(ctx.device.limits().max_texture_dimension_2d);
        let (pixels, width, height, prefix, whites_anchor, sampling_scale) =
            develop_prefix_rgba_cancellable(
                raw,
                bytes,
                ext,
                model,
                long_edge,
                raw_core::CancelToken::new(cancel.flag()),
            )?;
        if cancel.is_cancelled() {
            return Err("Preview cancelled".into());
        }
        let session = LiveSession::new(ctx, &pixels, width, height)?;
        let film = crate::film::resolve(&model.film_look)?;
        let display_dims = if raw.orientation.swaps_wh() {
            (height, width)
        } else {
            (width, height)
        };
        let crop = raw_core::stages::crop::CropPresentation::new(
            &model.crop,
            display_dims.0,
            display_dims.1,
        );
        let target = PresentTexture::new(ctx, crop.dims)?;
        let (inputs, _) = chain_inputs_with_status(
            raw,
            bytes,
            ext,
            model,
            film.as_ref().map(|film| film.lut),
            film.as_ref().map_or(0, |film| film.key),
            whites_anchor,
        );
        Ok(Self {
            session,
            target,
            prefix,
            white_balance: GpuWhiteBalance::resolve(raw)?,
            inputs,
            auto_fit: auto_will_fit(model, bytes, ext),
            sampling_scale,
            long_edge,
            uploads: 1,
        })
    }

    /// Edits the GPU preview cannot draw yet; they fall back per frame, not per session.
    pub fn validate(model: &AdjustmentModel) -> Result<(), String> {
        let curves = [
            &model.tone_curve_luma,
            &model.tone_curve_red,
            &model.tone_curve_green,
            &model.tone_curve_blue,
            &model.display_tone_curve_luma,
            &model.display_tone_curve_red,
            &model.display_tone_curve_green,
            &model.display_tone_curve_blue,
        ];
        if curves
            .iter()
            .any(|curve| !raw_gpu::point_curve_fits_gpu(&curve.points))
        {
            return Err(
                "An imported tone curve exceeds the GPU preview's control-point capacity".into(),
            );
        }
        let crop = raw_core::stages::crop::CropPresentation::new(&model.crop, 1, 1);
        if crop.resamples
            && !raw_core::stages::perspective::Perspective::from_model(model).is_identity()
        {
            return Err(
                "Combined perspective and straighten GPU sampling is pending (#4317)".into(),
            );
        }
        crate::film::resolve(&model.film_look)?;
        Ok(())
    }

    pub fn target(&self) -> &PresentTexture {
        &self.target
    }
    pub fn upload_count(&self) -> u64 {
        self.uploads
    }
    pub fn pool_alloc_count(&self, ctx: &GpuContext) -> u64 {
        self.session.pool_alloc_count(ctx)
    }

    /// Returns false for a superseded render; no CPU image readback occurs.
    /// Auto-fit/noise buffers and the source-byte AE decision are retained across
    /// ticks. Curve/layer/mask storage is reused and prefix comparison borrows;
    /// the full chain still requires allocation qualification
    /// before #4317 performance acceptance.
    pub fn render(
        &mut self,
        ctx: &GpuContext,
        raw: &RawImage,
        bytes: &[u8],
        ext: &str,
        model: &AdjustmentModel,
        cancel: &CancelToken,
    ) -> Result<bool, String> {
        if cancel.is_cancelled() {
            return Ok(false);
        }
        Self::validate(model)?;
        let ae = if self.auto_fit && model.profile == Profile::Auto {
            AutoExposureMode::Off
        } else {
            model.auto_exposure
        };
        if !prefix_matches(model, &self.prefix, ae) {
            // Prepare replacement resources before dropping the last valid frame.
            let Some(replacement) =
                Self::open_cancellable(ctx, raw, bytes, ext, model, self.long_edge, cancel)?
            else {
                return Ok(false);
            };
            let uploads = self.uploads + 1;
            *self = replacement;
            self.uploads = uploads;
        }
        let film = crate::film::resolve(&model.film_look)?;
        let key = film.as_ref().map_or(0, |film| film.key);
        if self.inputs.film_lut_key != key {
            self.inputs.film_lut_key = key;
            self.inputs.film_lut_size = film.as_ref().map_or(0, |film| film.lut.size as u32);
            // Embedded, immutable lattices have a static lifetime. A look switch
            // updates the binding without cloning the lattice or RAW prefix.
            self.inputs.film_lut_data = std::borrow::Cow::Borrowed(
                film.as_ref().map_or(&[], |film| film.lut.data.as_slice()),
            );
        }
        update_chain_inputs(model, &mut self.inputs);
        self.white_balance.apply(model, &mut self.inputs);
        self.inputs.nr_sampling_scale = self.sampling_scale;
        self.inputs.target_primaries = 0; // Native UNORM texture carries sRGB display bytes.
        let Some(index) = self
            .session
            .render_chain_to_f32(ctx, &self.inputs, cancel)?
        else {
            return Ok(false);
        };
        let geometry = raw_core::stages::perspective::Perspective::from_model(model);
        let (sw, sh) = self.session.dims();
        let (width, height) = if raw.orientation.swaps_wh() {
            (sh, sw)
        } else {
            (sw, sh)
        };
        let crop = raw_core::stages::crop::CropPresentation::new(&model.crop, width, height);
        let inverse =
            geometry.inverse_matrix(raw_core::stages::perspective::aspect_ratio(width, height));
        let orientation =
            raw_core::stages::perspective::Homography(raw.orientation.display_to_sensor_matrix());
        let transform =
            PresentGeometry::from_inverse(orientation.mul(&inverse).mul(&crop.inverse).0);
        if cancel.is_cancelled() {
            return Ok(false);
        }
        self.target.present(ctx, &self.session, index, transform)?;
        Ok(true)
    }
}
