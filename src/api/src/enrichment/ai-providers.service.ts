/**
 * AI Providers Service.
 *
 * Provides model discovery and connectivity testing for supported AI providers:
 * - Ollama (local)
 * - OpenAI
 * - Anthropic
 * - Gemini
 */

import {
  RemoteError,
  getDescribeProvider,
  type DescribeProviderName,
} from './describe-providers/index.ts';
import { DEFAULT_DESCRIBE_MODELS, asDescribeProvider } from './enrichment-config.repo.ts';

export interface ProviderModelOptions {
  url?: string | null;
  apiKey?: string | null;
}

const FALLBACK_MODELS: Record<DescribeProviderName, string[]> = {
  ollama: [DEFAULT_DESCRIBE_MODELS.ollama, 'qwen2.5-vl:7b', 'llava:latest'],
  openai: ['gpt-4o-mini', 'gpt-4o', 'gpt-4-turbo', 'o1-mini'],
  anthropic: [
    'claude-haiku-4-5',
    'claude-sonnet-4',
    'claude-3-5-sonnet-latest',
    'claude-3-5-haiku-latest',
    'claude-3-opus-latest',
  ],
  gemini: ['gemini-flash', 'gemini-1.5-flash', 'gemini-1.5-pro', 'gemini-2.0-flash'],
};

export function resolveEnvKey(provider: string): string | null {
  const envName = `MAPLE_${provider.toUpperCase()}_API_KEY`;
  return process.env[envName] || null;
}

async function fetchOllamaModels(url?: string | null): Promise<string[]> {
  const baseUrl = (url || 'http://localhost:11434').replace(/\/+$/, '');
  const res = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(6000) });
  if (!res.ok) {
    throw new Error(`Ollama returned status ${res.status}`);
  }
  const data = (await res.json()) as { models?: Array<{ name?: string }> };
  const models = (data.models ?? [])
    .map((m) => m.name?.trim())
    .filter((name): name is string => typeof name === 'string' && name.length > 0);
  if (models.length === 0) {
    throw new Error('No models returned by Ollama');
  }
  return models;
}

async function fetchModelIds(
  url: string,
  headers: Record<string, string>,
  providerLabel: string,
): Promise<string[]> {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
  if (!res.ok) {
    throw new Error(`${providerLabel} returned status ${res.status}`);
  }
  const body = (await res.json()) as { data?: Array<{ id?: string }> };
  const ids = (body.data ?? [])
    .map((m) => m.id?.trim())
    .filter((id): id is string => typeof id === 'string' && id.length > 0);
  if (ids.length === 0) {
    throw new Error(`No models returned by ${providerLabel}`);
  }
  return ids;
}

async function fetchOpenAiModels(apiKey: string): Promise<string[]> {
  const all = await fetchModelIds(
    'https://api.openai.com/v1/models',
    { Authorization: `Bearer ${apiKey}` },
    'OpenAI',
  );
  const visionLike = all.filter(
    (id) =>
      id.startsWith('gpt-4o') ||
      id.startsWith('gpt-4-turbo') ||
      id.startsWith('o1') ||
      id.startsWith('o3') ||
      id.includes('vision'),
  );
  return (visionLike.length > 0 ? visionLike : all).sort();
}

async function fetchAnthropicModels(apiKey: string): Promise<string[]> {
  const models = await fetchModelIds(
    'https://api.anthropic.com/v1/models',
    {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    'Anthropic',
  );
  return models.sort();
}

async function fetchGeminiModels(apiKey: string): Promise<string[]> {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`,
    { signal: AbortSignal.timeout(8000) },
  );
  if (!res.ok) {
    throw new Error(`Gemini returned status ${res.status}`);
  }
  const data = (await res.json()) as {
    models?: Array<{ name?: string; supportedGenerationMethods?: string[] }>;
  };
  const models = (data.models ?? [])
    .filter((m) => m.supportedGenerationMethods?.includes('generateContent') ?? true)
    .map((m) => (m.name ?? '').replace(/^models\//, '').trim())
    .filter((name) => name.length > 0 && !name.includes('embedding'));
  if (models.length === 0) {
    throw new Error('No models returned by Gemini');
  }
  return models.sort();
}

async function fetchLiveModels(
  provider: DescribeProviderName,
  opts: ProviderModelOptions,
  apiKey: string | null,
): Promise<string[]> {
  if (provider === 'ollama') {
    return await fetchOllamaModels(opts.url);
  }
  if (!apiKey) {
    throw new Error('No API key provided or found in environment');
  }
  if (provider === 'openai') {
    return await fetchOpenAiModels(apiKey);
  }
  if (provider === 'anthropic') {
    return await fetchAnthropicModels(apiKey);
  }
  return await fetchGeminiModels(apiKey);
}

/**
 * Fetch the list of available models from the provider's API.
 * Falls back to sensible default models if the API is offline or the call fails.
 */
export async function listProviderModels(
  provider: DescribeProviderName,
  opts: ProviderModelOptions = {},
): Promise<{ models: string[]; source: 'live' | 'fallback'; error?: string }> {
  const apiKey = opts.apiKey !== undefined ? opts.apiKey?.trim() || null : resolveEnvKey(provider);

  try {
    const models = await fetchLiveModels(provider, opts, apiKey);
    return { models, source: 'live' };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    return {
      models: FALLBACK_MODELS[provider],
      source: 'fallback',
      error: errorMsg,
    };
  }
}

/**
 * Health-check connection to an AI provider.
 */
export async function testProviderConnection(
  provider: DescribeProviderName,
  opts: ProviderModelOptions = {},
): Promise<{ ok: boolean; error?: string; status?: number | null }> {
  try {
    const client = getDescribeProvider(provider, {
      url: opts.url,
      apiKey: opts.apiKey,
    });
    await client.health();
    return { ok: true };
  } catch (err: unknown) {
    const isRemote = err instanceof RemoteError;
    return {
      ok: false,
      error: (err as Error)?.message ?? String(err),
      status: isRemote ? (err.status ?? null) : null,
    };
  }
}

/**
 * Validate provider name and test connection for AI routes.
 */
export async function handleAiTestConnection(
  rawProvider: string,
  url?: string | null,
  apiKey?: string | null,
): Promise<{ ok: boolean; error?: string; status?: number | null }> {
  const provider = asDescribeProvider(rawProvider);
  if (!provider) {
    return { ok: false, error: `Invalid provider "${rawProvider}"`, status: 400 };
  }
  const result = await testProviderConnection(provider, { url, apiKey });
  if (!result.ok && (!result.status || result.status < 400 || result.status >= 600)) {
    return { ...result, status: 400 };
  }
  return result;
}
