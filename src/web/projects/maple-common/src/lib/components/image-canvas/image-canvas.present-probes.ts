// One-time browser composition probes, outside the live render loop.
function hasPresentedPixel(canvas: OffscreenCanvas): boolean {
  const ctx = new OffscreenCanvas(4, 4).getContext('2d');
  if (!ctx) return false;
  ctx.drawImage(canvas, 0, 0);
  const pixel = ctx.getImageData(0, 0, 4, 4).data;
  return pixel[0] !== 0 || pixel[1] !== 0 || pixel[2] !== 0;
}

export function probeWebGlPresent(): boolean {
  try {
    const canvas = new OffscreenCanvas(4, 4);
    const gl = canvas.getContext('webgl2');
    if (!gl) return false;
    gl.clearColor(0.5, 0.75, 1.0, 1.0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    return hasPresentedPixel(canvas);
  } catch {
    return false;
  }
}

export async function probeWebGpuPresent(): Promise<boolean> {
  const nav = navigator as any;
  if (!nav.gpu) return true;
  try {
    const adapter = await nav.gpu.requestAdapter();
    if (!adapter) return false;
    const device = await adapter.requestDevice();
    if (!device) return false;

    try {
      const canvas = new OffscreenCanvas(4, 4);
      const context = (canvas as any).getContext('webgpu');
      if (!context) {
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

      const presented = hasPresentedPixel(canvas);
      return presented;
    } finally {
      device.destroy();
    }
  } catch {
    return false;
  }
}
