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

/**
 * A two-finger touch pinch through the browser's own input pipeline, left
 * held at its final spread. Resolves to the release.
 */
async function holdTouchPinch(
  page: Page,
  centre: { x: number; y: number },
  from: number,
  to: number,
): Promise<() => Promise<void>> {
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
  return async () => {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  };
}

async function touchPinch(page: Page, centre: { x: number; y: number }, from: number, to: number) {
  const release = await holdTouchPinch(page, centre, from, to);
  await release();
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

  // Read while the fingers are still down: a 1% pinch is inside the fit
  // detent, so the release settles on fit whatever the held frames drew.
  const centre = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const release = await holdTouchPinch(page, centre, 200, 202);
  await expect.poll(() => pixelScale(page)).toBeGreaterThan(0);
  await expect
    .poll(async () => Math.abs((await drawnWidth(page))! - fitted * 1.01))
    .toBeLessThanOrEqual(2);

  await release();
  await expect.poll(() => pixelScale(page)).toBe(0);
  await expect
    .poll(async () => Math.abs((await drawnWidth(page))! - fitted))
    .toBeLessThanOrEqual(2);
});

// #5743: crop, mask, heal and guided geometry draw their handles at the fit
// footprint, so the canvas holds at fit while one is armed.

async function canvasCentre(page: Page): Promise<{ x: number; y: number }> {
  const box = await page.locator('editor-image-canvas .canvas-wrap').boundingBox();
  if (!box) throw new Error('canvas has no bounds');
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

async function ctrlWheelIn(page: Page, at: { x: number; y: number }): Promise<void> {
  await page.mouse.move(at.x, at.y);
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, -300);
  await page.keyboard.up('Control');
}

function pageZoom(page: Page): Promise<{ scale: number; dpr: number }> {
  return page.evaluate(() => ({
    scale: window.visualViewport?.scale ?? 1,
    dpr: window.devicePixelRatio,
  }));
}

test('crop holds the canvas at fit against wheel, double-click and pinch', async ({ page }) => {
  await openImage(page);
  const centre = await canvasCentre(page);
  const dpr = (await pageZoom(page)).dpr;
  await page.getByRole('button', { name: 'Crop', exact: true }).first().click();
  const frame = page.locator('[data-testid="crop-overlay"] .crop-frame');
  await expect(frame).toBeVisible();
  const before = await frame.boundingBox();
  if (!before) throw new Error('crop frame has no bounds');

  const expectHeld = async () => {
    expect(await pixelScale(page)).toBe(0);
    const after = await frame.boundingBox();
    for (const key of ['x', 'y', 'width', 'height'] as const) {
      expect(Math.abs(after![key] - before[key])).toBeLessThanOrEqual(1);
    }
    expect(await pageZoom(page)).toEqual({ scale: 1, dpr });
  };

  await ctrlWheelIn(page, { x: centre.x, y: centre.y - 150 });
  await expectHeld();
  await page.screenshot({ path: test.info().outputPath('crop-held.png') });

  await page.mouse.dblclick(centre.x, centre.y - 150);
  await expectHeld();

  await touchPinch(page, centre, 100, 300);
  await expectHeld();
});

test('with no tool armed the same ctrl+wheel zooms', async ({ page }) => {
  await openImage(page);
  await ctrlWheelIn(page, await canvasCentre(page));
  await expect.poll(() => pixelScale(page)).toBeGreaterThan(0);
});

test('leaving crop releases the hold', async ({ page }) => {
  await openImage(page);
  const centre = await canvasCentre(page);
  await page.getByRole('button', { name: 'Crop', exact: true }).first().click();
  await expect(page.locator('[data-testid="crop-overlay"] .crop-frame')).toBeVisible();
  await ctrlWheelIn(page, centre);
  expect(await pixelScale(page)).toBe(0);

  await page.getByRole('button', { name: 'Done cropping', exact: true }).click();
  await expect(page.locator('[data-testid="crop-overlay"]')).toHaveCount(0);
  expect(await pixelScale(page)).toBe(0);

  await ctrlWheelIn(page, centre);
  await expect.poll(() => pixelScale(page)).toBeGreaterThan(0);
});

for (const tool of ['Mask', 'Heal']) {
  test(`${tool.toLowerCase()} holds the canvas at fit`, async ({ page }) => {
    await openImage(page);
    await page.getByRole('button', { name: tool, exact: true }).first().click();
    await expect(page.getByTestId(tool === 'Mask' ? 'mask-panel' : 'retouch-panel')).toBeVisible();
    await ctrlWheelIn(page, await canvasCentre(page));
    expect(await pixelScale(page)).toBe(0);
  });
}

// #5816: the press that started a scrub at fit keeps scrubbing after Z zooms
// to 100% mid-drag; it never turns into a pan.

function pan(page: Page): Promise<{ x: number; y: number }> {
  return page.evaluate(() => {
    const ng = (window as unknown as { ng: { getComponent(el: Element): unknown } }).ng;
    const canvas = ng.getComponent(document.querySelector('editor-image-canvas')!) as {
      canvasSvc: { pan(): { x: number; y: number } };
    };
    return canvas.canvasSvc.pan();
  });
}

/** True while a plain drag on the photo is the scrub rather than a pan; the canvas publishes it a frame after a zoom. */
function pointerEdits(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const ng = (window as unknown as { ng: { getComponent(el: Element): unknown } }).ng;
    const canvas = ng.getComponent(document.querySelector('editor-image-canvas')!) as {
      canvasSvc: { pointerEditsAtZoom(): boolean };
    };
    return canvas.canvasSvc.pointerEditsAtZoom();
  });
}

/** Presses on the photo, scrubs Exposure right, then zooms to 100% with the button still down. */
async function scrubThenZoomTo100(page: Page, centre: { x: number; y: number }) {
  const startExposure = (await exposure(page))!;
  await page.mouse.move(centre.x, centre.y);
  await page.mouse.down();
  await page.mouse.move(centre.x + 50, centre.y, { steps: 5 });
  await expect.poll(() => exposure(page)).toBeGreaterThan(startExposure);
  const scrubbed = (await exposure(page))!;

  await page.keyboard.press('z');
  await expect.poll(() => pixelScale(page)).toBe(1);
  await expect.poll(() => pointerEdits(page)).toBe(false);
  return { scrubbed, zoomedPan: await pan(page) };
}

test('a scrub keeps scrubbing and never pans when Z zooms to 100% mid-drag', async ({ page }) => {
  await openImage(page);
  const centre = await canvasCentre(page);
  const { scrubbed, zoomedPan } = await scrubThenZoomTo100(page, centre);

  await page.mouse.move(centre.x + 250, centre.y + 80, { steps: 10 });
  await expect.poll(() => exposure(page)).toBeGreaterThan(scrubbed);
  expect(await pan(page)).toEqual(zoomedPan);
  await page.mouse.up();
  expect(await pan(page)).toEqual(zoomedPan);
});

test('after the scrub is released at 100%, a new drag pans and leaves Exposure alone', async ({
  page,
}) => {
  await openImage(page);
  const centre = await canvasCentre(page);
  const { zoomedPan } = await scrubThenZoomTo100(page, centre);
  await page.mouse.up();
  const released = await exposure(page);

  await page.mouse.move(centre.x, centre.y);
  await page.mouse.down();
  await page.mouse.move(centre.x - 120, centre.y - 60, { steps: 10 });
  await page.mouse.up();

  await expect.poll(async () => (await pan(page)).x).not.toBe(zoomedPan.x);
  expect(await exposure(page)).toBe(released);
});
