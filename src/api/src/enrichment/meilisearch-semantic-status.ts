import {
  isLiveConfig,
  meilisearchHttp,
  type MeilisearchTransportConfig,
} from './meilisearch-transport.ts';

export interface SemanticStatusConfig extends MeilisearchTransportConfig {
  semantic: boolean;
  embedderModel: string;
  semanticRatio: number;
}

export interface MeilisearchSemanticStatus {
  configured: boolean;
  enabled: boolean;
  embedderName: string;
  model: string;
  semanticRatio: number;
  meilisearchReachable: boolean;
  embedderConfigured: boolean;
  embedderReachable: boolean;
  indexedDocumentCount: number | null;
  vectorizedDocumentCount: number | null;
  isIndexing: boolean | null;
  error: string | null;
}

interface SearchResponse {
  hits: Array<{ id: string }>;
}

const failedStatus = (
  config: SemanticStatusConfig,
  embedderName: string,
): MeilisearchSemanticStatus => ({
  configured: false,
  enabled: config.semantic,
  embedderName,
  model: config.embedderModel,
  semanticRatio: config.semanticRatio,
  meilisearchReachable: false,
  embedderConfigured: false,
  embedderReachable: false,
  indexedDocumentCount: null,
  vectorizedDocumentCount: null,
  isIndexing: null,
  error: 'meilisearch_not_configured',
});

function resultError(result: {
  ok: boolean;
  status: number;
  errorText: string | null;
}): string | null {
  return result.ok ? null : (result.errorText ?? `status_${result.status}`);
}

export async function readMeilisearchSemanticStatus(
  config: SemanticStatusConfig,
  indexName: string,
  embedderName: string,
): Promise<MeilisearchSemanticStatus> {
  if (!isLiveConfig(config)) return failedStatus(config, embedderName);
  const [health, embedders, stats] = await Promise.all([
    meilisearchHttp<{ status: string }>(config, 'GET', '/health'),
    meilisearchHttp<Record<string, { source?: string; model?: string }>>(
      config,
      'GET',
      `/indexes/${indexName}/settings/embedders`,
    ),
    meilisearchHttp<{
      numberOfDocuments: number;
      numberOfEmbeddedDocuments?: number | null;
      isIndexing: boolean;
    }>(config, 'GET', `/indexes/${indexName}/stats`),
  ]);
  const embedder = embedders.body?.[embedderName];
  const embedderConfigured =
    embedders.ok && embedder?.source === 'ollama' && embedder.model === config.embedderModel;

  let embedderReachable = false;
  let probeError: string | null = null;
  if (health.ok && config.semantic && embedderConfigured) {
    const probe = await meilisearchHttp<SearchResponse>(
      config,
      'POST',
      `/indexes/${indexName}/search`,
      {
        q: 'maple semantic health probe',
        filter: 'deletedAt IS NULL AND (hidden IS NULL OR hidden = false)',
        limit: 1,
        attributesToRetrieve: ['id'],
        hybrid: { embedder: embedderName, semanticRatio: config.semanticRatio },
      },
    );
    embedderReachable = probe.ok;
    probeError = resultError(probe);
  }

  const error =
    resultError(health) ?? resultError(embedders) ?? resultError(stats) ?? probeError ?? null;
  return {
    configured: true,
    enabled: config.semantic,
    embedderName,
    model: config.embedderModel,
    semanticRatio: config.semanticRatio,
    meilisearchReachable: health.ok,
    embedderConfigured,
    embedderReachable,
    indexedDocumentCount: stats.body?.numberOfDocuments ?? null,
    vectorizedDocumentCount: stats.body?.numberOfEmbeddedDocuments ?? null,
    isIndexing: stats.body?.isIndexing ?? null,
    error,
  };
}
