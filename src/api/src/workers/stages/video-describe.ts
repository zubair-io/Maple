import { assignedAiPool } from '../../enrichment/ai-assigned-pool.ts';
/**
 * Video-describe (multi-frame visual description) stage — #2158.
 *
 * The `describe` stage captions a video from its single poster frame, so
 * later subjects, actions, text, and scene changes never reach search. This
 * stage samples several frames across the WHOLE clip, sends them to the
 * locked vision model in one multi-image request, and writes:
 *
 *   video_description       — { summary, scenes: [{ timestamp_ms, caption,
 *                              text_visible }] }
 *   video_description_meta  — provenance + sampling/cost diagnostics
 *
 * Frame sampling (`../../video/`) is bounded and deterministic: codec
 * I-frames are the candidate pool, a normalized-pixel-difference threshold
 * deduplicates near-identical candidates, survivors are capped and
 * uniformly downselected keeping the clip's two endpoints, and a
 * visually-static clip is filled from evenly-spaced duration anchors so it
 * is never represented by a single frame alone. See `../../video/sample-frames.ts`
 * for the full pipeline and `docs/superpowers` video-describe design (#2158)
 * for the numeric bounds.
 *
 * Separate from `describe` on purpose (design doc): this is GPU-bound and
 * cost-multiplying (one multi-image request costs more than one still), so
 * it gets its own independent pause/concurrency/retry controls rather than
 * competing with the still-image queue, and the still prompt/parser stay
 * untouched.
 *
 * Uses its own AI Settings assignment, with the legacy Describe pool as
 * the pre-migration fallback. JSON schema is locked; prompt guidance is
 * editable on the worker card.
 *
 * Degradation ladder, on a provider rejection (terminal error — too many
 * images, unsupported request shape): retry with every other selected
 * frame, then with the single first frame only. A TRANSPORT error (network,
 * timeout, 5xx — surfaced as a retryable `RemoteError`, or anything that
 * isn't a `RemoteError` at all) is never retried at this layer; it
 * propagates so the stage runner's ordinary retry/backoff handles it,
 * exactly like every other stage's provider call.
 *
 * `pausedOnFirstBoot: true` — same reasoning as `describe`: an operator
 * must confirm the vision model is available before this stage starts
 * spending GPU time, and it starts at concurrency 1 (design doc: "the
 * stage starts paused with concurrency one").
 */

import { DescribeServerPool } from '../../enrichment/describe-server-pool.ts';
import {
  RemoteError,
  type DescribeResult,
  getDescribeProvider,
  type DescribeProviderName,
} from '../../enrichment/describe-providers/index.ts';
import {
  parseVideoJson,
  strippedRawFor,
  VIDEO_DESCRIPTION_JSON_SCHEMA,
} from '../../enrichment/describe-providers/parse-video-json.ts';
import {
  VIDEO_DESCRIBE_PROMPT_VERSION,
  composeVideoDescribePrompt,
} from '../../enrichment/describe-providers/video-prompt.ts';
import {
  DESCRIBE_VISION_OLLAMA_TAG,
  DEFAULT_DESCRIBE_MODELS,
  loadEnrichmentConfig,
} from '../../enrichment/enrichment-config.repo.ts';
import { resolveEnrichmentConfig } from '../../enrichment/enrichment-config.resolve.ts';
import { loadWorkerConfigSafe } from '../worker-config.repo.ts';
import type { VideoDescriptionMeta } from '../../db/schema.ts';
import { STAGE_STATE_VIDEO_NARROWING } from '../../db/sqlite/ddl/stage-state.ts';
import { videoDescriptionStatements } from '../../db/repos/assets.stage-patches.ts';
import { assetAbsPath, assetPrimaryFileInfo } from '../../indexer/images.repo.ts';
import { loadLibraryRoots } from '../../indexer/libraries.cache.ts';
import { isVideoFilename } from '../../indexer/media-types.ts';
import type { ImageDoc, StageContext, StageResult } from '../run-stage.ts';
import { defineStage, runStage, type RunStageHandle } from '../run-stage.ts';
import { sampleVideoFrames, type SampledFrame } from '../../video/sample-frames.ts';

interface DescribeCallResult {
  result: DescribeResult;
  server: { url: string; model?: string; provider?: DescribeProviderName };
}

interface VideoDescribeDeps {
  sampleFrames: typeof sampleVideoFrames;
  describe: (frames: readonly Buffer[]) => Promise<DescribeCallResult>;
  model: string;
  provider?: DescribeProviderName;
}

let _deps: VideoDescribeDeps | null = null;

function resolveVideoProvider(
  workerProvider?: string | null,
  cfgProvider?: string,
): DescribeProviderName {
  if (workerProvider) return workerProvider as DescribeProviderName;
  if (cfgProvider) return cfgProvider as DescribeProviderName;
  return 'ollama';
}

function resolveVideoModel(
  workerModel: string | null | undefined,
  cfgModel: string | undefined,
  provider: DescribeProviderName,
): string {
  if (workerModel) return workerModel;
  if (cfgModel) return cfgModel;
  return DEFAULT_DESCRIBE_MODELS[provider] || DESCRIBE_VISION_OLLAMA_TAG;
}

function createVideoDescribePool(
  provider: DescribeProviderName,
  servers: ReturnType<typeof resolveEnrichmentConfig>['describe_servers'],
  concurrency: number,
  apiKey?: string | null,
): DescribeServerPool {
  if (provider === 'ollama') {
    return new DescribeServerPool(servers);
  }
  return new DescribeServerPool([{ url: provider, concurrency }], () =>
    getDescribeProvider(provider, { apiKey }),
  );
}

// fallow-ignore-next-line complexity
async function getDeps(): Promise<VideoDescribeDeps> {
  if (_deps) return _deps;
  const cfg = resolveEnrichmentConfig(await loadEnrichmentConfig());
  const workerConfig = await loadWorkerConfigSafe('video-describe');

  const assigned = assignedAiPool(cfg.ai_connections, 'video-describe');
  const provider =
    assigned?.provider ?? resolveVideoProvider(workerConfig?.ai_provider, cfg.describe_provider);
  const model =
    assigned?.model ?? resolveVideoModel(workerConfig?.ai_model, cfg.describe_model, provider);
  const systemPrompt = composeVideoDescribePrompt(workerConfig?.prompt_text);
  const apiKey =
    provider === 'openai'
      ? cfg.openai_api_key
      : provider === 'anthropic'
        ? cfg.anthropic_api_key
        : provider === 'gemini'
          ? cfg.gemini_api_key
          : null;
  const pool =
    assigned?.pool ??
    createVideoDescribePool(provider, cfg.describe_servers, workerConfig?.concurrency ?? 1, apiKey);

  _deps = {
    sampleFrames: sampleVideoFrames,
    describe: (frames) =>
      pool.run(async (p, server) => ({
        result: await p.describe(frames, {
          systemPrompt,
          model: server.model ?? model,
          format: p.name === 'ollama' ? VIDEO_DESCRIPTION_JSON_SCHEMA : undefined,
        }),
        server,
      })),
    model,
    provider,
  };
  return _deps;
}

/** Invalidate the deps cache so the next call re-reads the describe server
 * list from the persisted config — wired the same way `describe.ts`'s
 * `resetDescribeDeps` is, from `applyDescribeConfig`. */
export function resetVideoDescribeDeps(): void {
  _deps = null;
}

/** Test-only setter. Call with `null` to reset between tests. */
export function setVideoDescribeDepsForTests(deps: VideoDescribeDeps | null): void {
  _deps = deps;
}

type FallbackLevel = VideoDescriptionMeta['fallback_level'];

/** Build the degradation ladder for one sampled frame set: the full set,
 * then every-other-frame, then the single first frame — skipping a rung
 * that would not actually reduce the frame count (e.g. "every other" of a
 * 2-frame set is identical to "poster only", so it is left out). */
function degradationLadder(
  frames: readonly SampledFrame[],
): Array<{ level: FallbackLevel; frames: SampledFrame[] }> {
  const rungs: Array<{ level: FallbackLevel; frames: SampledFrame[] }> = [
    { level: 'full', frames: [...frames] },
  ];
  if (frames.length > 1) {
    const reduced = frames.filter((_, i) => i % 2 === 0);
    if (reduced.length > 1 && reduced.length < frames.length) {
      rungs.push({ level: 'reduced', frames: reduced });
    }
    rungs.push({ level: 'poster-only', frames: [frames[0]!] });
  }
  return rungs;
}

/** True for a terminal (non-retryable) provider error — the request's own
 * fault (too many images, unsupported shape), not a transport hiccup. Only
 * this class of failure is worth retrying at a lower frame count; anything
 * else (a retryable `RemoteError`, or any non-`RemoteError` — network
 * failure, abort) propagates immediately to the stage runner's own
 * retry/backoff. */
function isTerminalProviderError(err: unknown): boolean {
  return err instanceof RemoteError && !err.retryable;
}

// fallow-ignore-next-line complexity
export async function videoDescribeHandler(
  image: ImageDoc,
  _ctx: StageContext,
): Promise<StageResult> {
  const primary = assetPrimaryFileInfo(image);
  if (!primary || !isVideoFilename(primary.filename)) {
    // Defensive — `claimResidual` already restricts claims to video assets.
    return { skip: 'not-video' };
  }

  const absolutePath = assetAbsPath(image, await loadLibraryRoots());
  if (!absolutePath) return { skip: 'no-resolvable-location' };

  const deps = await getDeps();

  const sampled = await deps.sampleFrames(absolutePath);
  if (!sampled.ok) {
    return { skip: sampled.reason };
  }

  const ladder = degradationLadder(sampled.frames);
  let inferenceMs = 0;
  let call: DescribeCallResult | null = null;
  let fallbackLevel: FallbackLevel = 'full';
  let usedFrames: SampledFrame[] = sampled.frames;

  for (let i = 0; i < ladder.length; i++) {
    const rung = ladder[i]!;
    const startedAt = Date.now();
    try {
      call = await deps.describe(rung.frames.map((f) => f.jpeg));
      inferenceMs += Date.now() - startedAt;
      fallbackLevel = rung.level;
      usedFrames = rung.frames;
      break;
    } catch (err) {
      inferenceMs += Date.now() - startedAt;
      const isLastRung = i === ladder.length - 1;
      if (!isTerminalProviderError(err) || isLastRung) throw err;
    }
  }
  // Unreachable: the loop above either returns via `break` (call set) or
  // rethrows on its final iteration.
  if (!call) throw new Error('video-describe: exhausted the degradation ladder with no result');

  const timestampsSec = usedFrames.map((f) => f.timestampSec);
  const description = parseVideoJson(call.result.text, timestampsSec);

  const now = new Date().toISOString();
  const meta: VideoDescriptionMeta = {
    provider: call.server.provider ?? deps.provider ?? 'ollama',
    server_url: call.server.url,
    model: call.server.model ?? deps.model,
    prompt_version: VIDEO_DESCRIBE_PROMPT_VERSION,
    generated_at: now,
    candidate_count: sampled.candidateCount,
    frame_count: usedFrames.length,
    encoded_bytes: usedFrames.reduce((sum, f) => sum + f.jpeg.byteLength, 0),
    // Measure post-fence-strip so this matches what the parser actually
    // consumed, same convention as `describe.ts`'s `rawResponseSize`.
    raw_response_size: Buffer.byteLength(strippedRawFor(call.result.text), 'utf8'),
    sampling_ms: sampled.samplingMs,
    inference_ms: inferenceMs,
    fallback_level: fallbackLevel,
    cost_usd: call.result.cost_usd,
  };

  return {
    patch: videoDescriptionStatements(image._id.toHexString(), description, meta),
    // search_blob folds in the summary + scene text (enrichment/search-blob.ts) —
    // re-arm meili in the same atomic write so a fresh video description is
    // searchable without waiting for an unrelated meili re-run.
    invalidates: ['meili'],
  };
}

const videoDescribeStage = defineStage({
  name: 'video-describe',
  targetVersion: 1,
  // Runs after `preview` so a container ffmpeg genuinely cannot decode
  // never reaches this GPU-bound stage at all — `preview` already proved
  // (or failed to prove) the file is decodable via its own poster-frame
  // extraction.
  dependsOn: ['preview'],
  // Never sweeps the (much larger) photo library — mirrors `transcribe`'s
  // claim-residual narrowing, and see there for what the two halves each do.
  // The `EXISTS` over `assets` is the authoritative test and is unchanged;
  // `STAGE_STATE_VIDEO_NARROWING` is what selects the partial index and skips
  // the audio rows it still holds, both from the index alone (#3795).
  claimResidual: {
    sql: `${STAGE_STATE_VIDEO_NARROWING}
          AND EXISTS (SELECT 1 FROM assets
                       WHERE id = stage_state.asset_id AND media_kind = ?)`,
    params: ['video'],
  },
  defaults: {
    concurrency: 1,
    maxAttempts: 5,
    paused: false,
    pausedOnFirstBoot: true,
    last_seen_target_version: 0,
  },
  onConfigChange: () => {
    resetVideoDescribeDeps();
  },
  handler: videoDescribeHandler,
});

export default videoDescribeStage;

export async function startVideoDescribeStage(): Promise<RunStageHandle> {
  return runStage(videoDescribeStage);
}
