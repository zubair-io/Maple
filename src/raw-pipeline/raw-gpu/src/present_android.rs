//! Android SurfaceView presentation of the existing WGSL chain. No readback.
use crate::present_chain_pipeline::{
    build_present_pipeline, encode_present_pass, pick_surface_format, PresentDispatchCache,
};
use crate::{GpuContext, LiveSession, PresentGeometry};
use raw_window_handle::{
    AndroidDisplayHandle, AndroidNdkWindowHandle, RawDisplayHandle, RawWindowHandle,
};
use std::{ffi::c_void, ptr::NonNull};

pub struct AndroidPresentSurface {
    surface: wgpu::Surface<'static>,
    config: wgpu::SurfaceConfiguration,
    pipeline: wgpu::RenderPipeline,
    layout: wgpu::BindGroupLayout,
    dispatch: PresentDispatchCache,
}

impl AndroidPresentSurface {
    /// The host retains ANativeWindow until this surface is dropped, including
    /// SurfaceView replacement and activity teardown. All calls are serialized.
    pub unsafe fn new(
        ctx: &GpuContext,
        window: NonNull<c_void>,
        width: u32,
        height: u32,
    ) -> Result<Self, String> {
        if width == 0 || height == 0 {
            return Err("Empty Android surface".into());
        }
        let surface = ctx
            .instance
            .create_surface_unsafe(wgpu::SurfaceTargetUnsafe::RawHandle {
                raw_display_handle: RawDisplayHandle::Android(AndroidDisplayHandle::new()),
                raw_window_handle: RawWindowHandle::AndroidNdk(AndroidNdkWindowHandle::new(window)),
            })
            .map_err(|e| e.to_string())?;
        let caps = surface.get_capabilities(&ctx.adapter);
        if caps.formats.is_empty() {
            return Err("Android surface has no compatible Vulkan format".into());
        }
        let format = pick_surface_format(&caps);
        let config = wgpu::SurfaceConfiguration {
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
            format,
            width,
            height,
            present_mode: wgpu::PresentMode::Fifo,
            desired_maximum_frame_latency: 2,
            alpha_mode: caps.alpha_modes[0],
            view_formats: vec![],
        };
        surface.configure(&ctx.device, &config);
        let (pipeline, layout) = build_present_pipeline(ctx, format);
        Ok(Self {
            surface,
            config,
            pipeline,
            layout,
            dispatch: PresentDispatchCache::new(),
        })
    }

    pub fn resize(&mut self, ctx: &GpuContext, width: u32, height: u32) {
        if width > 0 && height > 0 && (width, height) != (self.config.width, self.config.height) {
            self.config.width = width;
            self.config.height = height;
            self.dispatch.invalidate();
            self.surface.configure(&ctx.device, &self.config);
        }
    }

    pub fn present(
        &self,
        ctx: &GpuContext,
        session: &LiveSession,
        index: usize,
        geometry: PresentGeometry,
    ) -> Result<(), String> {
        if index > 1 {
            return Err("Invalid Android present buffer".into());
        }
        let dims = (self.config.width, self.config.height);
        let source = if session.dims() == dims {
            (0, 0)
        } else {
            session.dims()
        };
        let (_, binding) = self.dispatch.get_or_build_scaled(
            ctx,
            &self.layout,
            session.ping_pong_buffer(index),
            (session.identity(), index),
            (dims, source),
            geometry,
        );
        let frame = match self.surface.get_current_texture() {
            Ok(frame) => frame,
            Err(wgpu::SurfaceError::Outdated | wgpu::SurfaceError::Lost) => {
                self.surface.configure(&ctx.device, &self.config);
                self.surface
                    .get_current_texture()
                    .map_err(|e| e.to_string())?
            }
            Err(e) => return Err(e.to_string()),
        };
        let view = frame.texture.create_view(&Default::default());
        let mut encoder = ctx
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("maple-android-present"),
            });
        encode_present_pass(&mut encoder, &self.pipeline, &binding, &view);
        ctx.queue.submit(Some(encoder.finish()));
        frame.present();
        Ok(())
    }
}
