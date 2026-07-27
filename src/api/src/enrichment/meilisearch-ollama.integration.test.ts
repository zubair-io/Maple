import { describe, expect, it } from 'bun:test';
import { createMeilisearchClient, type MeilisearchAssetDoc } from './meilisearch-client.ts';

const enabled = process.env.MAPLE_OLLAMA_INTEGRATION === '1';
const meiliUrl = process.env.MAPLE_MEILISEARCH_INTEGRATION_URL;
const ollamaUrl = process.env.MAPLE_OLLAMA_INTEGRATION_URL;

function doc(id: string, filename: string, searchBlob: string): MeilisearchAssetDoc {
  return {
    id,
    filename,
    searchBlob,
    description: searchBlob,
    folderId: '64b64c16ab08e6c474227abc',
    capturedAt: null,
    deletedAt: null,
    hidden: false,
    mediaType: 'image',
  };
}

describe('real Meilisearch + Ollama semantic relevance', () => {
  it.skipIf(!enabled || !meiliUrl || !ollamaUrl)(
    'keeps identifiers lexical and ranks an HVAC concept with bge-m3',
    async () => {
      const client = createMeilisearchClient({
        url: meiliUrl,
        semantic: true,
        embedderUrl: ollamaUrl!,
        embedderModel: 'bge-m3',
        semanticRatio: 0.7,
        taskPollIntervalMs: 100,
        taskTimeoutMs: 10 * 60_000,
      });
      await client.ensureIndex();
      await client.upsertBatchOrThrow!([
        doc(
          'semantic-hvac',
          'service-call.jpg',
          'technician installs compressor condenser ductwork',
        ),
        doc('semantic-party', 'birthday.jpg', 'birthday cake candles family celebration'),
        doc('semantic-exact', 'IMG_4185.MOV', 'short camera clip'),
      ]);

      const concept = await client.search('HVAC air conditioning installation', {
        semantic: true,
        limit: 3,
      });
      const identifier = await client.search('IMG_4185.MOV', { semantic: true, limit: 3 });
      expect(concept.ids[0]).toBe('semantic-hvac');
      expect(identifier.ids[0]).toBe('semantic-exact');
    },
  );
});
