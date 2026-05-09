/**
 * Describe (caption) stage. Wraps the describe provider abstraction under
 * `enrichment/describe-providers/`.
 *
 * `pausedOnFirstBoot: true` — this stage calls an external paid API and
 * requires an operator-configured API key and model before it can run.
 * The operator unpauses it from `/settings/workers` once they've set
 * `MAPLE_ANTHROPIC_API_KEY` (or equivalent) and chosen a model.
 *
 * Provider, systemPrompt, and model are injected via `StageContext` so
 * the runtime can resolve them from `worker_config` at boot. The handler
 * itself is a pure function of the image doc and those three values.
 *
 * Daily spend cap is a runtime / config concern, not a handler concern.
 * The `describe-spend.repo.ts` utilities are called by the runtime if
 * it resolves a cap from `worker_config[describe].daily_cap_usd`.
 */

import { readFile } from "node:fs/promises";
import type { ImageDoc, StageContext, StageResult } from "../runtime/define-stage.ts";
import { defineStage } from "../runtime/define-stage.ts";
import { cachePathFor } from "../../fs/xmp.ts";
import {
  type DescribeProvider,
} from "../../enrichment/describe-providers/index.ts";

/** Bump when the default prompt changes. Stored on `description_meta.prompt_version`
 * so a version-bump backfill can re-caption stale rows. */
export const DESCRIBE_PROMPT_VERSION = 1;

export async function describeHandler(
  image: ImageDoc,
  ctx: StageContext & {
    provider: DescribeProvider;
    systemPrompt: string;
    model: string;
  },
): Promise<StageResult> {
  const thumbPath = cachePathFor(image.abs_path as string, "thumbs");
  const jpegBytes = await readFile(thumbPath);
  const result = await ctx.provider.describe(jpegBytes, {
    systemPrompt: ctx.systemPrompt,
    model: ctx.model,
  });
  return {
    patch: {
      description: result.text,
      description_meta: {
        provider: ctx.provider.name,
        model: ctx.model,
        prompt_version: DESCRIBE_PROMPT_VERSION,
        generated_at: new Date().toISOString(),
        cost_usd: result.cost_usd,
        ...result.provider_info,
      },
    },
  };
}

export default defineStage({
  name: "describe",
  targetVersion: 1,
  dependsOn: ["thumb"],
  defaults: {
    concurrency: 2,
    pollIntervalMs: 1000,
    batchSize: 5,
    maxAttempts: 5,
    paused: false,
    last_seen_target_version: 0,
    pausedOnFirstBoot: true,
  },
  handler: async (image, ctx) => {
    // Runtime resolves provider/systemPrompt/model from worker_config and
    // injects them on ctx before calling the handler.
    return describeHandler(image, ctx as Parameters<typeof describeHandler>[1]);
  },
});
