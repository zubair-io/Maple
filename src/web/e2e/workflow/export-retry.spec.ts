import { expect, test } from '@playwright/test';
for (const scenario of ['new', 'legacy', 'legacy-filtered', 'missing', 'unrelated']) {
  test(`browser export retry protects original identities: ${scenario}`, async ({ page }) => {
    await page.goto('/export-retry.html');
    await page.waitForFunction(() => 'exportOriginalRetryRegression' in window);
    const result = await page.evaluate(async (value) => {
      const run = (
        window as unknown as {
          exportOriginalRetryRegression: (scenario: string) => Promise<{
            first: { status: string; reason?: string }[];
            retried: { status: string; reason?: string }[];
            reloaded: { status: string; reason?: string }[];
            protectedCount: number | null;
            a: string;
            b: string;
            sidecar: string;
            xmp: string;
            renderCalls: number;
            output: string | null;
          }>;
        }
      ).exportOriginalRetryRegression;
      return run(value);
    }, scenario);
    expect(result.a).toBe('original-A');
    expect(result.b).toBe('original-B');
    expect(result.sidecar).toBe(result.xmp);
    if (scenario === 'unrelated') {
      expect(result.first.map((entry) => entry.status)).toEqual(['failed']);
      expect(result.retried.map((entry) => entry.status)).toEqual(['applied']);
      expect(result.output).toBe('export-0');
      expect(result.renderCalls).toBe(2);
    } else {
      expect(result.first.map((entry) => entry.status)).toEqual(
        scenario === 'legacy-filtered' ? ['failed'] : ['failed', 'applied'],
      );
      for (const entries of [result.retried, result.reloaded]) {
        expect(entries.every((entry) => entry.status === 'failed')).toBe(true);
        expect(
          entries.every((entry) => /original photo|identity unavailable/.test(entry.reason ?? '')),
        ).toBe(true);
      }
      expect(result.protectedCount).toBe(scenario.startsWith('legacy') ? null : 2);
      expect(result.renderCalls).toBe(scenario === 'legacy-filtered' ? 0 : 1);
    }
  });
}
