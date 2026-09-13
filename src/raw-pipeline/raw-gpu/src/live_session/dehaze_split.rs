//! The C5a CPU-readback airlight FALLBACK path
//! (`LiveSession::airlight_readback_fallback == true`) — superseded by the
//! default on-GPU airlight reduction (#1033), kept as a fallback and for the
//! parity test that pins the on-GPU A against the CPU A. Split out of
//! `live_session.rs` purely for the file-size budget (that file was at 599
//! lines, no headroom left for #3272's scope-pass hooks); pure relocation of
//! [`LiveSession::render_dehaze_split`] and
//! [`LiveSession::encode_chain_f32_dehaze_split`], no behaviour change.
//!
//! `impl LiveSession` blocks may span any number of modules in the same
//! crate (same pattern `context_pipelines_spatial.rs` uses for `GpuContext`)
//! — both methods here reach `LiveSession`'s private fields directly, the
//! same as if they were still in the parent file, since this module is a
//! descendant of `live_session` and Rust's privacy only restricts OUTSIDE
//! access.

use super::LiveSession;
use crate::chain::{CancelToken, Pass};
use crate::context::GpuContext;
use crate::dehaze::{compute_airlight, AirlightSource};
use crate::dither::encode_dither;
use crate::full_chain::FullChainInputs;
use crate::live_chain::build_live_split;

impl LiveSession {
    /// Run the gated chain to its final f32 buffer in ONE submit with a
    /// CALLER-SUPPLIED airlight, returning the ping-pong index holding the result
    /// (the present pass reads it). Test seam for #3602.
    ///
    /// Both shipping paths measure A themselves — the default on-GPU reduction
    /// from the GPU's post-prefix buffer, the readback fallback from that same
    /// buffer on the CPU — so each measures it from a buffer that agrees with a
    /// CPU oracle's only to the two chains' float tolerance. A parity gate that
    /// compares GPU bytes against a CPU oracle needs BOTH sides on ONE A, because
    /// `atmospheric_light`'s top-0.1% rank cut is not reproducible across that
    /// tolerance when the dark channel is flat (see
    /// `full_chain::oracle::shared_airlight`). Nothing shipping calls this.
    #[cfg(test)]
    pub(crate) fn encode_chain_f32_fixed_airlight(
        &self,
        ctx: &GpuContext,
        inputs: &FullChainInputs<'_>,
        airlight: [f32; 3],
    ) -> Option<usize> {
        let sig = crate::live_chain::chain_signature(inputs, self.image.dims(), self.session_id);
        ctx.frame_pool.borrow_mut().begin_frame(sig);
        let passes = crate::live_chain::build_live_chain(inputs, AirlightSource::Cpu(airlight));
        let pass_refs: Vec<&dyn Pass> = passes.iter().map(|p| p.as_ref()).collect();
        let mut encoder = ctx
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("present-gate-fixed-airlight-encoder"),
            });
        encoder.copy_buffer_to_buffer(
            &self.image.buffer,
            0,
            &self.ping_pong[0],
            0,
            self.image.byte_len(),
        );
        let final_idx = self.encode_chain(ctx, &mut encoder, &pass_refs, 0, None);
        ctx.queue.submit(Some(encoder.finish()));
        ctx.frame_pool.borrow_mut().end_frame();
        final_idx
    }

    /// The C5a CPU-readback FALLBACK path (`airlight_readback_fallback == true`):
    /// run the pre-dehaze PREFIX, read the post-prefix buffer back,
    /// `compute_airlight` from the EXACT buffer dehaze sees, then run the dehaze
    /// SUFFIX (built with the real CPU A) + dither + the final readback. Two
    /// submits + a per-tick GPU→CPU readback — superseded by the default on-GPU
    /// reduction (#1033), kept for the parity reference + as a fallback.
    pub(super) async fn render_dehaze_split(
        &self,
        ctx: &GpuContext,
        inputs: &FullChainInputs<'_>,
        cancel: Option<&CancelToken>,
    ) -> Result<Option<Vec<u8>>, String> {
        let dims = self.image.dims();
        let f32_byte_len = self.image.byte_len();

        // Phase 1: the pre-dehaze prefix (airlight unknown → placeholder; only the
        // prefix runs here). Encode prefix from ping-pong A, then copy the
        // post-prefix result to the airlight staging buffer.
        let (prefix, _) = build_live_split(inputs, AirlightSource::Cpu([0.0; 3]));
        let prefix_refs: Vec<&dyn Pass> = prefix.iter().map(|p| p.as_ref()).collect();

        let mut enc1 = ctx
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("live-prefix-encoder"),
            });
        enc1.copy_buffer_to_buffer(&self.image.buffer, 0, &self.ping_pong[0], 0, f32_byte_len);
        let prefix_final = match self.encode_chain(ctx, &mut enc1, &prefix_refs, 0, cancel) {
            Some(idx) => idx,
            None => return Ok(None),
        };
        enc1.copy_buffer_to_buffer(
            &self.ping_pong[prefix_final],
            0,
            &self.airlight_staging,
            0,
            f32_byte_len,
        );
        ctx.queue.submit(Some(enc1.finish()));

        // Read the post-prefix buffer back and measure A exactly as raw-core does.
        let pre_dehaze = super::limits::map_f32_readback(ctx, &self.airlight_staging).await?;
        let airlight = compute_airlight(&pre_dehaze, dims.0 as usize, dims.1 as usize);

        // Phase 2: dehaze + suffix (built with the REAL airlight) + dither. The
        // post-prefix data is STILL RESIDENT in `ping_pong[prefix_final]` (submit 1
        // didn't touch it after the staging copy), so the suffix runs from THAT
        // index directly — no re-seed copy, no parity-index bookkeeping.
        let (_, suffix) = build_live_split(inputs, AirlightSource::Cpu(airlight));
        let suffix_refs: Vec<&dyn Pass> = suffix.iter().map(|p| p.as_ref()).collect();

        let mut enc2 = ctx
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("live-suffix-encoder"),
            });
        let suffix_final =
            match self.encode_chain(ctx, &mut enc2, &suffix_refs, prefix_final, cancel) {
                Some(idx) => idx,
                None => return Ok(None),
            };
        if inputs.scope.enabled {
            self.encode_scope(
                ctx,
                &mut enc2,
                &self.ping_pong[suffix_final],
                inputs.scope.layer >= 0,
            );
        }
        encode_dither(
            ctx,
            &mut enc2,
            &self.ping_pong[suffix_final],
            &self.dither_out,
            dims,
        );
        let (out, submission) = self.submit_and_read_surface(ctx, enc2).await?;
        if inputs.scope.enabled {
            self.scope_after_submit(submission);
        }
        Ok(Some(out))
    }

    /// The C5a CPU-readback FALLBACK chain-only path
    /// (`airlight_readback_fallback == true`): run the pre-dehaze PREFIX, read the
    /// post-prefix buffer back, `compute_airlight` from the EXACT buffer dehaze
    /// sees, then run the dehaze SUFFIX (built with the real CPU A) — leaving the
    /// f32 result resident, NO dither. Two submits + a readback; superseded by the
    /// default on-GPU reduction (#1033), kept as a fallback.
    ///
    /// Scope-pass hook (#3272): encoded into the SAME final submit as the chain
    /// suffix, right before it — identical placement to the single-submit
    /// sibling [`LiveSession::encode_chain_f32_single`], just on the later of
    /// this path's two encoders.
    pub(super) async fn encode_chain_f32_dehaze_split(
        &self,
        ctx: &GpuContext,
        inputs: &FullChainInputs<'_>,
        cancel: Option<&CancelToken>,
    ) -> Result<Option<usize>, String> {
        let dims = self.image.dims();
        let f32_byte_len = self.image.byte_len();

        let (prefix, _) = build_live_split(inputs, AirlightSource::Cpu([0.0; 3]));
        let prefix_refs: Vec<&dyn Pass> = prefix.iter().map(|p| p.as_ref()).collect();

        let mut enc1 = ctx
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("live-present-prefix-encoder"),
            });
        enc1.copy_buffer_to_buffer(&self.image.buffer, 0, &self.ping_pong[0], 0, f32_byte_len);
        let prefix_final = match self.encode_chain(ctx, &mut enc1, &prefix_refs, 0, cancel) {
            Some(idx) => idx,
            None => return Ok(None),
        };
        enc1.copy_buffer_to_buffer(
            &self.ping_pong[prefix_final],
            0,
            &self.airlight_staging,
            0,
            f32_byte_len,
        );
        ctx.queue.submit(Some(enc1.finish()));

        let pre_dehaze = super::limits::map_f32_readback(ctx, &self.airlight_staging).await?;
        let airlight = compute_airlight(&pre_dehaze, dims.0 as usize, dims.1 as usize);

        let (_, suffix) = build_live_split(inputs, AirlightSource::Cpu(airlight));
        let suffix_refs: Vec<&dyn Pass> = suffix.iter().map(|p| p.as_ref()).collect();

        let mut enc2 = ctx
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("live-present-suffix-encoder"),
            });
        let suffix_final =
            match self.encode_chain(ctx, &mut enc2, &suffix_refs, prefix_final, cancel) {
                Some(idx) => idx,
                None => return Ok(None),
            };
        if inputs.scope.enabled {
            self.encode_scope(
                ctx,
                &mut enc2,
                &self.ping_pong[suffix_final],
                inputs.scope.layer >= 0,
            );
        }
        let submission = ctx.queue.submit(Some(enc2.finish()));
        if inputs.scope.enabled {
            self.scope_after_submit(submission);
        }
        Ok(Some(suffix_final))
    }
}
