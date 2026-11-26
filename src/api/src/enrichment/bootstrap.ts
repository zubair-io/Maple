/**
 * Geocode enrichment boot probe and settings-UI health check.
 *
 * Reverse geocoding itself runs as the stage `workers/stages/geocode.ts`,
 * started by the stage machinery; nothing here starts or stops it.
 *
 * Spec: `docs/indexer-enrichment.md` §4.2 (boot health check), §6 (wiring).
 */

import { child as childLogger } from '../log.ts';
import { NominatimClient } from './nominatim-client.ts';
import { loadEnrichmentConfig } from './enrichment-config.repo.ts';
import {
  resolveEnrichmentConfig,
  type ResolvedEnrichmentConfig,
} from './enrichment-config.resolve.ts';

const log = childLogger('geocode');

export interface GeocoderProbeLogger {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
}

export type GeocoderProbeResult = 'skipped' | 'healthy' | 'unreachable';

const UNPARSEABLE_URL = '<unparseable url>';

function decodedOrSelf(part: string): string {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
}

function urlRedactor(rawUrl: string): { url: string; scrub: (text: string) => string } {
  const parsed = URL.canParse(rawUrl) ? new URL(rawUrl) : null;
  if (!parsed)
    return { url: UNPARSEABLE_URL, scrub: (text) => text.replaceAll(rawUrl, UNPARSEABLE_URL) };
  const { username, password } = parsed;
  parsed.username = '';
  parsed.password = '';
  const url = parsed.href.replace(/\/$/, '');
  const rawAuthority = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)@/i.exec(rawUrl)?.[1];
  const secrets = [
    rawUrl,
    rawUrl.replace(/\/+$/, ''),
    rawAuthority ? `${rawAuthority}@` : '',
    `${username}:${password}@`,
    `${decodedOrSelf(username)}:${decodedOrSelf(password)}@`,
    username ? `${username}@` : '',
    password,
    decodedOrSelf(password),
  ]
    .filter((secret) => secret.length > 0)
    .sort((left, right) => right.length - left.length);
  const userinfoReplacements = new Set([rawUrl, rawUrl.replace(/\/+$/, '')]);
  return {
    url,
    scrub: (text) =>
      secrets.reduce(
        (scrubbed, secret) =>
          scrubbed.replaceAll(
            secret,
            userinfoReplacements.has(secret) ? url : secret.endsWith('@') ? '' : '<redacted>',
          ),
        text,
      ),
  };
}

export async function checkGeocoderStatus(
  resolved: ResolvedEnrichmentConfig,
  deps: { fetchImpl?: typeof fetch; logger?: GeocoderProbeLogger } = {},
): Promise<GeocoderProbeResult> {
  if (!resolved.geocode_worker_enabled || !resolved.nominatim_url) return 'skipped';
  const logger = deps.logger ?? log;
  const { url, scrub } = urlRedactor(resolved.nominatim_url);
  const client = new NominatimClient({
    baseUrl: resolved.nominatim_url,
    rateLimitPerSec: resolved.nominatim_rate_limit_per_sec,
    fetchImpl: deps.fetchImpl,
  });
  logger.info({ url }, 'checking Nominatim status');
  try {
    await client.health();
  } catch (err) {
    const reason = scrub(err instanceof Error ? err.message : String(err));
    logger.warn(
      { url, reason },
      `Nominatim status check failed at ${url} (${reason}); this check starts and stops nothing. While the geocode stage runs, a photo whose lookup fails is retried with backoff and then set aside, so fix the URL at /settings/enrichment`,
    );
    return 'unreachable';
  }
  logger.info({ url }, 'Nominatim healthy');
  return 'healthy';
}

export async function probeGeocoderAtBoot(): Promise<GeocoderProbeResult> {
  const resolved = resolveEnrichmentConfig(await loadEnrichmentConfig());
  return checkGeocoderStatus(resolved);
}

/**
 * Re-apply enrichment config from the settings UI. Runs a Nominatim health
 * check when a URL is present so the UI can surface connectivity errors.
 */
export async function applyEnrichmentConfig(resolved: ResolvedEnrichmentConfig): Promise<void> {
  if (!resolved.geocode_worker_enabled || !resolved.nominatim_url) {
    log.info('geocode worker disabled or no URL — skipping health check');
    return;
  }
  const client = new NominatimClient({
    baseUrl: resolved.nominatim_url,
    rateLimitPerSec: resolved.nominatim_rate_limit_per_sec,
  });
  log.info({ url: urlRedactor(resolved.nominatim_url).url }, 'checking Nominatim status');
  await client.health();
  log.info('Nominatim healthy');
}
