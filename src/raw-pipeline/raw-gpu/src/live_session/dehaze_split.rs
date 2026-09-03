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
        let out = self.submit_and_read_surface(ctx, enc2).await?;
        if inputs.scope.enabled {
            self.scope_after_submit();
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
        ctx.queue.submit(Some(enc2.finish()));
        if inputs.scope.enabled {
            self.scope_after_submit();
        }
        Ok(Some(suffix_final))
    }
}
