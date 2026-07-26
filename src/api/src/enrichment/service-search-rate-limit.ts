import {
  DEFAULT_SERVICE_SEARCH_RATE_LIMIT_PER_MINUTE,
  loadEnrichmentConfig,
} from './enrichment-config.repo.ts';
import { resolveEnrichmentConfig } from './enrichment-config.resolve.ts';

interface RateWindow {
  startedAt: number;
  count: number;
}

const windows = new Map<string, RateWindow>();
let configuredLimit: number | null = null;

export function configureServiceSearchRateLimit(limit: number): void {
  configuredLimit = limit;
}

async function effectiveLimit(): Promise<number> {
  if (configuredLimit !== null) return configuredLimit;
  const resolved = resolveEnrichmentConfig(await loadEnrichmentConfig());
  configuredLimit =
    resolved.service_search_rate_limit_per_minute ?? DEFAULT_SERVICE_SEARCH_RATE_LIMIT_PER_MINUTE;
  return configuredLimit;
}

export async function consumeServiceSearchRateLimit(
  keyId: string,
): Promise<{ allowed: boolean; retryAfterSeconds: number }> {
  const now = Date.now();
  const window = windows.get(keyId);
  if (!window || now - window.startedAt >= 60_000) {
    windows.set(keyId, { startedAt: now, count: 1 });
    return { allowed: true, retryAfterSeconds: 0 };
  }
  if (window.count >= (await effectiveLimit())) {
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((60_000 - (now - window.startedAt)) / 1000)),
    };
  }
  window.count += 1;
  return { allowed: true, retryAfterSeconds: 0 };
}

export function resetServiceSearchRateLimitsForTests(): void {
  windows.clear();
  configuredLimit = null;
}
