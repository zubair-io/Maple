//! Bounded display-RGBA sampling for Web scopes (#3397). Sampling reads the
//! resident final buffer without modifying it or the present path. GPU objects
//! are session-owned; only completed, at-most-512px samples reach the CPU.

use crate::{GpuContext, LiveSession};
use futures_channel::oneshot;
use std::{cell::Cell, rc::Rc};
use wgpu::util::DeviceExt;

const MAX_EDGE: u32 = 512;

/// Quantized RGBA in the source display primaries, not implicitly sRGB.
pub struct ScopePixels {
    pub width: u32,
    pub height: u32,
    pub rgba: Vec<u8>,
}

struct Staging {
    buffer: wgpu::Buffer,
    busy: Cell<bool>,
    failed: Cell<bool>,
}

/// Reusable sampler for one live session's two resident chain buffers.
pub struct ScopeSampler {
    pipeline: wgpu::ComputePipeline,
    groups: [wgpu::BindGroup; 2],
    output: wgpu::Buffer,
    staging: Rc<Staging>,
    width: u32,
    height: u32,
}

fn sample_dims(width: u32, height: u32) -> (u32, u32) {
    let edge = width.max(height);
    if edge <= MAX_EDGE {
        return (width, height);
    }
    let scaled = |dimension: u32| {
        ((u64::from(dimension) * u64::from(MAX_EDGE) + u64::from(edge) / 2) / u64::from(edge))
            .max(1) as u32
    };
    (scaled(width), scaled(height))
}

impl ScopeSampler {
    /// Allocate once, after the session's image dimensions are validated.
    pub fn new(ctx: &GpuContext, session: &LiveSession) -> Self {
        let (source_width, source_height) = session.dims();
        let (width, height) = sample_dims(source_width, source_height);
        let byte_len = u64::from(width) * u64::from(height) * 4;
        // Reuse the actual display quantizer and noise, exactly as the display
        // histogram does. A different entry point leaves presentation untouched.
        let shader = ctx
            .device
            .create_shader_module(wgpu::ShaderModuleDescriptor {
                label: Some("scope-sample"),
                source: wgpu::ShaderSource::Wgsl(
                    format!(
                        "{}\n{}",
                        include_str!("present_chain.wgsl"),
                        include_str!("scope_sample.wgsl")
                    )
                    .into(),
                ),
            });
        let pipeline = ctx
            .device
            .create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
                label: Some("scope-sample"),
                layout: None,
                module: &shader,
                entry_point: Some("scope_sample_main"),
                compilation_options: Default::default(),
                cache: None,
            });
        let uniform = ctx
            .device
            .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("scope-sample-dims"),
                // Reuse present Params: source dims in width/height; sample dims in
                // src_width/src_height. Only our compute entry reads this uniform.
                contents: bytemuck::cast_slice(&[source_width, source_height, width, height]),
                usage: wgpu::BufferUsages::UNIFORM,
            });
        let output = ctx.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("scope-sample-output"),
            size: byte_len,
            usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
            mapped_at_creation: false,
        });
        let staging = Rc::new(Staging {
            buffer: ctx.device.create_buffer(&wgpu::BufferDescriptor {
                label: Some("scope-sample-staging"),
                size: byte_len,
                usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
                mapped_at_creation: false,
            }),
            busy: Cell::new(false),
            failed: Cell::new(false),
        });
        let layout = pipeline.get_bind_group_layout(0);
        let groups = [0, 1].map(|index| {
            ctx.device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some("scope-sample-group"),
                layout: &layout,
                entries: &[
                    wgpu::BindGroupEntry {
                        binding: 0,
                        resource: uniform.as_entire_binding(),
                    },
                    wgpu::BindGroupEntry {
                        binding: 1,
                        resource: session.ping_pong_buffer(index).as_entire_binding(),
                    },
                    wgpu::BindGroupEntry {
                        binding: 2,
                        resource: output.as_entire_binding(),
                    },
                ],
            })
        });
        Self {
            pipeline,
            groups,
            output,
            staging,
            width,
            height,
        }
    }

    /// Freeze the named final buffer by submitting the sample/copy immediately.
    /// Must run between renders, before that buffer can be overwritten. Returns
    /// owned pending state; awaiting it never borrows the sampler or live session.
    /// Native callers must poll their device; WebGPU drives maps independently.
    /// A failed map retires the sampler until a new session is opened.
    pub fn sample(&self, ctx: &GpuContext, final_index: usize) -> Result<ScopeReadback, String> {
        if self.staging.failed.get() {
            return Err("scope sample: prior map failed; reopen the session".into());
        }
        let group = self
            .groups
            .get(final_index)
            .ok_or("scope sample: invalid buffer index")?;
        if self.staging.busy.replace(true) {
            return Err("scope sample: readback already pending".into());
        }
        let (sender, receiver) = oneshot::channel();
        let mut readback = ScopeReadback {
            staging: Rc::clone(&self.staging),
            receiver,
            map: MapState::NotRequested,
            width: self.width,
            height: self.height,
        };
        let mut encoder = ctx
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("scope-sample-encoder"),
            });
        {
            let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
                label: Some("scope-sample"),
                timestamp_writes: None,
            });
            pass.set_pipeline(&self.pipeline);
            pass.set_bind_group(0, group, &[]);
            pass.dispatch_workgroups((self.width * self.height).div_ceil(64), 1, 1);
        }
        encoder.copy_buffer_to_buffer(&self.output, 0, &self.staging.buffer, 0, self.output.size());
        ctx.queue.submit(Some(encoder.finish()));
        self.staging
            .buffer
            .slice(..)
            .map_async(wgpu::MapMode::Read, move |result| {
                let _ = sender.send(result);
            });
        readback.map = MapState::Pending;
        Ok(readback)
    }
}

/// Owns the pending map even if its source session is freed. Dropping a pending
/// readback cancels/unmaps it before returning its staging slot to the sampler.
pub struct ScopeReadback {
    staging: Rc<Staging>,
    receiver: oneshot::Receiver<Result<(), wgpu::BufferAsyncError>>,
    map: MapState,
    width: u32,
    height: u32,
}

enum MapState {
    NotRequested,
    Pending,
    Mapped,
    Failed,
}

impl ScopeReadback {
    pub async fn read(mut self) -> Result<ScopePixels, String> {
        // Keep the receiver in self while awaiting: Drop can inspect a map
        // that failed just before its waiting future was cancelled.
        let result = (&mut self.receiver)
            .await
            .map_err(|_| "scope sample: map channel dropped".to_string())
            .and_then(|result| {
                result.map_err(|error| format!("scope sample: map failed: {error}"))
            });
        self.map = if result.is_ok() {
            MapState::Mapped
        } else {
            MapState::Failed
        };
        result?;
        let view = self.staging.buffer.slice(..).get_mapped_range();
        let rgba = view.to_vec();
        drop(view);
        Ok(ScopePixels {
            width: self.width,
            height: self.height,
            rgba,
        })
        // Self::drop unmaps on success, error, or cancellation of this future.
    }
}

impl Drop for ScopeReadback {
    fn drop(&mut self) {
        let failed = match self.map {
            MapState::Pending => matches!(self.receiver.try_recv(), Ok(Some(Err(_))) | Err(_)),
            MapState::Failed => true,
            _ => false,
        };
        if failed {
            // A rejected map may already be unmapped or device-lost. Retire
            // this sampler rather than unmapping twice or reusing uncertain
            // backend state. Opening a new session creates fresh resources.
            self.staging.failed.set(true);
        } else if !matches!(self.map, MapState::NotRequested) {
            self.staging.buffer.unmap();
        }
        self.staging.busy.set(false);
    }
}

#[cfg(all(test, not(target_arch = "wasm32")))]
#[path = "scope_sample/tests.rs"]
mod tests;
