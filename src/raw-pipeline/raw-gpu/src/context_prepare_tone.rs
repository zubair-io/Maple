use crate::{GpuContext, GpuImage, Pass, SceneToneControlsPass};

impl GpuContext {
    pub fn prepare_scene_tone_controls(&self) {
        let input = GpuImage::upload(self, &[0.0, 0.0, 0.0, 1.0], 1, 1);
        let output = self.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("scene-tone-prepare-output"),
            size: 16,
            usage: wgpu::BufferUsages::STORAGE,
            mapped_at_creation: false,
        });
        let mut encoder = self
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("scene-tone-prepare"),
            });
        SceneToneControlsPass {
            exposure: 0.0,
            brightness: 0.0,
            highlights: 0.0,
            shadows: 0.0,
            blacks: 0.0,
        }
        .encode(self, &mut encoder, &input.buffer, &output, (1, 1));
        self.queue.submit(Some(encoder.finish()));
        let _ = self.device.poll(wgpu::Maintain::Wait);
    }
}
