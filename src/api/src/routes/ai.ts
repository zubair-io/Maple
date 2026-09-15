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
} from '../enrichment/enrichment-config.repo.ts';
import { resolveEnrichmentConfig } from '../enrichment/enrichment-config.resolve.ts';
import {
  listProviderModels,
  handleAiTestConnection,
  resolveEnvKey,
} from '../enrichment/ai-providers.service.ts';
import { getDb } from '../db/client.ts';
import { WorkerConfigRepo, type WorkerConfigDoc } from '../workers/worker-config.repo.ts';
import { resetDescribeDeps } from '../workers/stages/describe.ts';
import { resetVideoDescribeDeps } from '../workers/stages/video-describe.ts';

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

function checkProviderKey(raw: Record<string, unknown> | null, provider: string): boolean {
  if (resolveEnvKey(provider)) return true;
  const configKey = `${provider}_api_key`;
  return Boolean(raw && raw[configKey]);
}

function resolveWorkerAssignment(
  cfg: WorkerConfigDoc | null,
  fallbackProvider: string,
  fallbackModel: string,
): { provider: string; model: string } {
  return {
    provider: cfg?.ai_provider || fallbackProvider,
    model: cfg?.ai_model || fallbackModel,
  };
}

function applyApiKeyUpdate(
  patch: Record<string, unknown>,
  patchKey: string,
  envVar: string,
  key: string | null | undefined,
): void {
  if (key === undefined) return;
  patch[patchKey] = key;
  if (key) {
    process.env[envVar] = key;
  } else {
    delete process.env[envVar];
  }
}

function applyOllamaPatch(
  patch: Record<string, unknown>,
  ollama:
    | {
        url?: string | null;
        servers?: Array<{ url: string; concurrency?: number | null }> | null;
      }
    | undefined,
): void {
  if (!ollama) return;
  if (ollama.url !== undefined) {
    patch.describe_provider_url = ollama.url;
  }
  if (ollama.servers !== undefined) {
    patch.describe_servers = ollama.servers;
  }
}

const VALID_AI_WORKERS = new Set(['describe', 'video-describe']);

async function updateWorkerAssignments(
  repo: WorkerConfigRepo,
  workers: Record<string, { provider: string; model: string }> | undefined,
): Promise<string | null> {
  if (!workers) return null;
  for (const [workerName, assignment] of Object.entries(workers)) {
    if (!VALID_AI_WORKERS.has(workerName)) {
      return `Invalid worker: ${workerName}`;
    }
    const typedProvider = asDescribeProvider(assignment.provider);
    if (!typedProvider) {
      return `Unknown provider: ${assignment.provider}`;
    }
    await repo.patch(workerName, {
      ai_provider: typedProvider,
      ai_model: assignment.model,
    });
    if (workerName === 'describe') {
      await saveEnrichmentConfig({
        describe_provider: typedProvider,
        describe_model: assignment.model,
      } as never);
    }
  }
  return null;
}

export const aiRoutes = new Elysia({ prefix: '/api/ai' })
  .use(requireAuth)

  // GET /api/ai/config — Return configured AI providers status & worker assignments
  .get('/config', async () => {
    const raw = (await loadEnrichmentConfig()) as Record<string, unknown> | null;
    const resolved = resolveEnrichmentConfig(raw as never);

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
          has_key: checkProviderKey(raw, 'openai'),
        },
        anthropic: {
          has_key: checkProviderKey(raw, 'anthropic'),
        },
        gemini: {
          has_key: checkProviderKey(raw, 'gemini'),
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

      const enrichmentPatch: Record<string, unknown> = {};
      applyOllamaPatch(enrichmentPatch, body.providers?.ollama);
      applyApiKeyUpdate(
        enrichmentPatch,
        'openai_api_key',
        'MAPLE_OPENAI_API_KEY',
        body.providers?.openai?.api_key,
      );
      applyApiKeyUpdate(
        enrichmentPatch,
        'anthropic_api_key',
        'MAPLE_ANTHROPIC_API_KEY',
        body.providers?.anthropic?.api_key,
      );
      applyApiKeyUpdate(
        enrichmentPatch,
        'gemini_api_key',
        'MAPLE_GEMINI_API_KEY',
        body.providers?.gemini?.api_key,
      );

      if (Object.keys(enrichmentPatch).length > 0) {
        await saveEnrichmentConfig(enrichmentPatch as never);
      }

      const err = await updateWorkerAssignments(repo, body.workers);
      if (err) {
        set.status = 400;
        return { error: err };
      }

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
      return await listProviderModels(provider, {
        url: body.url ?? null,
        apiKey: body.api_key ?? null,
      });
    },
    { body: ModelQueryBody, beforeHandle: requireOwnerBeforeHandle },
  )

  // POST /api/ai/test — Health-check a provider connection
  .post(
    '/test',
    async ({ body, set }) => {
      const result = await handleAiTestConnection(body.provider, body.url, body.api_key);
      if (!result.ok && result.status) {
        set.status = result.status;
      }
      return result;
    },
    { body: TestConnectionBody, beforeHandle: requireOwnerBeforeHandle },
  );
