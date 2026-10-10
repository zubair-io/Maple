import { validateHttpUrl } from '../observability/observability-config.repo.ts';
import type { EnrichmentConfig } from './enrichment-config.repo.ts';
import type { ResolvedEnrichmentConfig } from './enrichment-config.resolve.ts';

export interface EmbedderSettingsInput {
  url: string | null;
  model: string | null;
}

/** What Settings → AI shows for the `embed` stage: the saved overrides and what they default to. */
export interface EmbedderSettingsView {
  url: string;
  model: string;
  default_url: string;
  default_model: string;
}

export function embedderSettingsView(
  saved: EnrichmentConfig | null,
  resolved: ResolvedEnrichmentConfig,
): EmbedderSettingsView {
  return {
    url: saved?.embedder_url?.trim() ?? '',
    model: saved?.embedder_model?.trim() ?? '',
    default_url: resolved.meilisearch_embedder_url,
    default_model: resolved.meilisearch_embedder_model,
  };
}

/** Blank values clear the override back to the semantic-search default. */
export function embedderPatch(
  input: EmbedderSettingsInput,
): Pick<EnrichmentConfig, 'embedder_url' | 'embedder_model'> | { error: string } {
  const url = validateHttpUrl(input.url);
  if (url !== null && typeof url === 'object')
    return { error: `Invalid embedder URL: ${url.error}` };
  return { embedder_url: url, embedder_model: input.model?.trim() || null };
}
