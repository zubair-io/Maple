//! Pure CPU refinement owns immutable source Arcs; it never borrows GPU state.
use super::*;
use raw_core::gpu_host::prefix::pixel_prefix_matches;

pub struct Preparation {
    raw: Arc<RawImage>,
    bytes: Arc<Vec<u8>>,
    ext: String,
    model: AdjustmentModel,
    edge: u32,
    result: Option<Prepared>,
}

struct Prepared {
    pixels: Vec<f32>,
    width: u32,
    height: u32,
    prefix: AdjustmentModel,
    inputs: FullChainInputs<'static>,
    sampling: f32,
    creative: LiveCreative,
    auto_fit: bool,
}

impl Session {
    fn effective_ae(&self) -> raw_core::types::adjustment::AutoExposureMode {
        if self.auto_fit && self.model.profile == raw_core::types::Profile::Auto {
            raw_core::types::adjustment::AutoExposureMode::Off
        } else {
            self.model.auto_exposure
        }
    }
    pub fn needs_preparation(&self) -> bool {
        self.raw.is_some()
            && (self.model.profile != self.profile
                || !pixel_prefix_matches(&self.model, &self.prefix, self.effective_ae()))
    }
    pub fn preparation(&self) -> Option<Preparation> {
        if !self.needs_preparation() {
            return None;
        }
        Some(Preparation {
            raw: Arc::clone(self.raw.as_ref()?),
            bytes: Arc::clone(&self.bytes),
            ext: self.ext.clone(),
            model: self.model.clone(),
            edge: self.edge,
            result: None,
        })
    }
    pub fn apply_preparation(
        &mut self,
        preparation: &mut Preparation,
        cancel: &CancelToken,
    ) -> Result<bool, String> {
        if cancel.is_cancelled()
            || preparation.model != self.model
            || !Arc::ptr_eq(&preparation.bytes, &self.bytes)
            || !self
                .raw
                .as_ref()
                .is_some_and(|raw| Arc::ptr_eq(raw, &preparation.raw))
        {
            return Ok(false);
        }
        let Some(prepared) = preparation.result.take() else {
            return Ok(false);
        };
        let live = LiveSession::new(&self.ctx, &prepared.pixels, prepared.width, prepared.height)?;
        if cancel.is_cancelled() {
            return Ok(false);
        }
        self.live = live;
        self.inputs = prepared.inputs;
        self.prefix = prepared.prefix;
        self.sampling = prepared.sampling;
        self.creative = Some(prepared.creative);
        self.auto_fit = prepared.auto_fit;
        self.profile = self.model.profile;
        Ok(true)
    }
}

impl Preparation {
    pub fn run(&mut self, cancel: &CancelToken) -> Result<bool, String> {
        if cancel.is_cancelled() {
            return Ok(false);
        }
        let capture = develop_capture_prefix_rgba_cancellable(
            &self.raw,
            &self.bytes,
            &self.ext,
            &self.model,
            self.edge,
            raw_core::CancelToken::new(cancel.flag()),
        );
        if cancel.is_cancelled() {
            return Ok(false);
        }
        let capture = capture?;
        let inputs = capture_inputs(
            &self.raw,
            &self.bytes,
            &self.ext,
            &self.model,
            capture.whites_anchor_ev,
        )?;
        let auto_fit = auto_will_fit(&self.model, &self.bytes, &self.ext);
        if cancel.is_cancelled() {
            return Ok(false);
        }
        self.result = Some(Prepared {
            pixels: capture.rgba,
            width: capture.width,
            height: capture.height,
            prefix: capture.prefix_model,
            inputs,
            sampling: capture.nr_sampling_scale,
            creative: capture.creative,
            auto_fit,
        });
        Ok(true)
    }
}
