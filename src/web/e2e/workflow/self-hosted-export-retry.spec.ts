import { expect, test, type Page } from '@playwright/test';
import type { RecipeQueueRecord } from '../../projects/maple-common/src/lib/export/export-recipe-store';
interface Snapshot {
  record: RecipeQueueRecord;
  error: string | null;
}
interface Fixture extends Snapshot {
  key: string;
  originalHash: string;
  xml: string;
}
async function invoke<T>(page: Page, action: string): Promise<T> {
  return page.evaluate(async (name) => {
    const api = (window as unknown as { selfHostedRetry: Record<string, () => Promise<unknown>> })
      .selfHostedRetry;
    return api[name]();
  }, action) as Promise<T>;
}
async function open(page: Page) {
  await page.goto('/self-hosted-export-retry.html');
  await page.waitForFunction(() => 'selfHostedRetry' in window);
}
async function assertOriginals(page: Page, fixture: Fixture) {
  const state = await page.evaluate(
    async (key) => (await fetch('/workflow-fixture/' + key)).json(),
    fixture.key,
  );
  expect(state.hashes).toEqual([fixture.originalHash, fixture.originalHash]);
  expect(state.xml).toEqual([fixture.xml, fixture.xml]);
}
for (const lostAck of [false, true]) {
  test(`Self Hosted retry retains original identities through HTTP/IndexedDB ${lostAck ? 'lost acknowledgement and reload' : 'acknowledged repeated retry'}`, async ({
    page,
  }) => {
    await open(page);
    const initial = await invoke<Fixture>(page, 'initial');
    expect(initial.error).toBeNull();
    expect(initial.record.entries.map((entry) => entry.status)).toEqual(['failed', 'applied']);
    const parent = initial.record.serverJobId;
    if (lostAck) {
      await page.route(
        `**/api/jobs/${parent}/retry-failed`,
        async (route) => {
          const accepted = await route.fetch();
          expect(accepted.status()).toBe(201);
          await route.abort('failed');
        },
        { times: 1 },
      );
    }
    const retry = await invoke<Snapshot>(page, 'retry');
    expect(retry.record.retryOf).toBe(parent);
    expect(retry.record.targets).toEqual([initial.record.targets[0]]);
    const id = retry.record.serverJobId;
    if (lostAck) expect(retry.error).not.toBeNull();
    else expect(retry.record.entries.map((entry) => entry.status)).toEqual(['failed']);
    await open(page); // A real document reload restores the saved queue from IndexedDB.
    const resumed = await invoke<Snapshot>(page, 'resume');
    expect(resumed.error).toBeNull();
    expect(resumed.record.serverJobId).toBe(id);
    expect(resumed.record.retryOf).toBe(parent);
    expect(resumed.record.entries).toEqual([
      expect.objectContaining({ status: 'failed', reason: expect.stringContaining('original') }),
    ]);
    const repeated = await invoke<Snapshot>(page, 'retry');
    expect(repeated.record.retryOf).toBe(id);
    expect(repeated.record.entries).toEqual([
      expect.objectContaining({ status: 'failed', reason: expect.stringContaining('original') }),
    ]);
    await assertOriginals(page, initial);
  });
}
