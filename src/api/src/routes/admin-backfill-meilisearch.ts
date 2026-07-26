import { Elysia } from 'elysia';
import { runMeilisearchBackfill } from '../enrichment/meilisearch-backfill.ts';
import { meilisearchClient } from '../enrichment/meilisearch-client.ts';

const DEFAULT_BATCH_SIZE = 250;
const MAX_BATCH_SIZE = 1000;

function batchSize(value: unknown): number {
  const requested = Number(value ?? DEFAULT_BATCH_SIZE);
  return Number.isFinite(requested)
    ? Math.min(MAX_BATCH_SIZE, Math.max(1, Math.trunc(requested)))
    : DEFAULT_BATCH_SIZE;
}

export const meilisearchBackfillRoutes = new Elysia({
  prefix: '/api/admin/enrichment',
}).post('/backfill-meilisearch', async ({ set, query }) => {
  if (!meilisearchClient().isConfigured()) {
    set.status = 400;
    return {
      error:
        'Meilisearch is not configured. Save its URL in Settings → Workers, then retry the backfill.',
    };
  }
  return runMeilisearchBackfill(batchSize(query.batchSize), query.reset === 'true');
});
