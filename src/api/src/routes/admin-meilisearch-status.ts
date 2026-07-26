import { Elysia } from 'elysia';
import { assetsCollection, getDb } from '../db/client.ts';
import { EMBEDDER_NAME, meilisearchClient } from '../enrichment/meilisearch-client.ts';
import {
  DEFAULT_MEILISEARCH_EMBEDDER_MODEL,
  DEFAULT_MEILISEARCH_SEMANTIC_RATIO,
} from '../enrichment/meilisearch-config.ts';
import type { MeilisearchSemanticStatus } from '../enrichment/meilisearch-client.ts';
import type { BackfillState } from '../enrichment/meilisearch-backfill.ts';

const unavailableStatus = (): MeilisearchSemanticStatus => ({
  configured: false,
  enabled: false,
  embedderName: EMBEDDER_NAME,
  model: DEFAULT_MEILISEARCH_EMBEDDER_MODEL,
  semanticRatio: DEFAULT_MEILISEARCH_SEMANTIC_RATIO,
  meilisearchReachable: false,
  embedderConfigured: false,
  embedderReachable: false,
  indexedDocumentCount: null,
  vectorizedDocumentCount: null,
  isIndexing: null,
  error: 'status_not_supported',
});

export const adminMeilisearchStatusRoutes = new Elysia({
  prefix: '/api/admin/enrichment',
}).get('/meilisearch-status', async () => {
  const client = meilisearchClient();
  const [semantic, liveDocumentCount, backfill] = await Promise.all([
    client.semanticStatus?.() ?? Promise.resolve(unavailableStatus()),
    (await assetsCollection()).countDocuments({
      deleted_at: { $in: [null] },
      fileinfo: {
        $elemMatch: {
          deleted_at: { $in: [null] },
          missing_since: { $in: [null] },
        },
      },
    }),
    (await getDb())
      .collection<BackfillState>('meilisearch_backfill_state')
      .findOne({ _id: 'assets' }),
  ]);
  return {
    semantic,
    documents: {
      live: liveDocumentCount,
      indexed: semantic.indexedDocumentCount,
      vectorized: semantic.vectorizedDocumentCount,
    },
    backfill: backfill
      ? {
          status: backfill.completed_at
            ? backfill.errors > 0
              ? 'complete_with_errors'
              : 'complete'
            : 'in_progress',
          scanned: backfill.scanned,
          upserted: backfill.upserted,
          tombstoned: backfill.tombstoned ?? 0,
          skipped: backfill.skipped,
          errors: backfill.errors,
          startedAt: backfill.started_at,
          updatedAt: backfill.updated_at,
          completedAt: backfill.completed_at,
        }
      : {
          status: 'not_started',
          scanned: 0,
          upserted: 0,
          tombstoned: 0,
          skipped: 0,
          errors: 0,
          startedAt: null,
          updatedAt: null,
          completedAt: null,
        },
  };
});
