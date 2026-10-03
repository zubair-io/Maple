import { expect, test } from '@playwright/test';

for (const deployment of ['Hosted', 'Self Hosted']) {
  test(`${deployment}: 100 repeated edit/reload/export cycles preserve history, metadata and original bytes`, async ({
    page,
  }, testInfo) => {
    test.setTimeout(600000);
    await page.goto('/');
    await page.waitForFunction(() => Reflect.get(window, 'workflowTest')?.ready);
    const result = await page.evaluate(
      (deployment) => Reflect.get(window, 'workflowTest').repeatedWorkflow(deployment),
      deployment,
    );
    expect(result.completed).toBe(100);
    expect(result.expected).toBe(100);
    expect(result.cycles.map((row: { cycle: number }) => row.cycle)).toEqual(
      Array.from({ length: 100 }, (_, index) => index + 1),
    );
    await testInfo.attach('repeated-workflow-cycles', {
      body: JSON.stringify(result, null, 2),
      contentType: 'application/json',
    });
  });
}
