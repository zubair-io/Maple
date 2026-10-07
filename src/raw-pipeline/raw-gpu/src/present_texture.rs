//! Persistent chain output for native UI texture registration (#4317).
//! Reuses the shared dither/present shader; no CPU readback in the render path.
use crate::present_chain_pipeline::{
    build_present_pipeline, encode_present_pass, PresentDispatchCache, PresentGeometry,
};
use crate::{GpuContext, LiveSession};
use std::sync::Arc;

/// One image-sized, gamma-encoded sRGB RGBA texture on the chain's device.
/// The render attachment is UNORM because the chain already encoded gamma.
/// Consumers expecting linear samples (including egui) use the compatible sRGB
/// sampled view; consumers expecting encoded samples use the ordinary view.
pub struct PresentTexture {
    texture: wgpu::Texture,
    view: Arc<wgpu::TextureView>,
    srgb_view: Arc<wgpu::TextureView>,
    dims: (u32, u32),
    pipeline: wgpu::RenderPipeline,
    layout: wgpu::BindGroupLayout,
    dispatch: PresentDispatchCache,
}

impl PresentTexture {
    pub fn new(ctx: &GpuContext, dims: (u32, u32)) -> Result<Self, String> {
        let limit = ctx.device.limits().max_texture_dimension_2d;
        if dims.0 == 0 || dims.1 == 0 || dims.0 > limit || dims.1 > limit {
            return Err(format!(
                "Native present dimensions {dims:?} exceed 1..={limit}"
            ));
        }
        let format = wgpu::TextureFormat::Rgba8Unorm;
        let texture = ctx.device.create_texture(&wgpu::TextureDescriptor {
            label: Some("maple-native-preview"),
            size: wgpu::Extent3d {
                width: dims.0,
                height: dims.1,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT
                | wgpu::TextureUsages::TEXTURE_BINDING
                | wgpu::TextureUsages::COPY_SRC,
            view_formats: &[wgpu::TextureFormat::Rgba8UnormSrgb],
        });
        let view = Arc::new(texture.create_view(&Default::default()));
        let srgb_view = Arc::new(texture.create_view(&wgpu::TextureViewDescriptor {
            label: Some("maple-native-preview-srgb-sampling"),
            format: Some(wgpu::TextureFormat::Rgba8UnormSrgb),
            ..Default::default()
        }));
        let (pipeline, layout) = build_present_pipeline(ctx, format);
        Ok(Self {
            texture,
            view,
            srgb_view,
            dims,
            pipeline,
            layout,
            dispatch: PresentDispatchCache::new(),
        })
    }

    pub fn view(&self) -> &wgpu::TextureView {
        &self.view
    }
    /// Share the resident view with a native UI without transferring compute ownership.
    pub fn view_handle(&self) -> Arc<wgpu::TextureView> {
        self.view.clone()
    }

    /// Decode encoded display bytes when sampled by a linear-texture consumer.
    /// Shares the same resident image allocation and is retained across ticks.
    pub fn srgb_view_handle(&self) -> Arc<wgpu::TextureView> {
        self.srgb_view.clone()
    }

    pub fn texture(&self) -> &wgpu::Texture {
        &self.texture
    }
    pub fn dims(&self) -> (u32, u32) {
        self.dims
    }
    /// Number of cached presentation dispatches, for allocation qualification.
    pub fn dispatch_alloc_count(&self) -> u64 {
        self.dispatch.alloc_count()
    }

    pub fn present(
        &self,
        ctx: &GpuContext,
        session: &LiveSession,
        final_idx: usize,
        geometry: PresentGeometry,
    ) -> Result<(), String> {
        if final_idx > 1 {
            return Err("Native present buffer index mismatch".into());
        }
        let src_dims = if session.dims() == self.dims {
            (0, 0)
        } else {
            session.dims()
        };
        let (_, binding) = self.dispatch.get_or_build_scaled(
            ctx,
            &self.layout,
            session.ping_pong_buffer(final_idx),
            (session.identity(), final_idx),
            (self.dims, src_dims),
            geometry,
        );
        let mut encoder = ctx
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("maple-native-present"),
            });
        encode_present_pass(&mut encoder, &self.pipeline, &binding, &self.view);
        ctx.queue.submit(Some(encoder.finish()));
        Ok(())
    }
}
