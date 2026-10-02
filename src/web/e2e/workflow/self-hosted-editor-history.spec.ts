import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
const input = readFileSync(
  resolve('../../test-fixtures/local-adjustments/lightroom-group-add.xmp'),
  'utf8',
);
test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => Reflect.get(window, 'workflowTest')?.ready);
});
const expectations: Record<string, number[]> = {
  rapid: [0.25, 0.75, 1.25, 0.75, 1.25],
  preview: [],
  retry: [1.25],
  'retry-preview': [1.25],
  navigation: [0.5],
  'failed-navigation': [0.5],
  delayed: [0.25, 0.75, 1.25],
  compaction: Array.from({ length: 32 }, (_, index) => (index + 9) / 10),
  'model-lifetime': [1.25],
};
for (const [scenario, expected] of Object.entries(expectations)) {
  test(`Self Hosted editor ${scenario} uses real API, SQLite, native/WASM and files`, async ({
    page,
  }) => {
    const result = await page.evaluate(
      async ({ input, scenario }) =>
        Reflect.get(window, 'workflowTest').selfHostedEditorHistory(input, scenario),
      { input, scenario },
    );
    expect(result.original).toEqual([1, 0, 255, 42]);
    expect(result.cacheExact).toBe(true);
    expect(result.foreign).toBe(true);
    expect(result.state.has_xmp).toBe(1);
    expect(result.history.map((row: { exposure: number }) => row.exposure)).toEqual(expected);
    expect(result.historyCount).toBe(expected.length);
    expect(result.changes).toHaveLength(result.state.sidecar_ver);
    expect(result.state.sidecar_ver).toBeGreaterThanOrEqual(expected.length);
    if (scenario === 'rapid')
      expect(result.history.map((row: { action: string }) => row.action)).toEqual([
        'adjustment',
        'adjustment',
        'adjustment',
        'undo',
        'redo',
      ]);
    if (scenario === 'retry-preview' || scenario === 'delayed') expect(result.exposure).toBe(2.5);
  });
}

const corpus = JSON.parse(
  readFileSync(resolve('../../test-fixtures/workflow/contract-v1.json'), 'utf8'),
);
test('Self Hosted creates absent primary sidecar through actual semantic commits', async ({
  page,
}) => {
  const result = await page.evaluate(async () =>
    Reflect.get(window, 'workflowTest').selfHostedEditorHistory(null, 'rapid'),
  );
  expect(result.history.map((row: { exposure: number }) => row.exposure)).toEqual(
    expectations.rapid,
  );
  expect(result.cacheExact).toBe(true);
  expect(result.state.has_xmp).toBe(1);
  expect(result.original).toEqual([1, 0, 255, 42]);
});
test('Self Hosted compaction retains named snapshots byte for byte', async ({ page }) => {
  const result = await page.evaluate(
    async ({ input, workflow }) =>
      Reflect.get(window, 'workflowTest').selfHostedEditorHistory(input, 'compaction', workflow),
    { input, workflow: corpus[0] },
  );
  expect(result.history.map((row: { exposure: number }) => row.exposure)).toEqual(
    expectations.compaction,
  );
  expect(result.snapshots).toEqual(corpus[0].snapshots);
  expect(result.cacheExact).toBe(true);
  expect(result.foreign).toBe(true);
  expect(result.original).toEqual([1, 0, 255, 42]);
});
for (const [name, workflow, futureSchema] of [
  ['future schema', corpus[0], true],
  ['mismatched identity', corpus[1], false],
] as const) {
  test(`Self Hosted rejects ${name} without replacing actual source XML`, async ({ page }) => {
    const result = await page.evaluate(
      async ({ input, workflow, futureSchema }) =>
        Reflect.get(window, 'workflowTest').selfHostedRejectedHistory(
          input,
          workflow,
          futureSchema,
        ),
      { input, workflow, futureSchema },
    );
    expect(result.rejected).toBe(true);
    expect(result.unchanged).toBe(true);
    expect(result.pending).toBe(true);
    expect(result.phase).toBe('error');
    expect(result.original).toEqual([1, 0, 255, 42]);
    expect(result.changes).toEqual([]);
    expect(result.state.sidecar_ver).toBe(0);
  });
}
test('eight real Self Hosted clients admit one stale reader and retain every action on retry', async ({
  page,
  browser,
}) => {
  const source = await page.evaluate(
    async (input) => Reflect.get(window, 'workflowTest').selfHostedConcurrentStage(input),
    input,
  );
  const contexts = await Promise.all(Array.from({ length: 8 }, () => browser.newContext()));
  try {
    const clients = await Promise.all(
      contexts.map(async (context) => {
        const client = await context.newPage();
        await client.goto('http://localhost:4518/');
        await client.waitForFunction(() => Reflect.get(window, 'workflowTest')?.ready);
        return client;
      }),
    );
    await page.evaluate(
      async (source) => Reflect.get(window, 'workflowTest').selfHostedConcurrentGate(source, false),
      source,
    );
    const initial = await Promise.all(
      clients.map((client, index) =>
        client.evaluate(
          async ({ source, index }) =>
            Reflect.get(window, 'workflowTest').selfHostedConcurrentClient(source, index, false),
          { source, index },
        ),
      ),
    );
    await page.evaluate(
      async (source) => Reflect.get(window, 'workflowTest').selfHostedConcurrentGate(source, true),
      source,
    );
    expect(initial.filter((outcome) => outcome.accepted)).toHaveLength(1);
    const admitted = await page.evaluate(
      async (source) => Reflect.get(window, 'workflowTest').selfHostedConcurrentRead(source),
      source,
    );
    expect(admitted.distinctActions).toBe(1);
    const pending = new Set(initial.flatMap((outcome, index) => (outcome.pending ? [index] : [])));
    for (let round = 0; round < clients.length && pending.size > 0; round++) {
      const outcomes = await Promise.all(
        [...pending].map(async (index) => ({
          index,
          result: await clients[index].evaluate(
            async ({ source, index }) =>
              Reflect.get(window, 'workflowTest').selfHostedConcurrentClient(source, index, true),
            { source, index },
          ),
        })),
      );
      for (const outcome of outcomes) if (!outcome.result.pending) pending.delete(outcome.index);
    }
    expect(pending.size).toBe(0);
    const result = await page.evaluate(
      async (source) => Reflect.get(window, 'workflowTest').selfHostedConcurrentRead(source),
      source,
    );
    expect(result.exposures).toEqual([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8]);
    expect(result.distinctActions).toBe(8);
    expect(result.changes).toBe(8);
    expect(result.version).toBe(8);
    expect(result.original).toEqual([1, 0, 255, 42]);
  } finally {
    await page.evaluate(
      async (source) => Reflect.get(window, 'workflowTest').selfHostedConcurrentGate(source, true),
      source,
    );
    await Promise.all(contexts.map((context) => context.close()));
  }
});
