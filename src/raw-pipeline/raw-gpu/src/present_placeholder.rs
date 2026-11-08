//! The canvas placeholder on the GPU (#5758): a still the canvas shows before
//! the photo's own render — the grid thumbnail, then a server or cached
//! preview — drawn on the render's own surface through the same present
//! pass. The pass's bilinear arm resamples it to the surface, its dither and
//! quantize match the render's, and the next present of the live chain
//! replaces it in one drawable: only the pixels change.
//!
//! The still arrives display-encoded in the canvas's target primaries
//! (`raw_core::canvas_placeholder::encode_placeholder`), the encoding the live chain
//! leaves for the present, so the shader needs no placeholder-specific arm.

use crate::context::GpuContext;
use crate::present_chain_pipeline::PresentGeometry;

/// A placeholder still resident on the GPU as display-encoded f32 RGBA.
/// Re-uploading a still that fits keeps the buffer, so its present dispatch
/// stays cached; a larger one replaces it under a fresh identity.
pub struct PlaceholderSource {
    buffer: wgpu::Buffer,
    capacity_texels: u64,
    dims: (u32, u32),
    #[cfg_attr(not(target_vendor = "apple"), allow(dead_code))]
    identity: u64,
}

impl PlaceholderSource {
    /// Upload `texels` (`dims`, row-major) into `slot`, reusing its buffer
    /// when it is large enough.
    pub fn upload(
        ctx: &GpuContext,
        slot: &mut Option<Self>,
        texels: &[[f32; 4]],
        dims: (u32, u32),
    ) -> Result<(), String> {
        let (width, height) = dims;
        let count = u64::from(width) * u64::from(height);
        if count == 0 || texels.len() as u64 != count {
            return Err(format!(
                "placeholder: {} texels for {width}x{height}",
                texels.len()
            ));
        }
        let bytes = count * std::mem::size_of::<[f32; 4]>() as u64;
        let limits = ctx.device.limits();
        if bytes > u64::from(limits.max_storage_buffer_binding_size)
            || bytes > limits.max_buffer_size
        {
            return Err(format!(
                "placeholder: {width}x{height} exceeds the device's buffer limits"
            ));
        }
        let reusable = slot
            .as_ref()
            .is_some_and(|source| source.capacity_texels >= count);
        if !reusable {
            *slot = None;
            *slot = Some(Self {
                buffer: ctx.device.create_buffer(&wgpu::BufferDescriptor {
                    label: Some("canvas-placeholder"),
                    size: bytes,
                    usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST,
                    mapped_at_creation: false,
                }),
                capacity_texels: count,
                dims,
                identity: crate::live_session::mint_present_source_identity(),
            });
        }
        let source = slot.as_mut().expect("populated above");
        ctx.queue
            .write_buffer(&source.buffer, 0, bytemuck::cast_slice(texels));
        source.dims = dims;
        Ok(())
    }

    /// The uploaded still's dims.
    pub fn dims(&self) -> (u32, u32) {
        self.dims
    }

    pub(crate) fn buffer(&self) -> &wgpu::Buffer {
        &self.buffer
    }

    #[cfg_attr(not(target_vendor = "apple"), allow(dead_code))]
    pub(crate) fn identity(&self) -> u64 {
        self.identity
    }
}

/// Present `source` at `surface` into an owned offscreen target and read
/// back its RGB bytes — the parity path for the surface present, which runs
/// the same pass with the same uniform.
pub fn present_placeholder_to_offscreen(
    ctx: &GpuContext,
    source: &PlaceholderSource,
    surface: (u32, u32),
) -> Result<Vec<u8>, String> {
    crate::present_chain::present_buffer_to_offscreen(
        ctx,
        source.buffer(),
        (surface, source.dims()),
        PresentGeometry::IDENTITY,
        |_| {},
    )
}

#[cfg(test)]
#[path = "present_placeholder_tests.rs"]
mod tests;
