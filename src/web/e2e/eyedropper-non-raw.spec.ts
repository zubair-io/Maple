import { test, expect, type Page } from '@playwright/test';

// #5146: on a JPEG or PNG the eyedroppers used to arm, click, then surface the decoder's error.

const REASON = /not available for JPEG, PNG, X3F/;

async function encodedImage(page: Page, mime: 'image/jpeg' | 'image/png'): Promise<Buffer> {
  const bytes = await page.evaluate(async (type) => {
    const canvas = new OffscreenCanvas(64, 48);
    const ctx = canvas.getContext('2d')!;
    const gradient = ctx.createLinearGradient(0, 0, 64, 48);
    gradient.addColorStop(0, '#808080');
    gradient.addColorStop(1, '#c08040');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, 64, 48);
    const blob = await canvas.convertToBlob({ type });
    return Array.from(new Uint8Array(await blob.arrayBuffer()));
  }, mime);
  return Buffer.from(bytes);
}

for (const [name, mimeType] of [
  ['eyedropper.jpg', 'image/jpeg'],
  ['eyedropper.png', 'image/png'],
] as const) {
  test(`both eyedroppers refuse a ${mimeType} instead of surfacing a decoder error`, async ({
    page,
  }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await page.goto('/');
    await page
      .locator('input[type=file]')
      .first()
      .setInputFiles({ name, mimeType, buffer: await encodedImage(page, mimeType) });
    await page.waitForURL(/\/edit\/[0-9a-f-]+/, { timeout: 30_000 });

    await page.getByRole('button', { name: 'Color', exact: true }).click();
    const wb = page.getByRole('button', {
      name: 'Eyedropper: set neutral white balance from canvas',
    });
    await expect(wb).toBeDisabled();
    await expect(wb).toHaveAttribute('title', REASON);

    await page.getByRole('button', { name: 'Mask', exact: true }).click();
    await page.getByRole('button', { name: 'Add linear mask', exact: true }).click();
    await page.getByRole('checkbox', { name: /colour range|color range/i }).check();
    const range = page.getByTestId('mask-range-eyedropper');
    await expect(range).toBeDisabled();
    await expect(range).toHaveAttribute('title', REASON);

    expect(pageErrors.filter((message) => /rawler|decode/i.test(message))).toEqual([]);
  });
}
