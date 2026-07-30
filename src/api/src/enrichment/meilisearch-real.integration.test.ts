import { describe, expect, it } from 'bun:test';
import { createMeilisearchClient, type MeilisearchAssetDoc } from './meilisearch-client.ts';

const url = process.env.MAPLE_MEILISEARCH_INTEGRATION_URL;

async function waitUntilHealthy(client: ReturnType<typeof createMeilisearchClient>): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (await client.health()) return;
    await Bun.sleep(250);
  }
  throw new Error('real Meilisearch service did not become healthy');
}

function doc(
  id: string,
  filename: string,
  searchBlob: string,
  capturedAt: string | null = null,
): MeilisearchAssetDoc {
  return {
    id,
    filename,
    searchBlob,
    folderId: '64b64c16ab08e6c474227abc',
    capturedAt,
    deletedAt: null,
    hidden: false,
    mediaType: 'image',
  };
}

describe('real Meilisearch compatibility', () => {
  it.skipIf(!url)(
    'creates the managed index, waits for tasks, and preserves exact identifiers',
    async () => {
      const client = createMeilisearchClient({
        url,
        semantic: false,
        taskPollIntervalMs: 10,
        taskTimeoutMs: 30_000,
      });
      await waitUntilHealthy(client);
      await client.ensureIndex();
      await client.upsertBatchOrThrow!([
        doc('integration-exact', 'IMG_4185.MOV', 'camera clip'),
        doc('integration-other', 'vacation.jpg', 'beach sunset'),
      ]);

      const result = await client.search('IMG_4185.MOV', { limit: 2 });

      expect(result.ids[0]).toBe('integration-exact');
    },
  );

  // `capturedAt` is indexed as a UTC ISO string, and the capture-window
  // filter leans on Meilisearch comparing two same-typed values
  // lexicographically. A mocked fetch cannot prove that — only a real server
  // can — so this exercises the range against the live filter engine, with an
  // unbounded control so a filter that silently matches nothing can't pass.
  it.skipIf(!url)('filters a capture-date window on a real server', async () => {
    const client = createMeilisearchClient({
      url,
      semantic: false,
      taskPollIntervalMs: 10,
      taskTimeoutMs: 30_000,
    });
    await waitUntilHealthy(client);
    await client.ensureIndex();
    await client.upsertBatchOrThrow!([
      doc('range-2023', 'a.jpg', 'harbour regatta', '2023-06-15T12:00:00.000Z'),
      doc('range-2024', 'b.jpg', 'harbour regatta', '2024-06-15T12:00:00.000Z'),
      doc('range-2025', 'c.jpg', 'harbour regatta', '2025-06-15T12:00:00.000Z'),
      doc('range-null', 'd.jpg', 'harbour regatta', null),
    ]);
    const idsFor = async (opts: Parameters<typeof client.search>[1]) =>
      (await client.search('harbour regatta', { limit: 50, ...opts })).ids
        .filter((id) => id.startsWith('range-'))
        .sort();

    // Control: unbounded sees every row, so an empty filtered result below is
    // a real exclusion rather than a query that matched nothing at all.
    expect(await idsFor({})).toEqual(['range-2023', 'range-2024', 'range-2025', 'range-null']);

    // `to: 2024-12-31` becomes the following midnight, exclusive.
    expect(
      await idsFor({
        capturedFrom: '2024-01-01T00:00:00.000Z',
        capturedBefore: '2025-01-01T00:00:00.000Z',
      }),
    ).toEqual(['range-2024']);
    expect(await idsFor({ capturedFrom: '2024-01-01T00:00:00.000Z' })).toEqual([
      'range-2024',
      'range-2025',
    ]);
    expect(await idsFor({ capturedBefore: '2024-01-01T00:00:00.000Z' })).toEqual(['range-2023']);
    // The lower bound is inclusive of an exactly-equal instant.
    expect(await idsFor({ capturedFrom: '2024-06-15T12:00:00.000Z' })).toEqual([
      'range-2024',
      'range-2025',
    ]);
  });
});
