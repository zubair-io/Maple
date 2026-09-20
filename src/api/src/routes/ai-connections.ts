import { reconfigureMeilisearch } from '../enrichment/meilisearch-client.ts';
import { validateAssignedModels } from '../enrichment/ai-model-validation.ts';
import { Elysia, t } from 'elysia';
import { requireAuth, requireOwnerBeforeHandle } from '../auth/middleware.ts';
import {
  loadEnrichmentConfig,
  saveEnrichmentConfig,
} from '../enrichment/enrichment-config.repo.ts';
import { resolveEnrichmentConfig } from '../enrichment/enrichment-config.resolve.ts';
import {
  type AiAssignment,
  importAiConnections,
  publicAiConnections,
  validateAiConnections,
} from '../enrichment/ai-connections.ts';
import { loadWorkerConfigSafe } from '../db/repos/worker-config.repo.ts';
import { loadGeneratedSearchConfig } from '../workers/generated-search/config.repo.ts';
import { listProviderModels, handleAiTestConnection } from '../enrichment/ai-providers.service.ts';
import { resetDescribeDeps } from '../workers/stages/describe.ts';
import { resetVideoDescribeDeps } from '../workers/stages/video-describe.ts';

const Connection = t.Object({
  id: t.String({ minLength: 1, maxLength: 100 }),
  name: t.String({ minLength: 1, maxLength: 100 }),
  provider: t.Union([
    t.Literal('ollama'),
    t.Literal('openai'),
    t.Literal('anthropic'),
    t.Literal('gemini'),
  ]),
  url: t.String({ maxLength: 2048 }),
  concurrency: t.Integer({ minimum: 1, maximum: 100 }),
  api_key: t.Optional(t.Union([t.String(), t.Null()])),
});
const Config = t.Object({
  connections: t.Array(Connection, { maxItems: 32 }),
  assignments: t.Record(
    t.String(),
    t.Object({
      connection_ids: t.Array(t.String(), { maxItems: 8 }),
      model: t.String({ maxLength: 200 }),
      connection_models: t.Optional(t.Record(t.String(), t.String({ maxLength: 200 }))),
    }),
  ),
});

async function loadConfig() {
  const saved = await loadEnrichmentConfig();
  if (saved?.ai_connections) return { ...saved.ai_connections, needs_save: false };
  const [describe, video, generated] = await Promise.all([
    loadWorkerConfigSafe('describe'),
    loadWorkerConfigSafe('video-describe'),
    loadGeneratedSearchConfig(),
  ]);
  return {
    ...importAiConnections(resolveEnrichmentConfig(saved), describe, video, generated.model),
    needs_save: true,
  };
}

export const aiConnectionRoutes = new Elysia({ prefix: '/connections' })
  .use(requireAuth)
  .get('/', async () => publicAiConnections(await loadConfig()), {
    beforeHandle: requireOwnerBeforeHandle,
  })
  .put(
    '/',
    async ({ body, set }) => {
      const current = await loadConfig();
      const connections = body.connections.map((c) => ({
        ...c,
        name: c.name.trim(),
        url: c.url.trim().replace(/\/+$/, ''),
        api_key:
          c.api_key === undefined
            ? current.connections.find((old) => old.id === c.id && old.provider === c.provider)
                ?.api_key
            : c.api_key?.trim() || null,
      }));
      const assignments = Object.fromEntries(
        Object.entries(body.assignments as Record<string, AiAssignment>).map(([id, a]) => [
          id,
          {
            ...a,
            model: a.model.trim(),
            ...(a.connection_models
              ? {
                  connection_models: Object.fromEntries(
                    a.connection_ids.map((key) => [key, (a.connection_models![key] ?? '').trim()]),
                  ),
                }
              : {}),
          },
        ]),
      );
      const config = { connections, assignments };
      const error =
        validateAiConnections(config) ?? (await validateAssignedModels(config, current));
      if (error) {
        set.status = 400;
        return { error };
      }
      // One document update: credentials, connections and every assignment change together.
      await saveEnrichmentConfig({ ai_connections: config });
      const resolved = resolveEnrichmentConfig(await loadEnrichmentConfig());
      reconfigureMeilisearch({
        url: resolved.meilisearch_url,
        apiKey: resolved.meilisearch_api_key,
        taskTimeoutMs: resolved.meilisearch_task_timeout_seconds * 1000,
        semanticEnabled: resolved.meilisearch_semantic_enabled,
        embedderUrl: resolved.meilisearch_embedder_url,
        embedderModel: resolved.meilisearch_embedder_model,
        semanticRatio: resolved.meilisearch_semantic_ratio,
      });
      resetDescribeDeps();
      resetVideoDescribeDeps();
      return publicAiConnections(config);
    },
    { body: Config, beforeHandle: requireOwnerBeforeHandle },
  )
  .post(
    '/probe',
    async ({ body, set }) => {
      const current = await loadConfig();
      const c = body.connection;
      const apiKey =
        c.api_key === undefined
          ? current.connections.find((old) => old.id === c.id && old.provider === c.provider)
              ?.api_key
          : c.api_key;
      if (body.models) return listProviderModels(c.provider, { url: c.url, apiKey });
      const result = await handleAiTestConnection(c.provider, c.url, apiKey);
      if (!result.ok) set.status = result.status ?? 400;
      return result;
    },
    {
      body: t.Object({ connection: Connection, models: t.Boolean() }),
      beforeHandle: requireOwnerBeforeHandle,
    },
  );
