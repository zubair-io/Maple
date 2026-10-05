import { expect, type Page } from '@playwright/test';

/** Bounds and RGB content, independently of alpha or status labels. */
export async function expectProfileCanvas(page: Page, gpu: boolean): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate((gpu) => {
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
        }, gpu),
      { timeout: 10000 },
    )
    .toBe(true);
}
