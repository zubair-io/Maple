import { test, expect } from '@playwright/test';

// Verify bundled webfonts (per docs/design/responsive-program/s0-primitives.md
// §3.3 / §5.2) load successfully in the running app.
//
// `document.fonts.check('400 14px Lato')` returns `true` only when a face
// matching the family + weight has been registered AND has actually loaded
// its bytes. We await `document.fonts.ready` first so the result reflects
// completed network requests (font-display: swap means the fallback paints
// first; the actual font may still be in flight on page load).
//
// jsdom does not implement `FontFace` byte-loading semantics, which is why
// this test lives in the Playwright suite rather than the vitest unit
// runner. The unit-tests do not exercise the asset pipeline.

test.describe('Bundled webfonts', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.evaluate(() => document.fonts.ready);
  });

  test('Lato Regular (400) is loaded', async ({ page }) => {
    const ok = await page.evaluate(() => document.fonts.check('400 14px "Lato"'));
    expect(ok).toBe(true);
  });

  test('Lato Bold (700) is loaded', async ({ page }) => {
    const ok = await page.evaluate(() => document.fonts.check('700 11px "Lato"'));
    expect(ok).toBe(true);
  });

  test('Merriweather Bold (700) is loaded', async ({ page }) => {
    const ok = await page.evaluate(() => document.fonts.check('700 17px "Merriweather"'));
    expect(ok).toBe(true);
  });

  test('JetBrains Mono Regular (400) is loaded', async ({ page }) => {
    const ok = await page.evaluate(() => document.fonts.check('400 12px "JetBrains Mono"'));
    expect(ok).toBe(true);
  });

  test('font assets are served with correct MIME type', async ({ page }) => {
    const fonts = [
      '/assets/fonts/Lato-Regular.woff2',
      '/assets/fonts/Lato-Bold.woff2',
      '/assets/fonts/Merriweather-Bold.woff2',
      '/assets/fonts/JetBrainsMono-Regular.woff2',
    ];
    for (const url of fonts) {
      const response = await page.request.get(url);
      expect(response.status(), `font asset ${url} should 200`).toBe(200);
      expect(response.headers()['content-type'], `MIME for ${url}`).toMatch(/font|woff2|octet/);
    }
  });
});
