import type { ResolvedEnrichmentConfig } from '../enrichment/enrichment-config.resolve.ts';
import { describeServersForRuntime } from '../workers/describe-capacity.ts';

/**
 * Constants for the `meilisearch_*` fields of the response (#4464). Released Apple builds decode
 * these as required, so omitting them fails Settings → Enrichment on every client that has not
 * updated yet. Meilisearch is gone, so they say so: no URL, no key, semantic search off.
 * Deprecated; delete once no released Apple build requires them.
 */
const DEPRECATED_MEILISEARCH_FIELDS = {
  meilisearch_url: null,
  meilisearch_api_key_set: false,
  meilisearch_task_timeout_seconds: 600,
  meilisearch_semantic_enabled: false,
  meilisearch_embedder_url: '',
  meilisearch_embedder_model: '',
  meilisearch_semantic_ratio: 0.5,
} as const;

/** Strip provider API keys from a resolved config before it
 * goes over HTTP, replacing it with a boolean "is a key set" indicator. The
 * raw key is never echoed to clients. */
export async function toPublicConfig(resolved: ResolvedEnrichmentConfig) {
  const {
    ai_connections: _aiConnections,
    openai_api_key,
    anthropic_api_key,
    gemini_api_key,
    ...safe
  } = resolved;
  return {
    ...safe,
    ...DEPRECATED_MEILISEARCH_FIELDS,
    openai_api_key_set: Boolean(openai_api_key),
    anthropic_api_key_set: Boolean(anthropic_api_key),
    gemini_api_key_set: Boolean(gemini_api_key),
    // Report the list the RUNTIME will use, not the resolver's placeholder:
    // for a deploy that hasn't saved one, the derived single server inherits
    // the describe stage's existing concurrency, and the settings UI has to
    // show that number or the operator reads a value the worker never uses.
    describe_servers: await describeServersForRuntime(resolved),
  };
}
