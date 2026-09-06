use super::*;

impl LiveSession {
    /// Encode `passes` over the ping-pong pair starting at buffer `start_idx`
    /// (pass i reads `ping_pong[(start_idx + i) % 2]`, writes the other). Returns
    /// the final buffer index, or `None` if `cancel` fired before a pass. Shared
    /// by the single / prefix / suffix encode loops.
    pub(super) fn encode_chain(
        &self,
        ctx: &GpuContext,
        encoder: &mut wgpu::CommandEncoder,
        passes: &[&dyn Pass],
        start_idx: usize,
        cancel: Option<&CancelToken>,
    ) -> Option<usize> {
        let dims = self.image.dims();
        let mut final_idx = start_idx;
        for (i, pass) in passes.iter().enumerate() {
            if let Some(t) = cancel {
                if t.is_cancelled() {
                    return None;
                }
            }
            let src_idx = (start_idx + i) % 2;
            let dst_idx = (start_idx + i + 1) % 2;
            let (lo, hi) = self.ping_pong.split_at(1);
            let (src, dst) = if src_idx == 0 {
                (&lo[0], &hi[0])
            } else {
                (&hi[0], &lo[0])
            };
            pass.encode(ctx, encoder, src, dst, dims);
            final_idx = dst_idx;
        }
        Some(final_idx)
    }

    /// Submit `encoder` (with the dither already encoded into `dither_out`), copy
    /// the packed-u8 surface to the readback staging buffer, map it, and unpack to
    /// the `3·w·h` u8 RGB layout. The terminal of every render path. A failed
    /// readback map (device loss / OOM) is an `Err`, not a panic (#1079).
    pub(super) async fn submit_and_read_surface(
        &self,
        ctx: &GpuContext,
        mut encoder: wgpu::CommandEncoder,
    ) -> Result<(Vec<u8>, wgpu::SubmissionIndex), String> {
        let dims = self.image.dims();
        let packed_byte_len = (dims.0 as u64) * (dims.1 as u64) * std::mem::size_of::<u32>() as u64;
        encoder.copy_buffer_to_buffer(&self.dither_out, 0, &self.readback, 0, packed_byte_len);
        let submission = ctx.queue.submit(Some(encoder.finish()));
        let packed = limits::map_packed_readback(ctx, &self.readback).await?;
        Ok((unpack_rgb_u8(&packed), submission))
    }
}
