/**
 * /api/ai/* — operator-facing routes for managing AI providers, model listings,
 * and mapping providers/models to workers.
 */

import { Elysia, t } from 'elysia';
import { requireAuth, requireOwnerBeforeHandle } from '../auth/middleware.ts';
import {
  asDescribeProvider,
  loadEnrichmentConfig,
  saveEnrichmentConfig,
  DEFAULT_DESCRIBE_MODELS,
  type EnrichmentConfig,
} from '../enrichment/enrichment-config.repo.ts';
import { resolveEnrichmentConfig } from '../enrichment/enrichment-config.resolve.ts';
import { listProviderModels, handleAiTestConnection } from '../enrichment/ai-providers.service.ts';
import { getDb } from '../db/client.ts';
import { WorkerConfigRepo, type WorkerConfigDoc } from '../workers/worker-config.repo.ts';
import { resetDescribeDeps } from '../workers/stages/describe.ts';
import { resetVideoDescribeDeps } from '../workers/stages/video-describe.ts';
import type { WorkerConfig } from '../workers/stage-config.ts';
import { validateDescribePatch } from './enrichment-describe-patch.ts';

const ModelQueryBody = t.Object({
  provider: t.String(),
  url: t.Optional(t.Union([t.String(), t.Null()])),
  api_key: t.Optional(t.Union([t.String(), t.Null()])),
});

const TestConnectionBody = t.Object({
  provider: t.String(),
  url: t.Optional(t.Union([t.String(), t.Null()])),
  api_key: t.Optional(t.Union([t.String(), t.Null()])),
});

const UpdateAiConfigBody = t.Object({
  providers: t.Optional(
    t.Object({
      ollama: t.Optional(
        t.Object({
          url: t.Optional(t.Union([t.String(), t.Null()])),
          servers: t.Optional(
            t.Union([
              t.Array(
                t.Object({
                  url: t.String(),
                  concurrency: t.Optional(t.Union([t.Number(), t.Null()])),
                }),
              ),
              t.Null(),
            ]),
          ),
        }),
      ),
      openai: t.Optional(
        t.Object({
          api_key: t.Optional(t.Union([t.String(), t.Null()])),
        }),
      ),
      anthropic: t.Optional(
        t.Object({
          api_key: t.Optional(t.Union([t.String(), t.Null()])),
        }),
      ),
      gemini: t.Optional(
        t.Object({
          api_key: t.Optional(t.Union([t.String(), t.Null()])),
        }),
      ),
    }),
  ),
  workers: t.Optional(
    t.Record(
      t.String(),
      t.Object({
        provider: t.String(),
        model: t.String(),
      }),
    ),
  ),
});

function resolveWorkerAssignment(
  cfg: WorkerConfig | null,
  fallbackProvider: string,
  fallbackModel: string,
): { provider: string; model: string } {
  return {
    provider: cfg?.ai_provider || fallbackProvider,
    model: cfg?.ai_model || fallbackModel,
  };
}

type AiUpdate = typeof UpdateAiConfigBody.static;

function updatedServers(
  ollama: NonNullable<NonNullable<AiUpdate['providers']>['ollama']>,
  current: EnrichmentConfig | null,
) {
  if (ollama.servers !== undefined) return ollama.servers;
  if (ollama.url === null) return null;
  const url = ollama.url;
  if (!url || !current?.describe_servers?.length) return undefined;
  return current.describe_servers.map((server, index) =>
    index === 0 ? { ...server, url } : server,
  );
}

function ollamaPatch(
  ollama: NonNullable<AiUpdate['providers']>['ollama'],
  current: EnrichmentConfig | null,
): Partial<EnrichmentConfig> | { error: string } {
  if (!ollama) return {};
  const endpoints = validateDescribePatch({
    describe_provider_url: ollama.url,
    describe_servers: updatedServers(ollama, current),
  });
  if ('error' in endpoints) return endpoints;
  return {
    ...(endpoints.url !== undefined ? { describe_provider_url: endpoints.url } : {}),
    ...(endpoints.servers !== undefined ? { describe_servers: endpoints.servers } : {}),
  };
}

function credentialPatch(providers: AiUpdate['providers']): Partial<EnrichmentConfig> {
  const patch: Partial<EnrichmentConfig> = {};
  for (const provider of ['openai', 'anthropic', 'gemini'] as const) {
    const key = providers?.[provider]?.api_key;
    if (key !== undefined) patch[`${provider}_api_key`] = key?.trim() || null;
  }
  return patch;
}

const VALID_AI_WORKERS = new Set(['describe', 'video-describe']);

type Assignments = Record<string, { provider: string; model: string }>;

function assignmentError(workers: Assignments): string | null {
  for (const [name, assignment] of Object.entries(workers)) {
    if (
      !VALID_AI_WORKERS.has(name) ||
      !asDescribeProvider(assignment.provider) ||
      !assignment.model.trim()
    ) {
      return `Invalid worker assignment: ${name}`;
    }
  }
  return null;
}

async function updateWorkerAssignments(
  repo: WorkerConfigRepo,
  workers: Assignments,
): Promise<void> {
  for (const [workerName, assignment] of Object.entries(workers)) {
    await repo.patch(workerName, {
      ai_provider: assignment.provider,
      ai_model: assignment.model.trim(),
    });
    if (workerName === 'describe') {
      await saveEnrichmentConfig({
        describe_provider: asDescribeProvider(assignment.provider),
        describe_model: assignment.model.trim(),
      });
    }
  }
}

export const aiRoutes = new Elysia({ prefix: '/api/ai' })
  .use(requireAuth)

  // GET /api/ai/config — Return configured AI providers status & worker assignments
  .get('/config', async () => {
    const resolved = resolveEnrichmentConfig(await loadEnrichmentConfig());

    const db = await getDb();
    const repo = new WorkerConfigRepo(db.collection<WorkerConfigDoc>('worker_config'));
    const [describeConfig, videoDescribeConfig] = await Promise.all([
      repo.load('describe'),
      repo.load('video-describe'),
    ]);

    const defaultProvider = resolved.describe_provider || 'ollama';
    const defaultModel = resolved.describe_model || DEFAULT_DESCRIBE_MODELS.ollama;

    return {
      providers: {
        ollama: {
          url: resolved.describe_provider_url,
          servers: resolved.describe_servers,
        },
        openai: {
          has_key: Boolean(resolved.openai_api_key),
        },
        anthropic: {
          has_key: Boolean(resolved.anthropic_api_key),
        },
        gemini: {
          has_key: Boolean(resolved.gemini_api_key),
        },
      },
      workers: {
        describe: resolveWorkerAssignment(describeConfig, defaultProvider, defaultModel),
        'video-describe': resolveWorkerAssignment(
          videoDescribeConfig,
          defaultProvider,
          defaultModel,
        ),
      },
      available_workers: [
        { id: 'describe', name: 'Describe (Image Captioning & OCR)' },
        { id: 'video-describe', name: 'Video Describe (Video Summarization)' },
      ],
    };
  })

  // PUT /api/ai/config — Save AI provider configuration and worker assignments
  .put(
    '/config',
    async ({ body, set }) => {
      const db = await getDb();
      const repo = new WorkerConfigRepo(db.collection<WorkerConfigDoc>('worker_config'));
      const currentEnrichment = await loadEnrichmentConfig();

      // Validate the entire request before changing any persisted settings.
      const assignments: Assignments = body.workers ?? {};
      const error = assignmentError(assignments);
      if (error) {
        set.status = 400;
        return { error };
      }
      const enrichmentPatch = ollamaPatch(body.providers?.ollama, currentEnrichment);
      if ('error' in enrichmentPatch) {
        set.status = 400;
        return enrichmentPatch;
      }
      const patch = { ...enrichmentPatch, ...credentialPatch(body.providers) };
      if (Object.keys(patch).length > 0) await saveEnrichmentConfig(patch);
      await updateWorkerAssignments(repo, assignments);

      resetDescribeDeps();
      resetVideoDescribeDeps();

      return { ok: true };
    },
    { body: UpdateAiConfigBody, beforeHandle: requireOwnerBeforeHandle },
  )

  // POST /api/ai/models — Fetch list of models from a provider
  .post(
    '/models',
    async ({ body, set }) => {
      const provider = asDescribeProvider(body.provider);
      if (!provider) {
        set.status = 400;
        return { error: `Invalid provider "${body.provider}"` };
      }
      const config = resolveEnrichmentConfig(await loadEnrichmentConfig());
      const apiKey =
        body.api_key !== undefined
          ? body.api_key
          : provider === 'ollama'
            ? undefined
            : config[`${provider}_api_key`];
      return await listProviderModels(provider, {
        url: body.url ?? config.describe_provider_url,
        apiKey,
      });
    },
    { body: ModelQueryBody, beforeHandle: requireOwnerBeforeHandle },
  )

  // POST /api/ai/test — Health-check a provider connection
  .post(
    '/test',
    async ({ body, set }) => {
      const provider = asDescribeProvider(body.provider);
      if (!provider) {
        set.status = 400;
        return { ok: false, error: `Invalid provider "${body.provider}"` };
      }
      const config = resolveEnrichmentConfig(await loadEnrichmentConfig());
      const apiKey =
        body.api_key !== undefined
          ? body.api_key
          : provider === 'ollama'
            ? undefined
            : config[`${provider}_api_key`];
      const result = await handleAiTestConnection(
        provider,
        body.url ?? config.describe_provider_url,
        apiKey,
      );
      if (!result.ok && result.status) {
        set.status = result.status;
      }
      return result;
    },
    { body: TestConnectionBody, beforeHandle: requireOwnerBeforeHandle },
  );
