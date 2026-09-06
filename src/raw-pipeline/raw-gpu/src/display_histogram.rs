//! Bounded statistics of the actual presented pixels. Resources are allocated
//! once at session open; encoding piggybacks on the existing present encoder.
//! Only the 3 KB counts cross back to the host, on demand after editing settles.
use crate::context::GpuContext;
use std::cell::Cell;
use wgpu::util::DeviceExt;

const BYTE_LEN: u64 = 768 * 4;

pub(crate) struct DisplayHistogram {
    bins: wgpu::Buffer,
    readback: wgpu::Buffer,
    groups: [wgpu::BindGroup; 2],
    dispatches: u32,
    ready: Cell<bool>,
}

impl DisplayHistogram {
    pub(crate) fn new(
        ctx: &GpuContext,
        sources: &[wgpu::Buffer; 2],
        width: u32,
        height: u32,
    ) -> Self {
        let pipeline = ctx.histogram_pipeline.get_or_init(|| {
            let shader = ctx
                .device
                .create_shader_module(wgpu::ShaderModuleDescriptor {
                    label: Some("display-histogram"),
                    source: wgpu::ShaderSource::Wgsl(
                        format!(
                            "{}\n{}",
                            include_str!("present_chain.wgsl"),
                            include_str!("display_histogram.wgsl")
                        )
                        .into(),
                    ),
                });
            ctx.device
                .create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
                    label: Some("display-histogram"),
                    layout: None,
                    module: &shader,
                    entry_point: Some("histogram_main"),
                    compilation_options: Default::default(),
                    cache: None,
                })
        });
        let bins = ctx.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("display-histogram-bins"),
            size: BYTE_LEN,
            usage: wgpu::BufferUsages::STORAGE
                | wgpu::BufferUsages::COPY_SRC
                | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let readback = ctx.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("display-histogram-readback"),
            size: BYTE_LEN,
            usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let uniform = ctx
            .device
            .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("display-histogram-dims"),
                contents: bytemuck::cast_slice(&[width, height, 0u32, 0u32]),
                usage: wgpu::BufferUsages::UNIFORM,
            });
        let layout = pipeline.get_bind_group_layout(0);
        let groups = sources.each_ref().map(|source| {
            ctx.device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some("display-histogram-group"),
                layout: &layout,
                entries: &[
                    wgpu::BindGroupEntry {
                        binding: 0,
                        resource: uniform.as_entire_binding(),
                    },
                    wgpu::BindGroupEntry {
                        binding: 1,
                        resource: source.as_entire_binding(),
                    },
                    wgpu::BindGroupEntry {
                        binding: 2,
                        resource: bins.as_entire_binding(),
                    },
                ],
            })
        });
        let step = width.max(height).div_ceil(256).max(1);
        Self {
            bins,
            readback,
            groups,
            dispatches: (width.div_ceil(step) * height.div_ceil(step)).div_ceil(64),
            ready: Cell::new(false),
        }
    }

    pub(crate) fn encode(
        &self,
        ctx: &GpuContext,
        encoder: &mut wgpu::CommandEncoder,
        index: usize,
    ) {
        encoder.clear_buffer(&self.bins, 0, None);
        let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
            label: Some("display-histogram"),
            timestamp_writes: None,
        });
        pass.set_pipeline(
            ctx.histogram_pipeline
                .get()
                .expect("created at session open"),
        );
        pass.set_bind_group(0, &self.groups[index], &[]);
        pass.dispatch_workgroups(self.dispatches, 1, 1);
        self.ready.set(true);
    }

    pub(crate) fn read(&self, ctx: &GpuContext) -> Result<Option<Vec<u32>>, String> {
        if !self.ready.get() {
            return Ok(None);
        }
        let mut encoder = ctx
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("display-histogram-readback"),
            });
        encoder.copy_buffer_to_buffer(&self.bins, 0, &self.readback, 0, BYTE_LEN);
        ctx.queue.submit(Some(encoder.finish()));
        let slice = self.readback.slice(..);
        let (tx, rx) = futures_channel::oneshot::channel();
        slice.map_async(wgpu::MapMode::Read, move |result| {
            let _ = tx.send(result);
        });
        ctx.device.poll(wgpu::Maintain::Wait);
        pollster::block_on(rx)
            .map_err(|_| "histogram map channel dropped".to_string())?
            .map_err(|e| format!("histogram readback failed: {e}"))?;
        let view = slice.get_mapped_range();
        let result = bytemuck::cast_slice(&view).to_vec();
        drop(view);
        self.readback.unmap();
        Ok(Some(result))
    }
}

#[cfg(test)]
#[path = "display_histogram_tests.rs"]
mod tests;

#[cfg(target_vendor = "apple")]
impl crate::LiveSession {
    /// Counts for the latest presented frame; preview/export readbacks cannot
    /// overwrite them. None until a present has encoded the histogram.
    pub fn displayed_histogram(&self, ctx: &GpuContext) -> Result<Option<Vec<u32>>, String> {
        self.histogram.read(ctx)
    }
}
