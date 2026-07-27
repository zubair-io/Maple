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

function doc(id: string, filename: string, searchBlob: string): MeilisearchAssetDoc {
  return {
    id,
    filename,
    searchBlob,
    folderId: '64b64c16ab08e6c474227abc',
    capturedAt: null,
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
});
