/**
 * GET /api/geocode/search?q=<query>
 *
 * Forward geocode proxy: passes the query string to the self-hosted Nominatim
 * `/search` endpoint and returns up to 5 candidates. Used by the Batch
 * Metadata panel's address typeahead.
 *
 * Design:
 *  - Reuses `NominatimClient` (same instance as the geocode worker) for
 *    rate-limiting and timeout handling.
 *  - Results are NOT cached (forward search is typeahead UX, not a hot path).
 *  - 503 when Nominatim URL is not configured.
 *  - 200 with empty array when Nominatim returns no results.
 *
 * Spec: docs/superpowers/specs/2026-06-26-batch-metadata-editor-design.md
 * §"Location" / "GET /api/geocode/search"
 */

import { Elysia, t } from 'elysia';
import { NominatimClient, NominatimError } from '../enrichment/nominatim-client.ts';
import {
  loadEnrichmentConfig,
  resolveEnrichmentConfig,
} from '../enrichment/enrichment-config.repo.ts';
import type { NominatimSearchResult } from '../enrichment/nominatim-client.ts';
import { child as childLogger } from '../log.ts';

const log = childLogger('routes/geocode-search');

// ---------------------------------------------------------------------------
// Lazy client (same pattern as geocode stage)
// ---------------------------------------------------------------------------

let _client: NominatimClient | null = null;

async function getClient(): Promise<NominatimClient | null> {
  if (_client) return _client;
  const dbConfig = await loadEnrichmentConfig();
  const cfg = resolveEnrichmentConfig(dbConfig);
  if (!cfg.nominatim_url) return null;
  _client = new NominatimClient({
    baseUrl: cfg.nominatim_url,
    rateLimitPerSec: cfg.nominatim_rate_limit_per_sec,
  });
  return _client;
}

/** Test-only setter. Pass `null` to reset. */
export function setGeocodeSearchClientForTests(client: NominatimClient | null): void {
  _client = client;
}

// ---------------------------------------------------------------------------
// Response shape
// ---------------------------------------------------------------------------

export interface GeocodeSuggestion {
  displayName: string;
  lat: number;
  lon: number;
  address: Record<string, string>;
}

function mapResult(r: NominatimSearchResult): GeocodeSuggestion {
  return {
    displayName: r.display_name,
    lat: parseFloat(r.lat),
    lon: parseFloat(r.lon),
    address: r.address ?? {},
  };
}

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

export const geocodeSearchRoutes = new Elysia().get(
  '/api/geocode/search',
  async ({ query, set }) => {
    const q = (query.q ?? '').trim();
    if (q.length === 0) {
      set.status = 400;
      return { error: 'q is required' };
    }
    if (q.length > 500) {
      set.status = 400;
      return { error: 'q exceeds maximum length of 500 characters' };
    }

    const client = await getClient();
    if (!client) {
      set.status = 503;
      return { error: 'Nominatim not configured; set nominatim URL in /settings/enrichment' };
    }

    try {
      const raw = await client.search(q, 5);
      const suggestions: GeocodeSuggestion[] = raw.map(mapResult);
      return { suggestions };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      const retryable = err instanceof NominatimError ? err.retryable : false;
      log.warn({ q, err: msg, retryable }, 'geocode-search: Nominatim forward search failed');
      set.status = retryable ? 503 : 502;
      return { error: `Geocode search failed: ${msg}` };
    }
  },
  {
    query: t.Object({
      q: t.Optional(
        t.String({
          description: 'Address search query (max 500 chars)',
        }),
      ),
    }),
    detail: {
      summary: 'Forward geocode address search',
      description:
        'Proxy to the self-hosted Nominatim /search endpoint. Returns up to 5 candidates with display name, coordinates, and structured address. Used by the Batch Metadata panel address typeahead.',
      tags: ['geocode'],
    },
  },
);
