import type { ScopeSnapshot } from './raw-pipeline.types';

/** Owned WASM result; its getter copies bytes out before the handle is freed. */
export interface WebScopePixels {
  readonly width: number;
  readonly height: number;
  readonly rgba: Uint8Array;
  free(): void;
}

/**
 * Preserve the old sRGB scope contract for a display-P3 canvas without reading
 * that live GPU canvas. Only the already sampled, CPU-owned bytes enter this
 * reusable 2D canvas; the browser performs the same color-space conversion.
 */
export class ScopeColorConverter {
  private canvas: OffscreenCanvas | null = null;

  convert(pixels: WebScopePixels, colorSpace: string): ScopeSnapshot {
    const { width, height } = pixels;
    let rgba = pixels.rgba;
    if (rgba.length !== width * height * 4 || width < 1 || height < 1) {
      throw new Error('Invalid GPU scope sample dimensions');
    }
    if (colorSpace === 'display-p3') rgba = this.toSrgb(rgba, width, height);
    const rgb = new Uint8Array(width * height * 3);
    for (let source = 0, target = 0; source < rgba.length; source += 4, target += 3) {
      rgb[target] = rgba[source];
      rgb[target + 1] = rgba[source + 1];
      rgb[target + 2] = rgba[source + 2];
    }
    return { width, height, rgb: rgb.buffer };
  }

  private toSrgb(rgba: Uint8Array, width: number, height: number): Uint8Array {
    this.canvas ??= new OffscreenCanvas(width, height);
    if (this.canvas.width !== width) this.canvas.width = width;
    if (this.canvas.height !== height) this.canvas.height = height;
    const context = this.canvas.getContext('2d', {
      colorSpace: 'srgb',
      willReadFrequently: true,
    });
    if (!context) throw new Error('sRGB scope conversion canvas unavailable');
    const image = new ImageData(new Uint8ClampedArray(rgba), width, height, {
      colorSpace: 'display-p3',
    });
    context.putImageData(image, 0, 0);
    return new Uint8Array(context.getImageData(0, 0, width, height).data.buffer);
  }
}
