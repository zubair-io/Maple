import { Elysia } from 'elysia';
import { requireAuth, requireOwner } from '../auth/middleware.ts';
import { assetsCollection, getDb } from '../db/client.ts';
import { EMBEDDER_NAME, meilisearchClient } from '../enrichment/meilisearch-client.ts';
import {
  DEFAULT_MEILISEARCH_EMBEDDER_MODEL,
  DEFAULT_MEILISEARCH_SEMANTIC_RATIO,
} from '../enrichment/meilisearch-config.ts';
import type { MeilisearchSemanticStatus } from '../enrichment/meilisearch-client.ts';
import type { BackfillState } from '../enrichment/meilisearch-backfill.ts';
import { LIVE_ASSET_FILTER } from '../enrichment/meilisearch-vector-coverage.ts';

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

function backfillStatus(backfill: BackfillState): string {
  if (!backfill.completed_at) return 'in_progress';
  return backfill.errors > 0 ? 'complete_with_errors' : 'complete';
}

function backfillPayload(backfill: BackfillState | null): Record<string, unknown> {
  if (!backfill) {
    return {
      status: 'not_started',
      scanned: 0,
      upserted: 0,
      tombstoned: 0,
      skipped: 0,
      errors: 0,
      startedAt: null,
      updatedAt: null,
      completedAt: null,
    };
  }
  return {
    status: backfillStatus(backfill),
    scanned: backfill.scanned,
    upserted: backfill.upserted,
    tombstoned: backfill.tombstoned ?? 0,
    skipped: backfill.skipped,
    errors: backfill.errors,
    startedAt: backfill.started_at,
    updatedAt: backfill.updated_at,
    completedAt: backfill.completed_at,
  };
}

async function liveVectorizedCount(fingerprint: string | null): Promise<number> {
  if (!fingerprint) return 0;
  return (await assetsCollection()).countDocuments({
    ...LIVE_ASSET_FILTER,
    semantic_vector_fingerprint: fingerprint,
  } as never);
}

async function loadAdminMeilisearchStatus(): Promise<Record<string, unknown>> {
  const client = meilisearchClient();
  const fingerprint = client.semanticFingerprint?.() ?? null;
  const assets = await assetsCollection();
  const db = await getDb();
  const [semantic, liveDocumentCount, vectorizedLive, backfill] = await Promise.all([
    client.semanticStatus?.() ?? Promise.resolve(unavailableStatus()),
    assets.countDocuments(LIVE_ASSET_FILTER as never),
    liveVectorizedCount(fingerprint),
    db.collection<BackfillState>('meilisearch_backfill_state').findOne({ _id: 'assets' }),
  ]);
  return {
    semantic,
    documents: {
      live: liveDocumentCount,
      indexedRaw: semantic.indexedDocumentCount,
      vectorizedRaw: semantic.vectorizedDocumentCount,
      vectorizedLive,
      vectorCoverage: liveDocumentCount === 0 ? 1 : vectorizedLive / liveDocumentCount,
    },
    backfill: backfillPayload(backfill),
  };
}

// Owner-only (#2353): mirrors meilisearchBackfillRoutes in the same
// `/api/admin/enrichment` prefix — this surfaces the raw indexed/vectorized
// document counts and backfill progress, admin-tier operational detail that
// shouldn't be exposed to every member.
export const adminMeilisearchStatusRoutes = new Elysia({
  prefix: '/api/admin/enrichment',
})
  .use(requireAuth)
  .use(requireOwner)
  .get('/meilisearch-status', loadAdminMeilisearchStatus);
