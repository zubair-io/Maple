import { expect, test } from '@playwright/test';
for (const deployment of ['Hosted', 'Self Hosted']) {
  test(`${deployment}: geometry gestures preserve photo ownership, immediate edits and Undo`, async ({
    page,
  }, testInfo) => {
    test.setTimeout(120000);
    await page.goto('http://localhost:4520');
    await page.waitForFunction(() => Reflect.get(window, 'workflowUI')?.ready);
    const result = await page.evaluate(
      (deployment) => Reflect.get(window, 'workflowUI').geometryGestureWorkflow(deployment),
      deployment,
    );
    expect(result.originalBytesPreserved).toBe(true);
    expect(result.evidence).toHaveLength(28);
    await testInfo.attach('geometry-gesture-ownership', {
      body: JSON.stringify(result, null, 2),
      contentType: 'application/json',
    });
  });
}
