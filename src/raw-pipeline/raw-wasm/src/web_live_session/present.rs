use super::*;

impl WebLiveSession {
    /// Build the chain inputs for `model`, run the resident chain to its f32
    /// buffer, and present to the held canvas surface. The shared tail of `open` +
    /// `render`. Returns the achieved colour-space tag (from the one-time retag).
    pub(super) async fn render_model(
        &mut self,
        model: &AdjustmentModel,
    ) -> Result<String, JsError> {
        if !session_prefix_matches(
            model,
            &self.prefix_model,
            &self.raw,
            &self.ext,
            &mut self.auto_will_fit_cache,
        ) {
            let prefix = develop_capture_prefix_rgba(
                &self.raw_img,
                &self.raw,
                &self.ext,
                model,
                self.target_long_edge,
            )
            .map_err(|e| JsError::new(&e))?;
            let (w, h) = (prefix.width, prefix.height);
            if (w, h) != self.session.dims() {
                return Err(JsError::new(&format!(
                    "WebLiveSession::render: re-develop dims {w}x{h} != {}x{} (canvas not resized)",
                    self.session.dims().0,
                    self.session.dims().1
                )));
            }
            if let Some(fits) = inferred_auto_will_fit(model, &prefix.prefix_model) {
                self.auto_will_fit_cache = Some(fits);
            }
            self.session.update_image(&self.ctx, &prefix.rgba);
            self.prefix_model = prefix.prefix_model;
            self.live_profile = None;
            self.whites_anchor_ev = prefix.whites_anchor_ev;
            self.nr_sampling_scale = prefix.nr_sampling_scale;
            self.creative = prefix.creative;
            self.lens_profile_json = crate::lens_profile::metadata(&self.raw_img, model);
        }
        self.present_for_model(model)
            .await
            .map_err(|e| JsError::new(&e))
    }

    pub(super) async fn present_for_model(
        &mut self,
        model: &AdjustmentModel,
    ) -> Result<String, String> {
        let profile = self.live_profile.get_or_insert_with(|| {
            raw_core::gpu_host::live_profile::LiveProfile::new(
                &self.raw_img,
                &self.raw,
                &self.ext,
                model,
                self.target_long_edge,
                self.film_lut.as_ref(),
                self.film_lut_key,
                self.whites_anchor_ev,
            )
        });
        profile.set_film(self.film_lut.as_ref(), self.film_lut_key);
        profile.update(model);
        let auto_fit = profile.auto_fit;
        let inputs = &mut profile.inputs;
        self.creative.apply(model, inputs)?;
        inputs.nr_sampling_scale = self.nr_sampling_scale;
        // Masks are authored upright; the resident chain remains sensor-framed.
        inputs.mask_orientation = self.raw_img.orientation.exif_tag();
        // #1913 (generalised by #3191): the display-encode primaries MUST match
        // the canvas colour-space tag the present surface ACHIEVED — not the
        // `target_color_space` `open` was asked for, which the browser may not
        // have granted. `chain_inputs_with_status` defaults to sRGB (correct for
        // the one-shot u8-readback path), so encode P3 only when the browser
        // actually configured a display-p3-tagged canvas, else the pixels are
        // reinterpreted in the wrong-width gamut (oversaturated if P3-encoded
        // bytes land on an sRGB tag, washed out the other way around).
        inputs.target_primaries =
            crate::gpu_render::target_primaries_for_color_space(self.present.color_space());
        let final_idx = self
            .session
            .render_chain_to_f32_async(&self.ctx, inputs, None)
            .await
            .map_err(|e| format!("WebLiveSession: {e}"))?
            .ok_or_else(|| "WebLiveSession: live chain returned no buffer".to_string())?;
        // The present recompiles nothing (the pipeline + surface are session-owned);
        // it only fetches the next surface texture, encodes the dither/quantize pass,
        // and presents — zero readback.
        let presented = presentation(self.raw_img.orientation, self.session.dims(), model);
        if presented.dims != (self.width, self.height) {
            self.canvas.set_width(presented.dims.0);
            self.canvas.set_height(presented.dims.1);
            if let Err(error) =
                self.present
                    .resize(&self.ctx, &self.canvas, presented.dims.0, presented.dims.1)
            {
                self.canvas.set_width(self.width);
                self.canvas.set_height(self.height);
                return Err(error);
            }
            (self.width, self.height) = presented.dims;
        }
        self.present
            .present(&self.ctx, &self.session, final_idx, presented.geometry)?;
        self.auto_fit.set(auto_fit);
        Ok(self.present.color_space().to_string())
    }
}
