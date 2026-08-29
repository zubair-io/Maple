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

export function validateDescribePatch(body: DescribePatchBody): DescribePatch | { error: string } {
  const provider = body.describe_provider;
  if (typeof provider === 'string' && asDescribeProvider(provider) === null) {
    return {
      error: `Invalid describe_provider: must be one of "ollama", "anthropic", "openai", "gemini" (got "${provider}")`,
    };
  }

  let url: string | null | undefined;
  if (body.describe_provider_url !== undefined) {
    const validated = validateHttpUrl(body.describe_provider_url);
    if (validated && typeof validated === 'object' && 'error' in validated) {
      return { error: `Invalid describe_provider_url: ${validated.error}` };
    }
    url = validated as string | null;
  }

  // The server list, when supplied, is authoritative for the default
  // endpoint too — entry 0's URL becomes `describe_provider_url` so the
  // services that read that single field (semantic-search embedder,
  // generated-search) follow the operator's chosen default.
  let servers: DescribeServerConfig[] | null | undefined;
  if (body.describe_servers !== undefined) {
    const validated = validateDescribeServers(body.describe_servers);
    if (validated && 'error' in validated) {
      return { error: `Invalid describe_servers: ${validated.error}` };
    }
    servers = validated;
    if (servers) url = servers[0]!.url;
  }

  const cap = body.describe_daily_cap_usd;
  if (typeof cap === 'number') {
    if (
      !Number.isFinite(cap) ||
      cap <= MIN_DESCRIBE_DAILY_CAP_USD ||
      cap > MAX_DESCRIBE_DAILY_CAP_USD
    ) {
      return {
        error: `Invalid describe_daily_cap_usd: must be a number in (${MIN_DESCRIBE_DAILY_CAP_USD}, ${MAX_DESCRIBE_DAILY_CAP_USD}] (got ${cap})`,
      };
    }
  }

  return { provider, url, servers, cap };
}
