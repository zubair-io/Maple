//! On-demand paired scope pixels/weights (#4104). Reuses the resident chain
//! and bounded scope sampler, without altering present or previous-tick HUDs.
use super::{limits, LiveSession};
use crate::{CancelToken, FullChainInputs, GpuContext};

impl LiveSession {
    #[cfg(not(target_arch = "wasm32"))]
    pub fn inspect_scope(
        &self,
        ctx: &GpuContext,
        inputs: &FullChainInputs<'_>,
        region: (u32, u32, u32, u32),
    ) -> Result<(u32, u32, Vec<u8>), String> {
        let dims = self.image.dims();
        if region.2 == 0
            || region.3 == 0
            || u64::from(region.0) + u64::from(region.2) > u64::from(dims.0)
            || u64::from(region.1) + u64::from(region.3) > u64::from(dims.1)
        {
            return Err("scope region is outside the frame".into());
        }
        let idx = self
            .render_chain_to_f32(ctx, inputs, &CancelToken::new())?
            .ok_or("scope render cancelled")?;
        let (w, h) = crate::scope::snapshot_dims(region.2, region.3);
        let length = u64::from(w) * u64::from(h) * 4;
        let snapshot = ctx.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("agent-scope-paired-snapshot"),
            size: length,
            usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
            mapped_at_creation: false,
        });
        let readback = ctx.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("agent-scope-paired-readback"),
            size: length,
            usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let mut encoder = ctx
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("agent-scope-inspection"),
            });
        crate::scope::encode_scope_region(
            ctx,
            &mut encoder,
            &self.ping_pong[idx],
            &snapshot,
            dims,
            region,
            inputs.scope.layer >= 0,
        );
        encoder.copy_buffer_to_buffer(&snapshot, 0, &readback, 0, length);
        ctx.queue.submit(Some(encoder.finish()));
        let words = pollster::block_on(limits::map_packed_readback(ctx, &readback))?;
        let rgba = words.into_iter().flat_map(u32::to_le_bytes).collect();
        Ok((w, h, rgba))
    }
}
