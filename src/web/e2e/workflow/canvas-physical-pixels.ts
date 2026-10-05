/** Serialized into the browser by Playwright; probes the actual visible canvas. */
export function canvasHasPresentedPixels(gpu: boolean): boolean {
  const surface = document.querySelector(
    gpu ? 'canvas[data-gpu-live]' : 'editor-image-canvas .canvas-wrap canvas',
  ) as HTMLCanvasElement | null;
  if (!surface || !surface.width || !surface.height) return false;
  const bounds = surface.closest('.canvas-wrap')?.getBoundingClientRect();
  if (!bounds || bounds.width < 1 || bounds.height < 1) return false;
  const probe = document.createElement('canvas');
  probe.width = probe.height = 32;
  const context = probe.getContext('2d');
  if (!context) return false;
  context.drawImage(surface, 0, 0, 32, 32);
  const rgba = context.getImageData(0, 0, 32, 32).data;
  return Array.from(rgba).some((value, index) => index % 4 !== 3 && value > 16);
}
