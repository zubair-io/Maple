import { t } from 'elysia';

// Keep removed fields in the parsed body so the route can explicitly reject them.
export const WorkerConfigBody = t.Object({
  concurrency: t.Optional(t.Integer({ minimum: 1, maximum: 100 })),
  maxAttempts: t.Optional(t.Integer({ minimum: 1, maximum: 20 })),
  paused: t.Optional(t.Boolean()),
  pollIntervalMs: t.Optional(t.Unknown()),
  batchSize: t.Optional(t.Unknown()),
  sweepDirIntervalMs: t.Optional(t.Integer({ minimum: 0, maximum: 60_000 })),
  version: t.Optional(
    t.Union([
      t.String({ pattern: '^v?(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)$' }),
      t.Null(),
    ]),
  ),
  prompt_text: t.Optional(t.Union([t.String(), t.Null()])),
  ai_provider: t.Optional(
    t.Union([
      t.Literal('ollama'),
      t.Literal('openai'),
      t.Literal('anthropic'),
      t.Literal('gemini'),
      t.Null(),
    ]),
  ),
  ai_model: t.Optional(t.Union([t.String({ minLength: 1, pattern: '\\S' }), t.Null()])),
});
