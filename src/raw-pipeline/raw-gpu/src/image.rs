//! `GpuImage` — a scene-linear RGBA f32 image uploaded to the GPU **once**.
//!
//! This is the upload-once substrate at the heart of P1a (#987): decode the
//! image, upload it here a single time, then reuse the same GPU buffer for
//! preview *and* full-res renders without re-uploading. `ChainRunner` never
//! mutates this buffer — it copies it into scratch ping-pong buffers — so the
//! image stays a clean source across re-runs.

use crate::context::GpuContext;
use wgpu::util::DeviceExt;

/// An RGBA f32 image resident on the GPU. Created via [`GpuImage::upload`];
/// the source buffer is `width * height` interleaved RGBA pixels (4 floats
/// each). The backing buffer is `STORAGE | COPY_SRC | COPY_DST` so it can seed
/// a chain (`COPY_SRC`) and be read straight back for tests/export.
pub struct GpuImage {
    pub buffer: wgpu::Buffer,
    pub width: u32,
    pub height: u32,
}

impl GpuImage {
    /// Upload `pixels` (interleaved RGBA f32, length `width * height * 4`) to a
    /// GPU storage buffer. Panics if the length doesn't match the dims.
    pub fn upload(ctx: &GpuContext, pixels: &[f32], width: u32, height: u32) -> Self {
        let expected = (width as usize) * (height as usize) * 4;
        assert_eq!(
            pixels.len(),
            expected,
            "GpuImage::upload: pixel buffer len {} != width*height*4 ({width}x{height} = {expected})",
            pixels.len()
        );
        let buffer = ctx
            .device
            .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("maple-gpu-image"),
                contents: bytemuck::cast_slice(pixels),
                usage: wgpu::BufferUsages::STORAGE
                    | wgpu::BufferUsages::COPY_SRC
                    | wgpu::BufferUsages::COPY_DST,
            });
        Self {
            buffer,
            width,
            height,
        }
    }

    /// Byte length of the backing buffer (`width * height * 4 * 4`).
    pub fn byte_len(&self) -> u64 {
        (self.width as u64) * (self.height as u64) * 4 * std::mem::size_of::<f32>() as u64
    }

    /// Pixel dimensions as a `(width, height)` tuple.
    pub fn dims(&self) -> (u32, u32) {
        (self.width, self.height)
    }

    /// Copy the image buffer back to the CPU as RGBA f32. Test/export only —
    /// never the interactive path. Native blocking; wasm awaits the map.
    #[cfg(not(target_arch = "wasm32"))]
    pub fn read_back_blocking(&self, ctx: &GpuContext) -> Vec<f32> {
        pollster::block_on(crate::chain::read_buffer_async(
            ctx,
            &self.buffer,
            self.byte_len(),
        ))
    }
}

#[cfg(all(test, not(target_arch = "wasm32")))]
mod tests {
    use super::*;
    use crate::test_buffer;

    #[test]
    fn gpu_image_uploads_and_reads_back_identity() {
        let ctx = GpuContext::new_blocking();
        let input = test_buffer(256); // 256 RGBA pixels
        let img = GpuImage::upload(&ctx, &input, 16, 16);
        let out = img.read_back_blocking(&ctx);
        assert_eq!(input, out, "round-tripped buffer must be byte-identical");
    }

    #[test]
    fn gpu_image_uploads_at_two_sizes() {
        // The same upload path serves "full" (16x16) and "preview" (8x8) sizes;
        // each round-trips. (Downscaling the *pixels* is the caller's job — P4.)
        let ctx = GpuContext::new_blocking();

        let full = test_buffer(256);
        let full_img = GpuImage::upload(&ctx, &full, 16, 16);
        assert_eq!(full_img.dims(), (16, 16));
        assert_eq!(full_img.read_back_blocking(&ctx), full);

        let preview = test_buffer(64);
        let preview_img = GpuImage::upload(&ctx, &preview, 8, 8);
        assert_eq!(preview_img.dims(), (8, 8));
        assert_eq!(preview_img.read_back_blocking(&ctx), preview);
    }
}
