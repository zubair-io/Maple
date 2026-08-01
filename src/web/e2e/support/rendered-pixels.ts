import type { Locator } from '@playwright/test';

export interface RenderedPixelSample {
  readonly opaquePixels: number;
  readonly lumaRange: number;
  readonly rgba: readonly number[];
}

/** Sample the pixels Chrome actually composited for an image or canvas. */
export async function renderedPixelSample(locator: Locator): Promise<RenderedPixelSample> {
  const screenshot = await locator.screenshot({ animations: 'disabled' });
  return locator.page().evaluate(
    async (source) => {
      const image = new Image();
      image.src = source;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = 32;
      canvas.height = 32;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (!context) throw new Error('Chrome did not provide a 2D context for pixel validation');
      context.drawImage(image, 0, 0, canvas.width, canvas.height);

      const rgba = [...context.getImageData(0, 0, canvas.width, canvas.height).data];
      let opaquePixels = 0;
      let minLuma = 255;
      let maxLuma = 0;
      for (let offset = 0; offset < rgba.length; offset += 4) {
        if (rgba[offset + 3]! < 16) continue;
        opaquePixels++;
        const luma =
          rgba[offset]! * 0.2126 + rgba[offset + 1]! * 0.7152 + rgba[offset + 2]! * 0.0722;
        minLuma = Math.min(minLuma, luma);
        maxLuma = Math.max(maxLuma, luma);
      }
      return {
        opaquePixels,
        lumaRange: opaquePixels === 0 ? 0 : maxLuma - minLuma,
        rgba,
      };
    },
    `data:image/png;base64,${screenshot.toString('base64')}`,
  );
}

/** Mean absolute RGBA-channel distance, ignoring pairs of transparent pixels. */
export function renderedPixelDistance(
  left: RenderedPixelSample,
  right: RenderedPixelSample,
): number {
  if (left.rgba.length !== right.rgba.length) return Number.POSITIVE_INFINITY;
  let difference = 0;
  let channels = 0;
  for (let offset = 0; offset < left.rgba.length; offset += 4) {
    if (left.rgba[offset + 3] === 0 && right.rgba[offset + 3] === 0) continue;
    for (let channel = 0; channel < 4; channel++) {
      difference += Math.abs(left.rgba[offset + channel]! - right.rgba[offset + channel]!);
      channels++;
    }
  }
  return channels === 0 ? 0 : difference / channels;
}
