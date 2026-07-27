import { loadEnrichmentConfig } from './enrichment-config.repo.ts';
import { resolveEnrichmentConfig } from './enrichment-config.resolve.ts';
import { createMeilisearchClient } from './meilisearch-client.ts';
import { validateHttpUrl } from '../observability/observability-config.repo.ts';

export interface MeilisearchConnectionTestInput {
  meilisearch_url: string;
  api_key?: string | null;
}

export async function testMeilisearchConnection(
  input: MeilisearchConnectionTestInput,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const validated = validateHttpUrl(input.meilisearch_url);
  if (validated === null || (typeof validated === 'object' && 'error' in validated)) {
    return {
      status: 400,
      body: { ok: false, error: validated === null ? 'URL is empty' : validated.error },
    };
  }
  const resolved = resolveEnrichmentConfig(await loadEnrichmentConfig());
  const client = createMeilisearchClient({
    url: validated,
    apiKey: input.api_key?.trim() || resolved.meilisearch_api_key || undefined,
    semantic: resolved.meilisearch_semantic_enabled,
    embedderUrl: resolved.meilisearch_embedder_url,
    embedderModel: resolved.meilisearch_embedder_model,
    semanticRatio: resolved.meilisearch_semantic_ratio,
  });
  if (!(await client.health())) {
    return {
      status: 200,
      body: { ok: false, error: 'Meilisearch health check failed', url: validated },
    };
  }
  if (!resolved.meilisearch_semantic_enabled || !client.semanticStatus) {
    return { status: 200, body: { ok: true, url: validated } };
  }
  const semantic = await client.semanticStatus();
  const semanticReady =
    semantic.embedderConfigured && semantic.embedderReachable && semantic.meilisearchReachable;
  return {
    status: 200,
    body: semanticReady
      ? { ok: true, url: validated, semanticReady, semantic }
      : {
          ok: false,
          url: validated,
          semanticReady,
          semantic,
          error:
            semantic.error ??
            `Semantic embedder "${semantic.embedderName}" is not ready for model "${semantic.model}".`,
        },
  };
}
