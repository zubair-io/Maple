//! UI ownership of a worker-produced resident texture (#4317).
use eframe::{
    egui,
    egui_wgpu::{wgpu, RenderState},
};
use std::sync::Arc;

/// Transferable sRGB sampled view, with no pixel copy or CPU readback.
pub struct GpuFrame {
    pub view: Arc<wgpu::TextureView>,
    pub device: Arc<wgpu::Device>,
    pub dims: (u32, u32),
}

impl GpuFrame {
    pub fn from_preview(
        ctx: &raw_gpu::GpuContext,
        preview: &crate::gpu_preview::GpuPreview,
    ) -> Self {
        Self {
            view: preview.target().srgb_view_handle(),
            device: ctx.device.clone(),
            dims: preview.target().dims(),
        }
    }
}

/// Registration lives on the UI thread and is freed when the image is replaced.
pub struct NativeTexture {
    state: RenderState,
    frame: GpuFrame,
    id: egui::TextureId,
}

impl NativeTexture {
    pub fn register(state: &RenderState, frame: GpuFrame) -> Result<Self, String> {
        if !Arc::ptr_eq(&state.device, &frame.device) {
            return Err("The preview texture belongs to a different GPU device".into());
        }
        if frame.dims.0 == 0 || frame.dims.1 == 0 {
            return Err("The preview texture has empty dimensions".into());
        }
        let id = state.renderer.write().register_native_texture(
            &state.device,
            &frame.view,
            wgpu::FilterMode::Linear,
        );
        Ok(Self {
            state: state.clone(),
            frame,
            id,
        })
    }
    pub fn id(&self) -> egui::TextureId {
        self.id
    }
    pub fn size(&self) -> egui::Vec2 {
        egui::vec2(self.frame.dims.0 as f32, self.frame.dims.1 as f32)
    }
    pub fn shares_view(&self, frame: &GpuFrame) -> bool {
        Arc::ptr_eq(&self.frame.view, &frame.view)
    }
}

impl Drop for NativeTexture {
    fn drop(&mut self) {
        self.state.renderer.write().free_texture(&self.id);
    }
}
