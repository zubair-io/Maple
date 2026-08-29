/**
 * Describe-slice validation for `PUT /api/enrichment/config`.
 *
 * Extracted from `routes/enrichment.ts` to keep that file under the
 * file-size budget when the single describe URL became a server list. Pure:
 * it takes the (already type-checked) body fields and returns either the
 * validated values to persist or the operator-facing 400 message.
 *
 * All fields are optional. `undefined` leaves the saved value alone; `null`
 * clears back to env/default.
 */

import { validateHttpUrl } from '../observability/observability-config.repo.ts';
import {
  asDescribeProvider,
  MAX_DESCRIBE_DAILY_CAP_USD,
  MIN_DESCRIBE_DAILY_CAP_USD,
} from '../enrichment/enrichment-config.repo.ts';
import {
  validateDescribeServers,
  type DescribeServerConfig,
} from '../enrichment/describe-servers.ts';

export interface DescribePatchBody {
  describe_provider?: string | null;
  describe_provider_url?: string | null;
  describe_servers?: Array<{ url: string; concurrency?: number | null }> | null;
  describe_daily_cap_usd?: number | null;
}

export interface DescribePatch {
  provider: string | null | undefined;
  url: string | null | undefined;
  servers: DescribeServerConfig[] | null | undefined;
  cap: number | null | undefined;
}

/** `undefined` (field omitted) and `null` (clear) both pass straight
 * through; only a supplied string is checked. */
function providerError(provider: string | null | undefined): string | null {
  if (typeof provider !== 'string' || asDescribeProvider(provider) !== null) return null;
  return `Invalid describe_provider: must be one of "ollama", "anthropic", "openai", "gemini" (got "${provider}")`;
}

function capError(cap: number | null | undefined): string | null {
  if (typeof cap !== 'number') return null;
  const valid =
    Number.isFinite(cap) && cap > MIN_DESCRIBE_DAILY_CAP_USD && cap <= MAX_DESCRIBE_DAILY_CAP_USD;
  return valid
    ? null
    : `Invalid describe_daily_cap_usd: must be a number in (${MIN_DESCRIBE_DAILY_CAP_USD}, ${MAX_DESCRIBE_DAILY_CAP_USD}] (got ${cap})`;
}

/** The URL and the server list resolve together: a supplied list is
 * authoritative for the default endpoint too — entry 0's URL becomes
 * `describe_provider_url`, so the services that read that single field
 * (semantic-search embedder, generated-search) follow the operator's
 * chosen default. */
function resolveEndpoints(
  body: DescribePatchBody,
): Pick<DescribePatch, 'url' | 'servers'> | { error: string } {
  const validatedUrl =
    body.describe_provider_url === undefined
      ? undefined
      : validateHttpUrl(body.describe_provider_url);
  if (validatedUrl && typeof validatedUrl === 'object') {
    return { error: `Invalid describe_provider_url: ${validatedUrl.error}` };
  }

  if (body.describe_servers === undefined) return { url: validatedUrl, servers: undefined };

  const servers = validateDescribeServers(body.describe_servers);
  if (servers && 'error' in servers) {
    return { error: `Invalid describe_servers: ${servers.error}` };
  }
  return { url: servers ? servers[0]!.url : validatedUrl, servers };
}

export function validateDescribePatch(body: DescribePatchBody): DescribePatch | { error: string } {
  const error = providerError(body.describe_provider) ?? capError(body.describe_daily_cap_usd);
  if (error) return { error };

  const endpoints = resolveEndpoints(body);
  if ('error' in endpoints) return endpoints;

  return {
    provider: body.describe_provider,
    url: endpoints.url,
    servers: endpoints.servers,
    cap: body.describe_daily_cap_usd,
  };
}
