use super::*;

impl LiveSession {
    /// Execute both scene-tone paths after composition initialization (#4340).
    /// Restore the exact requested tone and output; neither preparation frame
    /// is presented. Scope capture must not observe temporary parameters.
    pub fn prepare_scene_tone_execution(
        &self,
        ctx: &GpuContext,
        inputs: &mut FullChainInputs<'_>,
        cancel: &CancelToken,
    ) -> Result<bool, String> {
        if inputs.scope.enabled {
            return Ok(false);
        }
        if cancel.is_cancelled() {
            return Err("Scene-tone preparation cancelled".into());
        }
        let original = inputs.tone;
        if [0, 1, 2, 3, 5].iter().any(|&i| original[i] != 0.0) {
            for i in [0, 1, 2, 3, 5] {
                inputs.tone[i] = 0.0;
            }
        } else {
            inputs.tone[0] = 0.01;
        }
        let opposite = self.render_chain_to_f32(ctx, inputs, cancel);
        inputs.tone = original;
        let restored = self.render_chain_to_f32(ctx, inputs, cancel);
        match (opposite, restored) {
            (Ok(Some(_)), Ok(Some(_))) => Ok(true),
            (Err(error), _) | (_, Err(error)) => Err(error),
            _ => Err("Scene-tone preparation cancelled".into()),
        }
    }

    /// #4340: create the first Exposure bucket's resources before presentation.
    /// Encodes its actual pass sequence but discards the unsubmitted commands:
    /// no preparation pixels execute, and no full-chain GPU completion wait is
    /// introduced. The requested render executes normally afterward.
    pub fn prepare_exposure_activation(
        &self,
        ctx: &GpuContext,
        inputs: &mut FullChainInputs<'_>,
        cancel: &CancelToken,
    ) -> Result<bool, String> {
        if inputs.scope.enabled || [0, 1, 2, 3, 5].iter().any(|&i| inputs.tone[i] != 0.0) {
            return Ok(false);
        }
        if cancel.is_cancelled() {
            return Err("Exposure preparation cancelled".into());
        }
        let original_tone = inputs.tone;
        inputs.tone[0] = 0.01;
        let signature = chain_signature(inputs, self.image.dims(), self.session_id);
        ctx.frame_pool.borrow_mut().begin_frame(signature);
        let passes = build_live_chain(inputs, AirlightSource::OnGpu);
        let pass_refs: Vec<&dyn Pass> = passes.iter().map(|pass| pass.as_ref()).collect();
        let mut encoder = ctx
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("exposure-resource-preparation"),
            });
        let result = self.encode_chain(ctx, &mut encoder, &pass_refs, 0, Some(cancel));
        ctx.frame_pool.borrow_mut().end_frame();
        drop(pass_refs);
        drop(passes);
        inputs.tone = original_tone;
        drop(encoder);
        result
            .map(|_| true)
            .ok_or_else(|| "Exposure preparation cancelled".into())
    }
}
