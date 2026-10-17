//! Session-owned Auto artifacts, including curve-only and unavailable outcomes.
//! The owning host replaces this state when its uploaded RAW prefix changes.
use super::{
    model::update_chain_inputs,
    prepare::{auto_will_fit, chain_inputs_with_status},
};
use crate::{
    film::FilmLut,
    image::RawImage,
    xmp::{AdjustmentModel, AutoExposureMode, Profile},
};
use raw_gpu::FullChainInputs;

pub struct LiveProfile {
    pub inputs: FullChainInputs<'static>,
    pub auto_fit: Option<bool>,
    preview_capable: bool,
}

impl LiveProfile {
    pub fn new(
        raw: &RawImage,
        bytes: &[u8],
        ext: &str,
        model: &AdjustmentModel,
        film: Option<&FilmLut>,
        film_key: u32,
        whites_anchor: f32,
    ) -> Self {
        // Capability belongs to this immutable source, even when opened Neutral.
        // Probe before fitting, exactly as the prefix's AE decision does.
        let preview_capable = auto_will_fit(&AdjustmentModel::default(), bytes, ext);
        let (inputs, auto_fit) =
            chain_inputs_with_status(raw, bytes, ext, model, film, film_key, whites_anchor);
        Self {
            inputs,
            auto_fit,
            preview_capable,
        }
    }

    pub fn effective_ae(&self, model: &AdjustmentModel) -> AutoExposureMode {
        if model.profile == Profile::Auto && self.preview_capable {
            AutoExposureMode::Off
        } else {
            model.auto_exposure
        }
    }

    /// Film is a downstream look, independent of Auto's RAW-derived fit.
    pub fn set_film(&mut self, film: Option<&FilmLut>, film_key: u32) {
        let key = if film.is_some() { film_key } else { 0 };
        if self.inputs.film_lut_key != key
            || self.inputs.film_lut_size != film.map_or(0, |f| f.size as u32)
        {
            self.inputs.film_lut_key = key;
            self.inputs.film_lut_size = film.map_or(0, |f| f.size as u32);
            self.inputs.film_lut_data = film.map_or_else(Vec::new, |f| f.data.clone()).into();
        }
    }

    /// Refresh only live controls; the host replaces this state on prefix changes.
    /// No RAW hashing, preview extraction, fitting or artifact cloning runs here.
    pub fn update(&mut self, model: &AdjustmentModel) {
        update_chain_inputs(model, &mut self.inputs);
    }
}
