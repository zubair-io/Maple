import { Elysia } from 'elysia';
import { assetsCollection, getDb } from '../db/client.ts';
import {
  DEFAULT_EMBEDDER_MODEL,
  DEFAULT_SEMANTIC_RATIO,
  EMBEDDER_NAME,
  meilisearchClient,
  type MeilisearchSemanticStatus,
} from '../enrichment/meilisearch-client.ts';

interface BackfillState {
  _id: string;
  cursor: unknown;
  scanned: number;
  upserted: number;
  skipped: number;
  errors: number;
  started_at: string;
  updated_at: string;
  completed_at: string | null;
}

const unavailableStatus = (): MeilisearchSemanticStatus => ({
  configured: false,
  enabled: false,
  embedderName: EMBEDDER_NAME,
  model: process.env.MAPLE_MEILISEARCH_EMBEDDER_MODEL?.trim() || DEFAULT_EMBEDDER_MODEL,
  semanticRatio: (() => {
    const ratio = Number(process.env.MAPLE_MEILISEARCH_SEMANTIC_RATIO);
    return Number.isFinite(ratio) ? Math.min(1, Math.max(0, ratio)) : DEFAULT_SEMANTIC_RATIO;
  })(),
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
  const vectorCoverage =
    semantic.vectorizedDocumentCount === null || liveDocumentCount === 0
      ? liveDocumentCount === 0
        ? 1
        : null
      : Math.min(1, semantic.vectorizedDocumentCount / liveDocumentCount);

  return {
    semantic,
    documents: {
      live: liveDocumentCount,
      indexed: semantic.indexedDocumentCount,
      vectorized: semantic.vectorizedDocumentCount,
      vectorCoverage,
    },
    backfill: backfill
      ? {
          status: backfill.completed_at ? 'complete' : 'in_progress',
          scanned: backfill.scanned,
          upserted: backfill.upserted,
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
          skipped: 0,
          errors: 0,
          startedAt: null,
          updatedAt: null,
          completedAt: null,
        },
  };
});
