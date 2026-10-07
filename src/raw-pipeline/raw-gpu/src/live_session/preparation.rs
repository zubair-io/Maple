use super::*;

impl LiveSession {
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
