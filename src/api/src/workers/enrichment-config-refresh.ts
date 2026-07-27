/**
 * Cross-process enrichment configuration refresh for the worker tier.
 *
 * Settings are saved by the HTTP process, while stages and migrations run in
 * a child process. Polling the single DB-backed config row keeps the worker
 * singleton caches current without adding a Mongo read to each asset or search.
 */

import { applyDescribeConfig } from '../enrichment/describe-bootstrap.ts';
import { loadEnrichmentConfig } from '../enrichment/enrichment-config.repo.ts';
import {
  resolveEnrichmentConfig,
  type ResolvedEnrichmentConfig,
} from '../enrichment/enrichment-config.resolve.ts';
import { meilisearchClient, reconfigureMeilisearch } from '../enrichment/meilisearch-client.ts';
import { child as childLogger } from '../log.ts';
import { advanceKnownVectorCoverage } from '../enrichment/meilisearch-vector-coverage.ts';

const log = childLogger('workers:enrichment-config');
const DEFAULT_REFRESH_MS = 2_000;
const READINESS_RETRY_MS = 30_000;

let refreshTimer: ReturnType<typeof setInterval> | null = null;
let refreshInFlight = false;
let appliedFingerprint: string | null = null;
let lastReadinessAttemptAt = 0;
let readyVectorFingerprint: string | null = null;

export function workerEnrichmentFingerprint(config: ResolvedEnrichmentConfig): string {
  return JSON.stringify({
    describeWorkerEnabled: config.describe_worker_enabled,
    describeUrl: config.describe_provider_url,
    meiliUrl: config.meilisearch_url,
    meiliApiKey: config.meilisearch_api_key,
    meiliTaskTimeoutSeconds: config.meilisearch_task_timeout_seconds,
    semanticEnabled: config.meilisearch_semantic_enabled,
    embedderUrl: config.meilisearch_embedder_url,
    embedderModel: config.meilisearch_embedder_model,
    semanticRatio: config.meilisearch_semantic_ratio,
  });
}

function applyMeilisearchConfig(config: ResolvedEnrichmentConfig): void {
  reconfigureMeilisearch({
    url: config.meilisearch_url,
    apiKey: config.meilisearch_api_key,
    taskTimeoutMs: config.meilisearch_task_timeout_seconds * 1000,
    semanticEnabled: config.meilisearch_semantic_enabled,
    embedderUrl: config.meilisearch_embedder_url,
    embedderModel: config.meilisearch_embedder_model,
    semanticRatio: config.meilisearch_semantic_ratio,
  });
}

async function ensureMeilisearchReady(): Promise<boolean> {
  const meili = meilisearchClient();
  if (!meili.isConfigured()) return true;
  if (!(await meili.health())) return false;
  await meili.ensureIndex();
  const fingerprint = meili.semanticFingerprint?.() ?? null;
  if (fingerprint && fingerprint !== readyVectorFingerprint) {
    await advanceKnownVectorCoverage(fingerprint);
    readyVectorFingerprint = fingerprint;
  }
  return true;
}

export async function refreshWorkerEnrichmentConfig(force = false): Promise<boolean> {
  const resolved = resolveEnrichmentConfig(await loadEnrichmentConfig());
  const fingerprint = workerEnrichmentFingerprint(resolved);
  const changed = force || fingerprint !== appliedFingerprint;
  const readinessDue = Date.now() - lastReadinessAttemptAt >= READINESS_RETRY_MS;
  if (!changed && !readinessDue) return false;

  if (changed) {
    applyMeilisearchConfig(resolved);
    await applyDescribeConfig(resolved);
    appliedFingerprint = fingerprint;
    log.info('worker enrichment configuration refreshed');
  }

  lastReadinessAttemptAt = Date.now();
  try {
    if (!(await ensureMeilisearchReady())) {
      log.warn('Meilisearch remains unreachable; worker will retry readiness');
    }
  } catch (error) {
    log.warn({ err: error }, 'Meilisearch readiness refresh failed; worker will retry');
  }
  return changed;
}

export function startWorkerEnrichmentConfigRefresh(intervalMs = DEFAULT_REFRESH_MS): void {
  if (refreshTimer) return;
  refreshTimer = setInterval(() => {
    if (refreshInFlight) return;
    refreshInFlight = true;
    void refreshWorkerEnrichmentConfig()
      .catch((error) => log.warn({ err: error }, 'worker enrichment config refresh failed'))
      .finally(() => {
        refreshInFlight = false;
      });
  }, intervalMs);
  refreshTimer.unref();
}

export function stopWorkerEnrichmentConfigRefresh(): void {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = null;
  refreshInFlight = false;
}
