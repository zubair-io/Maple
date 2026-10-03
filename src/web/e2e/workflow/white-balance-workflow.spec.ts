import { expect, test } from '@playwright/test';
import { WHITE_BALANCE_PRESETS } from '../../projects/maple-common/src/lib/generated/white-balance-presets.generated';

for (const deployment of ['Hosted', 'Self Hosted']) {
  for (const mode of [...WHITE_BALANCE_PRESETS, 'Sampled']) {
    test(`real ${deployment} ${mode} saves, undoes, reopens and exports RAW`, async ({ page }) => {
      await page.goto('/');
      await page.waitForFunction(() => Reflect.get(window, 'workflowTest')?.ready);
      const result = await page.evaluate(
        ({ mode, deployment }) =>
          Reflect.get(window, 'workflowTest')[
            deployment === 'Hosted' ? 'whiteBalanceWorkflow' : 'selfHostedWhiteBalance'
          ](mode),
        { mode, deployment },
      );
      for (const key of [
        'changed',
        'undone',
        'redone',
        'roundtrip',
        'redoPixels',
        'reopenPixels',
        'copyApplied',
        'copyPixels',
        'copyOriginalUnchanged',
        'originalUnchanged',
      ])
        expect(
          result[key],
          `${key}: ${JSON.stringify({ source: result.model, copy: result.copiedModel })}`,
        ).toBe(true);
      if (mode === 'Auto' || mode === 'Sampled')
        expect(result.model.wbAlgorithmVersion).toBeGreaterThan(0);
      if (mode === 'Sampled')
        expect([result.model.wbSampleX, result.model.wbSampleY]).toEqual([0.25, 0.75]);
    });
  }
}
