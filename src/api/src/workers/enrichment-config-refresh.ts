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
import { child as childLogger } from '../log.ts';

const log = childLogger('workers:enrichment-config');
const DEFAULT_REFRESH_MS = 2_000;

let refreshTimer: ReturnType<typeof setInterval> | null = null;
let refreshInFlight = false;
let appliedFingerprint: string | null = null;

export function workerEnrichmentFingerprint(config: ResolvedEnrichmentConfig): string {
  return JSON.stringify({
    aiConnections: config.ai_connections,
    describeWorkerEnabled: config.describe_worker_enabled,
    describeProvider: config.describe_provider,
    describeModel: config.describe_model,
    describeSystemPrompt: config.describe_system_prompt,
    describeUrl: config.describe_provider_url,
    describeServers: config.describe_servers,
    openaiApiKey: config.openai_api_key,
    anthropicApiKey: config.anthropic_api_key,
    geminiApiKey: config.gemini_api_key,
  });
}

export async function refreshWorkerEnrichmentConfig(force = false): Promise<boolean> {
  const resolved = resolveEnrichmentConfig(await loadEnrichmentConfig());
  const fingerprint = workerEnrichmentFingerprint(resolved);
  const changed = force || fingerprint !== appliedFingerprint;
  if (!changed) return false;

  await applyDescribeConfig(resolved);
  appliedFingerprint = fingerprint;
  log.info('worker enrichment configuration refreshed');
  return true;
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
