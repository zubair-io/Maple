import { loadEnrichmentConfig } from '../enrichment/enrichment-config.repo.ts';

const LEGACY_AI_FIELDS = [
  'describe_provider',
  'describe_provider_url',
  'describe_servers',
  'describe_model',
  'openai_api_key',
  'anthropic_api_key',
  'gemini_api_key',
  'meilisearch_embedder_model',
  'ai_provider',
  'ai_model',
  'model',
];

/** Older clients must not report success for a setting the registry overrides. */
export async function rejectLegacyAiWrite({
  body,
  set,
}: {
  body: unknown;
  set: { status?: number | string };
}) {
  if (!body || typeof body !== 'object' || !LEGACY_AI_FIELDS.some((key) => key in body)) return;
  if (!(await loadEnrichmentConfig())?.ai_connections) return;
  set.status = 409;
  return { error: 'Manage provider connections and worker models in AI Settings.' };
}
