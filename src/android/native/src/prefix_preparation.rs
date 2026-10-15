//! Pure CPU refinement owns immutable source Arcs; it never borrows GPU state.
use super::*;
use raw_core::gpu_host::{prefix::pixel_prefix_matches, prepare::develop_prefix_rgba_cancellable};

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
    auto_fit: bool,
}

impl Session {
    pub fn preparation(&self) -> Option<Preparation> {
        let raw = self.raw.as_ref()?;
        let ae = if self.auto_fit && self.model.profile == raw_core::types::Profile::Auto {
            raw_core::types::adjustment::AutoExposureMode::Off
        } else {
            self.model.auto_exposure
        };
        if self.model.profile == self.profile && pixel_prefix_matches(&self.model, &self.prefix, ae)
        {
            return None;
        }
        Some(Preparation {
            raw: Arc::clone(raw),
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
        let prepared = develop_prefix_rgba_cancellable(
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
        let (pixels, width, height, prefix, anchor, sampling) = prepared?;
        let film = crate::film::resolve(&self.model.film_look)?;
        let inputs = chain_inputs_with_status(
            &self.raw,
            &self.bytes,
            &self.ext,
            &self.model,
            film.map(|f| f.0),
            film.map_or(0, |f| f.1),
            anchor,
        )
        .0;
        if cancel.is_cancelled() {
            return Ok(false);
        }
        let auto_fit = auto_will_fit(&self.model, &self.bytes, &self.ext);
        self.result = Some(Prepared {
            pixels,
            width,
            height,
            prefix,
            inputs,
            sampling,
            auto_fit,
        });
        Ok(true)
    }
}
