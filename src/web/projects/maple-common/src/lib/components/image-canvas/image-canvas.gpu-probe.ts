// One-time browser composition check, separate from the editor live lifecycle.
export async function probeGpuPresent(): Promise<boolean> {
  if (typeof (globalThis as any).vitest !== 'undefined') return true;
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return true;
  if (typeof OffscreenCanvas === 'undefined') return false;

  // 1. Probe WebGL2 composition
  try {
    const canvas = new OffscreenCanvas(4, 4);
    const gl = canvas.getContext('webgl2');
    if (!gl) return false;
    gl.clearColor(0.5, 0.75, 1.0, 1.0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    const temp2d = new OffscreenCanvas(4, 4);
    const ctx = temp2d.getContext('2d');
    if (!ctx) return false;
    ctx.drawImage(canvas, 0, 0);
    const imgData = ctx.getImageData(0, 0, 4, 4);
    const pixel = imgData.data;
    if (pixel[0] === 0 && pixel[1] === 0 && pixel[2] === 0 && pixel[3] === 0) {
      return false; // Broken presentation
    }
  } catch {
    return false;
  }

  // 2. Probe WebGPU composition if supported
  const nav = navigator as any;
  if (nav.gpu) {
    try {
      const adapter = await nav.gpu.requestAdapter();
      if (!adapter) return false;
      const device = await adapter.requestDevice();
      if (!device) return false;

      const canvas = new OffscreenCanvas(4, 4);
      const context = (canvas as any).getContext('webgpu');
      if (!context) {
        device.destroy();
        return false;
      }

      const format = nav.gpu.getPreferredCanvasFormat();
      context.configure({
        device,
        format,
        usage: 16 | 1, // GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC
      });

      const encoder = device.createCommandEncoder();
      const renderPass = encoder.beginRenderPass({
        colorAttachments: [
          {
            view: context.getCurrentTexture().createView(),
            clearValue: { r: 0.5, g: 0.75, b: 1.0, a: 1.0 },
            loadOp: 'clear',
            storeOp: 'store',
          },
        ],
      });
      renderPass.end();
      device.queue.submit([encoder.finish()]);

      await device.queue.onSubmittedWorkDone();

      const temp2d = new OffscreenCanvas(4, 4);
      const ctx = temp2d.getContext('2d');
      if (!ctx) {
        device.destroy();
        return false;
      }
      ctx.drawImage(canvas, 0, 0);
      const imgData = ctx.getImageData(0, 0, 4, 4);
      const pixel = imgData.data;

      device.destroy();

      if (pixel[0] === 0 && pixel[1] === 0 && pixel[2] === 0 && pixel[3] === 0) {
        return false; // Broken WebGPU presentation
      }
    } catch {
      return false;
    }
  }

  return true;
}
