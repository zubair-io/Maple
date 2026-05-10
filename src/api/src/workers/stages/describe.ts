/**
 * Describe (caption) stage. Wraps the describe provider abstraction under
 * `enrichment/describe-providers/`.
 *
 * `pausedOnFirstBoot: true` — this stage calls an external paid API and
 * requires an operator-configured API key and model before it can run.
 * The operator unpauses it from `/settings/workers` once they've set
 * `MAPLE_ANTHROPIC_API_KEY` (or equivalent) and chosen a model.
 *
 * Provider, systemPrompt, and model are resolved from the persisted enrichment
 * config at first use and cached as module-level singletons. Tests inject
 * dependencies via `setDescribeDepsForTests`.
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
  getDescribeProvider,
} from "../../enrichment/describe-providers/index.ts";
import {
  loadEnrichmentConfig,
  resolveEnrichmentConfig,
  DEFAULT_DESCRIBE_SYSTEM_PROMPT,
} from "../../enrichment/enrichment-config.repo.ts";

/** Bump when the default prompt changes. Stored on `description_meta.prompt_version`
 * so a version-bump backfill can re-caption stale rows. */
export const DESCRIBE_PROMPT_VERSION = 1;

interface DescribeDeps {
  provider: DescribeProvider;
  systemPrompt: string;
  model: string;
}

let _deps: DescribeDeps | null = null;

async function getDeps(): Promise<DescribeDeps> {
  if (_deps) return _deps;
  const dbConfig = await loadEnrichmentConfig();
  const cfg = resolveEnrichmentConfig(dbConfig);
  const provider = getDescribeProvider(cfg.describe_provider, {
    url: cfg.describe_provider_url,
  });
  _deps = {
    provider,
    systemPrompt: cfg.describe_system_prompt ?? DEFAULT_DESCRIBE_SYSTEM_PROMPT,
    model: cfg.describe_model,
  };
  return _deps;
}

/** Test-only setter. Call with `null` to reset between tests. */
export function setDescribeDepsForTests(deps: DescribeDeps | null): void {
  _deps = deps;
}

export async function describeHandler(
  image: ImageDoc,
  _ctx: StageContext,
): Promise<StageResult> {
  const { provider, systemPrompt, model } = await getDeps();
  const thumbPath = cachePathFor(image.abs_path as string, "thumbs");
  const jpegBytes = await readFile(thumbPath);
  const result = await provider.describe(jpegBytes, {
    systemPrompt,
    model,
  });
  return {
    patch: {
      description: result.text,
      description_meta: {
        provider: provider.name,
        model,
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
  handler: describeHandler,
});
