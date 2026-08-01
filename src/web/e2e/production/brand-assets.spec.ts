import { expect, test } from '../support/production-test';

const BRAND_ASSETS = [
  { path: '/assets/brand/icon-192.png', width: 192 },
  { path: '/assets/brand/icon-512.png', width: 512 },
  { path: '/assets/brand/icon-512-maskable.png', width: 512 },
  { path: '/assets/brand/maple-mark.png', width: 480 },
] as const;

test('both production apps use the shared local Maple brand in installed Chrome', async ({
  page,
}) => {
  const externalFontRequests: string[] = [];
  page.on('request', (request) => {
    if (/fonts\.(?:googleapis|gstatic)\.com/.test(request.url())) {
      externalFontRequests.push(request.url());
    }
  });

  const response = await page.goto('/');
  expect(response?.ok()).toBe(true);

  const manifestResponse = await page.request.get('/manifest.webmanifest');
  expect(manifestResponse.ok()).toBe(true);
  const manifest = (await manifestResponse.json()) as {
    icons: readonly { src: string }[];
  };
  expect(manifest.icons.map(({ src }) => src)).toEqual([
    'assets/brand/icon-192.png',
    'assets/brand/icon-512.png',
    'assets/brand/icon-512-maskable.png',
  ]);

  for (const asset of BRAND_ASSETS) {
    const dimensions = await page.evaluate(async ({ path }) => {
      const image = new Image();
      image.src = path;
      await image.decode();
      return { width: image.naturalWidth, height: image.naturalHeight };
    }, asset);
    expect(dimensions).toEqual({ width: asset.width, height: asset.width });
  }

  expect((await page.request.get('/favicon.ico')).ok()).toBe(true);
  expect(externalFontRequests).toEqual([]);
});

test('Hosted welcome renders the shared Apple-sourced mark', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'chrome-hosted');
  await page.goto('/');
  const mark = page.locator('header img[src="assets/brand/maple-mark.png"]');
  await expect(mark).toBeVisible();
  await expect(mark).toHaveAttribute('alt', '');
});
