import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';

const raw = [
  ...readFileSync(resolve(process.cwd(), '../../test-fixtures/batch-transfer/source.dng')),
];
for (const variant of ['plain', 'film', 'fallback'] as const) {
  test(`Hosted ${variant} cold RAW cache preserves authored XMP pixels`, async ({ page }) => {
    await page.goto('/');
    const result = await page.evaluate(
      async ({ raw, variant }) => {
        const host = await import('./hosted-raw-cache-test.ts');
        return host.run({ raw, film: variant === 'film', fallback: variant === 'fallback' });
      },
      { raw, variant },
    );
    expect(result).toMatchObject({
      exactPixels: true,
      differsFromCamera: true,
      originalUnchanged: true,
      xmpUnchanged: true,
    });
    if (variant !== 'fallback')
      expect(result).toMatchObject({ warmMatches: true, coldMatches: true });
  });
}
for (const failure of ['malformed', 'directory', 'develop'] as const) {
  test(`Hosted ${failure} failure never publishes camera-original pixels`, async ({ page }) => {
    await page.goto('/');
    const result = await page.evaluate(
      async ({ raw, failure }) => {
        const host = await import('./hosted-raw-cache-test.ts');
        return host.run({ raw, failure });
      },
      { raw, failure },
    );
    expect(result).toMatchObject({ rejected: true, cacheExists: false });
  });
}

test('Hosted refuses to persist a render when its real XMP changes during develop', async ({
  page,
}) => {
  await page.goto('/');
  const result = await page.evaluate(async (raw) => {
    const host = await import('./hosted-raw-cache-test.ts');
    return host.run({ raw, race: true });
  }, raw);
  expect(result).toMatchObject({ displayed: true, cacheExists: false });
});
