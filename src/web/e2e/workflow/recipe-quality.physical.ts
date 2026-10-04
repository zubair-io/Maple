import { test, expect, type Page } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
async function saveAndReopen(page: Page, folder: string, name: string, quality: number | null) {
  await page.getByRole('button', { name: 'Save recipe', exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(
        (name) =>
          Reflect.get(window, 'recipeQualityUI')
            .state()
            .saved.find((r: { name: string }) => r.name === name)?.quality,
        name,
      ),
    )
    .toBe(quality);
  await page.reload();
  await page.waitForFunction(() => Reflect.get(window, 'recipeQualityUI')?.ready);
  await page.evaluate((folder) => Reflect.get(window, 'recipeQualityUI').mount(folder), folder);
  await page.getByRole('button', { name, exact: true }).click();
  expect(
    await page.evaluate(() => Reflect.get(window, 'recipeQualityUI').state().recipe.quality),
  ).toBe(quality);
}
for (const format of ['jpeg', 'avif', 'webp'])
  for (const quality of format === 'avif' ? [null, 55] : format === 'jpeg' ? [55] : [null]) {
    test(`${format} ${quality ?? (format === 'webp' ? 'lossless' : 'automatic')} survives real save/reload and exports the exact shared quality`, async ({
      page,
    }) => {
      test.setTimeout(240000);
      const path = resolve('../../test-fixtures/raws/test_0007.DNG');
      test.skip(!existsSync(path), 'Physical RAW fixture is not installed');
      const bytes = readFileSync(path);
      const original = createHash('sha256').update(bytes).digest('hex');
      await page.route('**/physical-raw/test_0007.DNG', (route) =>
        route.fulfill({ body: bytes, contentType: 'application/octet-stream' }),
      );
      await page.goto('http://localhost:4522');
      await page.waitForFunction(() => Reflect.get(window, 'recipeQualityUI')?.ready);
      const folder = await page.evaluate(() => Reflect.get(window, 'recipeQualityUI').mount());
      await page.getByRole('radio', { name: `${format.toUpperCase()} 8-bit`, exact: true }).click();
      const name = `${format}-${quality ?? (format === 'webp' ? 'lossless' : 'automatic')}`;
      await page.getByLabel('Recipe name', { exact: true }).fill(name);
      if (quality === null) {
        const recipe = await page.evaluate(
          () => Reflect.get(window, 'recipeQualityUI').state().recipe,
        );
        await page.locator('input[type=file]').setInputFiles({
          name: 'automatic.json',
          mimeType: 'application/json',
          buffer: Buffer.from(
            JSON.stringify({ ...recipe, quality: format === 'webp' ? 55 : null }),
          ),
        });
        if (format === 'webp') {
          await expect
            .poll(() =>
              page.evaluate(() => Reflect.get(window, 'recipeQualityUI').state().recipe.quality),
            )
            .toBe(55);
          await saveAndReopen(page, folder, name, 55);
          await expect(
            page.getByRole('button', { name: 'Export 1 photos', exact: true }),
          ).toBeDisabled();
          await expect(
            page.getByText('Lossless formats require quality: null', { exact: true }),
          ).toBeVisible();
          await page.getByRole('button', { name: 'Use lossless quality', exact: true }).click();
        } else {
          await expect(page.getByRole('radio', { name: 'Automatic', exact: true })).toHaveAttribute(
            'aria-checked',
            'true',
          );
        }
      } else {
        await page.getByLabel('Quality', { exact: true }).fill(String(quality));
        await page.getByLabel('Quality', { exact: true }).press('Enter');
      }
      await saveAndReopen(page, folder, name, quality);
      await page.getByRole('button', { name: 'Export 1 photos', exact: true }).click();
      await page.waitForFunction(
        () => {
          const summary = Reflect.get(window, 'recipeQualityUI').state().summary;
          return summary && summary.applied.length + summary.failed.length === 1;
        },
        undefined,
        { timeout: 120000 },
      );
      const summary = await page.evaluate(
        () => Reflect.get(window, 'recipeQualityUI').state().summary,
      );
      expect(summary.failed).toEqual([]);
      expect(summary.applied).toHaveLength(1);
      const proof = await page.evaluate(() => Reflect.get(window, 'recipeQualityUI').outputProof());
      expect(proof.quality).toBe(quality);
      expect(proof.sourceHash).toBe(original);
      expect(proof.outputHash).toBe(proof.referenceHash);
      if (format !== 'webp') expect(proof.outputHash).not.toBe(proof.alternateHash);
      expect(proof.width).toBeGreaterThan(0);
      expect(Math.max(proof.width, proof.height)).toBeLessThanOrEqual(512);
      console.log('RECIPE_QUALITY_OUTPUT', JSON.stringify({ format, ...proof }));
      expect(createHash('sha256').update(readFileSync(path)).digest('hex')).toBe(original);
      await page.evaluate(() => Reflect.get(window, 'recipeQualityUI').dispose());
    });
  }
