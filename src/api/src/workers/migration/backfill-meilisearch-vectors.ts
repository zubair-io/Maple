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
import { MigrationBlockedError } from './types.ts';

const BACKFILL_BATCH_SIZE = 50;

export const backfillMeilisearchVectors: Migration = {
  id: BACKFILL_MEILISEARCH_VECTORS_ID,
  title: 'Backfill semantic-search index',
  description:
    'Bulk-indexes existing assets in Meilisearch and generates vectors when semantic search is ' +
    'enabled. Progress is durable, failed writes retry without advancing, and bad rows are ' +
    'dead-lettered so the migration can finish.',
  preferredBatchSize: BACKFILL_BATCH_SIZE,
  selfReportsCompletion: true,

  countRemaining: countMeilisearchBackfillRemaining,

  async runBatch(batchSize) {
    if (!meilisearchClient().semanticConfigured()) {
      throw new Error(
        'Enable semantic search in Settings → Workers before enabling this migration.',
      );
    }
    const result = await runMeilisearchBackfill(batchSize, false);
    if (result.retryable) {
      const detail = result.retryableError ? ` Cause: ${result.retryableError}` : '';
      const message = result.blocked
        ? `Meilisearch rejected the batch ${5} times; migration paused with its cursor retained. ` +
          `Fix the reported cause, then re-enable it to resume.${detail}`
        : `Meilisearch rejected the bulk batch; cursor retained for automatic retry.${detail}`;
      if (result.blocked) throw new MigrationBlockedError(message);
      throw new Error(message);
    }
    return {
      processed: Math.max(0, result.scanned - result.errors),
      errors: result.errors,
      complete: result.complete,
    };
  },
};
