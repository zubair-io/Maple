import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';
test.use({
  launchOptions: {
    args: [
      '--enable-unsafe-webgpu',
      ...(process.platform === 'darwin' ? ['--use-angle=metal'] : []),
    ],
  },
});
for (const backend of ['hosted', 'self-hosted'] as const) {
  for (const gpu of [false, true]) {
    test(`${backend}: real ${gpu ? 'WebGPU' : 'CPU'} before pixels, variants and original preservation`, async ({
      page,
    }) => {
      test.setTimeout(180000);
      await page.goto('http://localhost:4520');
      await page.waitForFunction(() => Reflect.get(window, 'workflowUI'));
      const result = await page.evaluate(
        ({ backend, gpu }) => Reflect.get(window, 'workflowUI').comparisonWorkflow(backend, gpu),
        { backend, gpu },
      );
      for (const key of [
        'actualDifferentPixels',
        'baselineMatchesOpening',
        'variantMatchesOwnOpening',
        'currentModelUnchangedByCompare',
        'primaryUnchangedByVariant',
        'unchangedDuringComparison',
        'comparisonDoesNotWriteXMP',
        'exitDoesNotWriteXMP',
        'originalUnchanged',
      ]) {
        expect(result[key], `${key}: ${JSON.stringify(result)}`).toBe(true);
      }
    });
  }
}

for (const gpu of [false, true]) {
  test(`camera DNG: actual ${gpu ? 'WebGPU' : 'CPU'} photographic comparison`, async ({ page }) => {
    test.skip(
      !existsSync(resolve('../../test-fixtures/raws/test_0017.dng')),
      'Camera DNG is gitignored; synthetic RAW cases remain mandatory.',
    );
    test.setTimeout(240000);
    await page.goto('http://localhost:4520');
    await page.waitForFunction(() => Reflect.get(window, 'workflowUI'));
    const result = await page.evaluate(
      (gpu) => Reflect.get(window, 'workflowUI').comparisonWorkflow('hosted', gpu, true),
      gpu,
    );
    for (const key of [
      'actualDifferentPixels',
      'baselineMatchesOpening',
      'variantMatchesOwnOpening',
      'currentModelUnchangedByCompare',
      'primaryUnchangedByVariant',
      'comparisonDoesNotWriteXMP',
      'exitDoesNotWriteXMP',
      'originalUnchanged',
    ])
      expect(result[key], `${key}: ${JSON.stringify(result)}`).toBe(true);
  });
}
