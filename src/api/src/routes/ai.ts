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
  testProviderConnection,
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

export const aiRoutes = new Elysia({ prefix: '/api/ai' })
  .use(requireAuth)

  // GET /api/ai/config — Return configured AI providers status & worker assignments
  .get('/config', async () => {
    const raw = await loadEnrichmentConfig();
    const resolved = resolveEnrichmentConfig(raw);

    const db = await getDb();
    const repo = new WorkerConfigRepo(db.collection<WorkerConfigDoc>('worker_config'));
    const describeConfig = await repo.load('describe');
    const videoDescribeConfig = await repo.load('video-describe');

    const hasOpenaiKey = Boolean(
      resolveEnvKey('openai') || (raw as Record<string, unknown> | null)?.openai_api_key,
    );
    const hasAnthropicKey = Boolean(
      resolveEnvKey('anthropic') || (raw as Record<string, unknown> | null)?.anthropic_api_key,
    );
    const hasGeminiKey = Boolean(
      resolveEnvKey('gemini') || (raw as Record<string, unknown> | null)?.gemini_api_key,
    );

    return {
      providers: {
        ollama: {
          url: resolved.describe_provider_url,
          servers: resolved.describe_servers,
        },
        openai: {
          has_key: hasOpenaiKey,
        },
        anthropic: {
          has_key: hasAnthropicKey,
        },
        gemini: {
          has_key: hasGeminiKey,
        },
      },
      workers: {
        describe: {
          provider: describeConfig?.ai_provider ?? resolved.describe_provider ?? 'ollama',
          model:
            describeConfig?.ai_model ?? resolved.describe_model ?? DEFAULT_DESCRIBE_MODELS.ollama,
        },
        'video-describe': {
          provider: videoDescribeConfig?.ai_provider ?? resolved.describe_provider ?? 'ollama',
          model:
            videoDescribeConfig?.ai_model ??
            resolved.describe_model ??
            DEFAULT_DESCRIBE_MODELS.ollama,
        },
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

      // 1. Update enrichment config for providers
      const enrichmentPatch: Record<string, unknown> = {};
      if (body.providers?.ollama) {
        if (body.providers.ollama.url !== undefined) {
          enrichmentPatch.describe_provider_url = body.providers.ollama.url;
        }
        if (body.providers.ollama.servers !== undefined) {
          enrichmentPatch.describe_servers = body.providers.ollama.servers;
        }
      }
      if (body.providers?.openai?.api_key) {
        enrichmentPatch.openai_api_key = body.providers.openai.api_key;
        process.env.MAPLE_OPENAI_API_KEY = body.providers.openai.api_key;
      }
      if (body.providers?.anthropic?.api_key) {
        enrichmentPatch.anthropic_api_key = body.providers.anthropic.api_key;
        process.env.MAPLE_ANTHROPIC_API_KEY = body.providers.anthropic.api_key;
      }
      if (body.providers?.gemini?.api_key) {
        enrichmentPatch.gemini_api_key = body.providers.gemini.api_key;
        process.env.MAPLE_GEMINI_API_KEY = body.providers.gemini.api_key;
      }

      if (Object.keys(enrichmentPatch).length > 0) {
        await saveEnrichmentConfig(enrichmentPatch as never);
      }

      // 2. Update worker configs for assigned workers
      if (body.workers) {
        for (const [workerName, assignment] of Object.entries(body.workers)) {
          const typedProvider = asDescribeProvider(assignment.provider);
          if (!typedProvider) {
            set.status = 400;
            return { error: `Unknown provider: ${assignment.provider}` };
          }
          await repo.patch(workerName, {
            ai_provider: typedProvider,
            ai_model: assignment.model,
          });
          // Also keep describe_provider / describe_model in sync for describe worker
          if (workerName === 'describe') {
            await saveEnrichmentConfig({
              describe_provider: typedProvider,
              describe_model: assignment.model,
            } as never);
          }
        }
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
    { body: ModelQueryBody },
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
      const result = await testProviderConnection(provider, {
        url: body.url ?? null,
        apiKey: body.api_key ?? null,
      });
      if (!result.ok) {
        set.status =
          result.status && result.status >= 400 && result.status < 600 ? result.status : 400;
      }
      return result;
    },
    { body: TestConnectionBody },
  );
