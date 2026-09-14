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
import { DEFAULT_DESCRIBE_MODELS } from './enrichment-config.repo.ts';

export interface ProviderModelOptions {
  url?: string | null;
  apiKey?: string | null;
}

export function resolveEnvKey(provider: string): string | null {
  const envName = `MAPLE_${provider.toUpperCase()}_API_KEY`;
  return process.env[envName] || null;
}

/**
 * Fetch the list of available models from the provider's API.
 * Falls back to sensible default models if the API is offline or the call fails.
 */
export async function listProviderModels(
  provider: DescribeProviderName,
  opts: ProviderModelOptions = {},
): Promise<{ models: string[]; source: 'live' | 'fallback'; error?: string }> {
  const apiKey = opts.apiKey || resolveEnvKey(provider);

  switch (provider) {
    case 'ollama': {
      const baseUrl = (opts.url || 'http://localhost:11434').replace(/\/+$/, '');
      try {
        const res = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(6000) });
        if (!res.ok) {
          throw new Error(`Ollama returned status ${res.status}`);
        }
        const data = (await res.json()) as { models?: Array<{ name?: string }> };
        const models = (data.models ?? [])
          .map((m) => m.name?.trim())
          .filter((name): name is string => typeof name === 'string' && name.length > 0);
        if (models.length > 0) {
          return { models, source: 'live' };
        }
      } catch (err) {
        return {
          models: [DEFAULT_DESCRIBE_MODELS.ollama, 'qwen2.5-vl:7b', 'llava:latest'],
          source: 'fallback',
          error: err instanceof Error ? err.message : String(err),
        };
      }
      return {
        models: [DEFAULT_DESCRIBE_MODELS.ollama, 'qwen2.5-vl:7b', 'llava:latest'],
        source: 'fallback',
      };
    }

    case 'openai': {
      if (!apiKey) {
        return {
          models: ['gpt-4o-mini', 'gpt-4o', 'gpt-4-turbo', 'o1-mini'],
          source: 'fallback',
          error: 'No API key provided or found in environment',
        };
      }
      try {
        const res = await fetch('https://api.openai.com/v1/models', {
          headers: { Authorization: `Bearer ${apiKey}` },
          signal: AbortSignal.timeout(8000),
        });
        if (!res.ok) {
          throw new Error(`OpenAI returned status ${res.status}`);
        }
        const data = (await res.json()) as { data?: Array<{ id?: string }> };
        const all = (data.data ?? [])
          .map((m) => m.id?.trim())
          .filter((id): id is string => typeof id === 'string' && id.length > 0);
        const visionLike = all.filter(
          (id) =>
            id.startsWith('gpt-4o') ||
            id.startsWith('gpt-4-turbo') ||
            id.startsWith('o1') ||
            id.startsWith('o3') ||
            id.includes('vision'),
        );
        const models = visionLike.length > 0 ? visionLike : all;
        return { models: models.sort(), source: 'live' };
      } catch (err) {
        return {
          models: ['gpt-4o-mini', 'gpt-4o', 'gpt-4-turbo', 'o1-mini'],
          source: 'fallback',
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }

    case 'anthropic': {
      if (!apiKey) {
        return {
          models: [
            'claude-haiku-4-5',
            'claude-sonnet-4',
            'claude-3-5-sonnet-latest',
            'claude-3-5-haiku-latest',
            'claude-3-opus-latest',
          ],
          source: 'fallback',
          error: 'No API key provided or found in environment',
        };
      }
      try {
        const res = await fetch('https://api.anthropic.com/v1/models', {
          headers: {
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
          },
          signal: AbortSignal.timeout(8000),
        });
        if (res.ok) {
          const data = (await res.json()) as { data?: Array<{ id?: string }> };
          const models = (data.data ?? [])
            .map((m) => m.id?.trim())
            .filter((id): id is string => typeof id === 'string' && id.length > 0);
          if (models.length > 0) {
            return { models: models.sort(), source: 'live' };
          }
        }
      } catch {
        // Fallback for keys without models listing permissions
      }
      return {
        models: [
          'claude-haiku-4-5',
          'claude-sonnet-4',
          'claude-3-5-sonnet-latest',
          'claude-3-5-haiku-latest',
          'claude-3-opus-latest',
        ],
        source: 'fallback',
      };
    }

    case 'gemini': {
      if (!apiKey) {
        return {
          models: ['gemini-flash', 'gemini-1.5-flash', 'gemini-1.5-pro', 'gemini-2.0-flash'],
          source: 'fallback',
          error: 'No API key provided or found in environment',
        };
      }
      try {
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
        if (models.length > 0) {
          return { models: models.sort(), source: 'live' };
        }
      } catch (err) {
        return {
          models: ['gemini-flash', 'gemini-1.5-flash', 'gemini-1.5-pro', 'gemini-2.0-flash'],
          source: 'fallback',
          error: err instanceof Error ? err.message : String(err),
        };
      }
      return {
        models: ['gemini-flash', 'gemini-1.5-flash', 'gemini-1.5-pro', 'gemini-2.0-flash'],
        source: 'fallback',
      };
    }
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
      url: opts.url ?? null,
      apiKey: opts.apiKey ?? null,
    });
    await client.health();
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const status = err instanceof RemoteError && err.status !== undefined ? err.status : null;
    return { ok: false, error: msg, status };
  }
}
