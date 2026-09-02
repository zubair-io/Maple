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
 * Reuses the SAME locked model/provider pool as `describe` — provider,
 * model, and prompt are not operator-configurable (see
 * `docs/indexer-enrichment.md` §describe); only the server URL list is.
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
import { RemoteError, type DescribeResult } from '../../enrichment/describe-providers/index.ts';
import {
  parseVideoJson,
  strippedRawFor,
  VIDEO_DESCRIPTION_JSON_SCHEMA,
} from '../../enrichment/describe-providers/parse-video-json.ts';
import {
  VIDEO_DESCRIBE_PROMPT_VERSION,
  VIDEO_DESCRIBE_SYSTEM_PROMPT,
} from '../../enrichment/describe-providers/video-prompt.ts';
import {
  DESCRIBE_VISION_OLLAMA_TAG,
  loadEnrichmentConfig,
} from '../../enrichment/enrichment-config.repo.ts';
import { resolveEnrichmentConfig } from '../../enrichment/enrichment-config.resolve.ts';
import type { VideoDescriptionMeta } from '../../db/schema.ts';
import { assetAbsPath, assetPrimaryFileInfo } from '../../indexer/images.repo.ts';
import { loadLibraryRoots } from '../../indexer/libraries.cache.ts';
import { isVideoFilename, VIDEO_EXTS } from '../../indexer/media-types.ts';
import type { ImageDoc, StageContext, StageResult } from '../run-stage.ts';
import { defineStage, runStage, type RunStageHandle } from '../run-stage.ts';
import { sampleVideoFrames, type SampledFrame } from '../../video/sample-frames.ts';

interface DescribeCallResult {
  result: DescribeResult;
  server: { url: string };
}

interface VideoDescribeDeps {
  sampleFrames: typeof sampleVideoFrames;
  describe: (frames: readonly Buffer[]) => Promise<DescribeCallResult>;
  model: string;
}

let _deps: VideoDescribeDeps | null = null;

async function getDeps(): Promise<VideoDescribeDeps> {
  if (_deps) return _deps;
  const cfg = resolveEnrichmentConfig(await loadEnrichmentConfig());
  // `cfg.describe_servers` always resolves to at least one entry (falls
  // back to a derived single server) — see `enrichment-config.resolve.ts`.
  // Same pool shape as `describe.ts`; a config change there (an operator
  // editing the server list) is picked up here too via `resetVideoDescribeDeps`.
  const pool = new DescribeServerPool(cfg.describe_servers);
  _deps = {
    sampleFrames: sampleVideoFrames,
    describe: (frames) =>
      pool.run(async (provider, server) => ({
        result: await provider.describe(frames, {
          systemPrompt: VIDEO_DESCRIBE_SYSTEM_PROMPT,
          model: DESCRIBE_VISION_OLLAMA_TAG,
          format: VIDEO_DESCRIPTION_JSON_SCHEMA,
        }),
        server,
      })),
    model: DESCRIBE_VISION_OLLAMA_TAG,
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

const VIDEO_FILENAME_RE = new RegExp(
  `\\.(${[...VIDEO_EXTS].map((e) => e.slice(1)).join('|')})$`,
  'i',
);

// fallow-ignore-next-line complexity
export async function videoDescribeHandler(
  image: ImageDoc,
  _ctx: StageContext,
): Promise<StageResult> {
  const primary = assetPrimaryFileInfo(image);
  if (!primary || !isVideoFilename(primary.filename)) {
    // Defensive — `claimFilter` already restricts claims to video filenames.
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
    provider: 'ollama',
    server_url: call.server.url,
    model: deps.model,
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
    patch: { video_description: description, video_description_meta: meta },
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
  // claim-filter narrowing.
  claimFilter: { fileinfo: { $elemMatch: { filename: { $regex: VIDEO_FILENAME_RE } } } },
  defaults: {
    concurrency: 1,
    maxAttempts: 5,
    paused: false,
    pausedOnFirstBoot: true,
    last_seen_target_version: 0,
  },
  handler: videoDescribeHandler,
});

export default videoDescribeStage;

export async function startVideoDescribeStage(): Promise<RunStageHandle> {
  return runStage(videoDescribeStage);
}
