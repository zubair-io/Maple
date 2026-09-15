import type { ResolvedEnrichmentConfig } from '../enrichment/enrichment-config.resolve.ts';
import { describeServersForRuntime } from '../workers/describe-capacity.ts';

/** Strip provider and Meilisearch API keys from a resolved config before it
 * goes over HTTP, replacing it with a boolean "is a key set" indicator. The
 * raw key is never echoed to clients; `source.meilisearch_api_key` (db/env/
 * unset) is safe to keep so the UI can show provenance. */
export async function toPublicConfig(resolved: ResolvedEnrichmentConfig) {
  const { meilisearch_api_key, openai_api_key, anthropic_api_key, gemini_api_key, ...safe } =
    resolved;
  return {
    ...safe,
    openai_api_key_set: Boolean(openai_api_key),
    anthropic_api_key_set: Boolean(anthropic_api_key),
    gemini_api_key_set: Boolean(gemini_api_key),
    // Report the list the RUNTIME will use, not the resolver's placeholder:
    // for a deploy that hasn't saved one, the derived single server inherits
    // the describe stage's existing concurrency, and the settings UI has to
    // show that number or the operator reads a value the worker never uses.
    describe_servers: await describeServersForRuntime(resolved),
    meilisearch_api_key_set:
      typeof meilisearch_api_key === 'string' && meilisearch_api_key.length > 0,
  };
}
