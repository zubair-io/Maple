/**
 * Migration adapter for the durable Meilisearch document/vector backfill.
 *
 * The underlying backfill owns its Mongo cursor and Meilisearch task polling;
 * this adapter exposes that work through the generic migration worker and its
 * Settings → Workers controls.
 */

import {
  countMeilisearchBackfillRemaining,
  runMeilisearchBackfill,
} from '../../enrichment/meilisearch-backfill.ts';
import { meilisearchClient } from '../../enrichment/meilisearch-client.ts';
import { BACKFILL_MEILISEARCH_VECTORS_ID } from './ids.ts';
import type { Migration } from './types.ts';

const BACKFILL_BATCH_SIZE = 500;

export const backfillMeilisearchVectors: Migration = {
  id: BACKFILL_MEILISEARCH_VECTORS_ID,
  title: 'Backfill semantic-search index',
  description:
    'Bulk-indexes existing assets in Meilisearch and generates vectors when semantic search is ' +
    'enabled. Progress is durable, failed writes retry without advancing, and bad rows are ' +
    'dead-lettered so the migration can finish.',
  preferredBatchSize: BACKFILL_BATCH_SIZE,

  countRemaining: countMeilisearchBackfillRemaining,

  async runBatch(batchSize) {
    if (!meilisearchClient().isConfigured()) {
      throw new Error('Configure the Meilisearch URL in Settings → Workers before enabling this.');
    }
    const result = await runMeilisearchBackfill(batchSize, false);
    if (result.retryable) {
      throw new Error('Meilisearch rejected the bulk batch; cursor retained for automatic retry.');
    }
    return {
      processed: Math.max(0, result.scanned - result.errors),
      errors: result.errors,
    };
  },
};
