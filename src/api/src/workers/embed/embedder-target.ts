import { loadEnrichmentConfig } from '../../enrichment/enrichment-config.repo.ts';
import { resolveEnrichmentConfig } from '../../enrichment/enrichment-config.resolve.ts';
import type { OllamaEmbedTarget } from '../../enrichment/ollama-embed-client.ts';

const TARGET_CACHE_MS = 5_000;

const cache: { target: OllamaEmbedTarget | null; loadedAt: number } = {
  target: null,
  loadedAt: 0,
};

async function loadTarget(): Promise<OllamaEmbedTarget> {
  const resolved = resolveEnrichmentConfig(await loadEnrichmentConfig());
  const target = { url: resolved.embedder_url, model: resolved.embedder_model };
  if (target.url.length === 0 || target.model.length === 0) {
    throw new Error('embed: no embedder endpoint or model is configured (Settings → AI)');
  }
  return target;
}

/** The endpoint and model the stage embeds with, re-read from settings every few seconds. */
export async function currentEmbedderTarget(): Promise<OllamaEmbedTarget> {
  if (cache.target !== null && Date.now() - cache.loadedAt < TARGET_CACHE_MS) return cache.target;
  const target = await loadTarget();
  Object.assign(cache, { target, loadedAt: Date.now() });
  return target;
}

export function forgetEmbedderTarget(): void {
  Object.assign(cache, { target: null, loadedAt: 0 });
}
