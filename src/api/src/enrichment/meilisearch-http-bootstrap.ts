import { child as childLogger } from '../log.ts';
import { loadEnrichmentConfig } from './enrichment-config.repo.ts';
import { resolveEnrichmentConfig } from './enrichment-config.resolve.ts';
import { meilisearchClient, reconfigureMeilisearch } from './meilisearch-client.ts';
import { configureServiceSearchRateLimit } from './service-search-rate-limit.ts';

const log = childLogger('meilisearch:http-bootstrap');

export async function initializeHttpSearch(): Promise<void> {
  try {
    const resolved = resolveEnrichmentConfig(await loadEnrichmentConfig());
    configureServiceSearchRateLimit(resolved.service_search_rate_limit_per_minute);
    reconfigureMeilisearch(
      resolved.meilisearch_url,
      resolved.meilisearch_api_key,
      resolved.meilisearch_task_timeout_seconds * 1000,
    );
    const client = meilisearchClient();
    if (!client.isConfigured()) {
      log.info('Meilisearch URL unset — search sidecar disabled');
      return;
    }
    if (!(await client.health())) {
      log.warn('Meilisearch unreachable — search will fall back to Mongo text search');
      return;
    }
    await client.ensureIndex();
    log.info({ semanticEnabled: client.semanticConfigured() }, 'Meilisearch search sidecar ready');
  } catch (error) {
    log.warn({ err: error }, 'Meilisearch setup failed — search will fall back to Mongo');
  }
}
