import { test, expect, type Page } from '@playwright/test';

// #5745: each canvas layer keeps the pointer stream it started. The editor
// shell's scrub used to capture the pointer on its outer wrap, so a pinch at
// fit scrubbed Exposure; the canvas wrap captured a crop handle's pointer, so
// the handle lost its drag. Real input only: synthetic events carry no capture.

async function openImage(page: Page, size = { w: 3000, h: 2000 }): Promise<void> {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/');
  const bytes = await page.evaluate(async ({ w, h }) => {
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext('2d')!;
    const gradient = ctx.createLinearGradient(0, 0, w, h);
    gradient.addColorStop(0, '#205080');
    gradient.addColorStop(1, '#c08040');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, w, h);
    const blob = await canvas.convertToBlob({ type: 'image/jpeg' });
    return Array.from(new Uint8Array(await blob.arrayBuffer()));
  }, size);
  await page
    .locator('input[type=file]')
    .first()
    .setInputFiles({ name: 'pointer.jpg', mimeType: 'image/jpeg', buffer: Buffer.from(bytes) });
  await page.waitForURL(/\/edit\/[0-9a-f-]+/, { timeout: 30_000 });
  await expect(page.locator('editor-image-canvas canvas').first()).toBeVisible();
}

test('a crop handle keeps its drag', async ({ page }) => {
  await openImage(page);
  await page.getByRole('button', { name: 'Crop', exact: true }).first().click();
  const frame = page.locator('[data-testid="crop-overlay"] .crop-frame');
  await expect(frame).toBeVisible();
  const before = await frame.boundingBox();
  if (!before) throw new Error('crop frame has no bounds');

  const corner = { x: before.x + before.width - 1, y: before.y + before.height - 1 };
  await page.mouse.move(corner.x, corner.y);
  await page.mouse.down();
  await page.mouse.move(corner.x - 100, corner.y - 100, { steps: 10 });
  await page.mouse.up();

  await expect.poll(async () => (await frame.boundingBox())?.width).toBeLessThan(before.width - 50);
});

/** A two-finger touch pinch through the browser's own input pipeline. */
async function touchPinch(page: Page, centre: { x: number; y: number }, from: number, to: number) {
  const cdp = await page.context().newCDPSession(page);
  const points = (spread: number) => [
    { x: centre.x - spread / 2, y: centre.y, id: 1 },
    { x: centre.x + spread / 2, y: centre.y, id: 2 },
  ];
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: points(from) });
  for (let step = 1; step <= 10; step++) {
    const spread = from + ((to - from) * step) / 10;
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: points(spread) });
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

/** The canvas's committed zoom, read through Angular's dev-mode debug API. */
function pixelScale(page: Page): Promise<number> {
  return page.evaluate(() => {
    const ng = (window as unknown as { ng: { getComponent(el: Element): unknown } }).ng;
    const canvas = ng.getComponent(document.querySelector('editor-image-canvas')!) as {
      canvasSvc: { pixelScale(): number };
    };
    return canvas.canvasSvc.pixelScale();
  });
}

/** The photo's drawn width in CSS px, as the canvas publishes it. */
function drawnWidth(page: Page): Promise<number | undefined> {
  return page.evaluate(() => {
    const ng = (window as unknown as { ng: { getComponent(el: Element): unknown } }).ng;
    const canvas = ng.getComponent(document.querySelector('editor-image-canvas')!) as {
      canvasSvc: { effectivePx(): { canvasW: number } | null };
    };
    return canvas.canvasSvc.effectivePx()?.canvasW;
  });
}

function exposure(page: Page): Promise<number | undefined> {
  return page.evaluate(() => {
    const ng = (window as unknown as { ng: { getComponent(el: Element): unknown } }).ng;
    const shell = ng.getComponent(document.querySelector('editor-shell')!) as {
      editorState: { currentAdjustment(): { exposure: number } | null };
    };
    return shell.editorState.currentAdjustment()?.exposure;
  });
}

test('a pinch at fit zooms and leaves the armed value alone', async ({ page }) => {
  await openImage(page);
  const box = await page.locator('editor-image-canvas .canvas-wrap').boundingBox();
  if (!box) throw new Error('canvas has no bounds');
  const centre = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const startExposure = await exposure(page);
  expect(await pixelScale(page)).toBe(0);

  await touchPinch(page, centre, 100, 300);

  await expect.poll(() => pixelScale(page)).toBeGreaterThan(0);
  expect(await exposure(page)).toBe(startExposure);
});

// #5746: the zoom model and the draw share one fit, so a pinch's first frames
// continue from the fitted photo instead of snapping to the model's own fit.
test('a small image does not jump when a pinch starts', async ({ page }) => {
  await openImage(page, { w: 800, h: 600 });
  const box = await page.locator('editor-image-canvas .canvas-wrap').boundingBox();
  if (!box) throw new Error('canvas has no bounds');
  // 800×600 fitted into the 1280-wide canvas: the model's fit fills it.
  await expect
    .poll(() => drawnWidth(page))
    .toBe(Math.round(Math.min(box.width / 800, box.height / 600) * 800));
  const fitted = (await drawnWidth(page))!;

  await touchPinch(page, { x: box.x + box.width / 2, y: box.y + box.height / 2 }, 200, 202);

  expect(Math.abs((await drawnWidth(page))! - fitted)).toBeLessThanOrEqual(2);
});
