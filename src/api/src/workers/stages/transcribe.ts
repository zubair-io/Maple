import { randomBytes } from 'node:crypto';
import { stat, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractAudioWav, hasAudioStream } from '../../audio/extract-audio.ts';
import { transcribeWav } from '../../audio/whisper-cli.ts';
import { ensureWhisperModel, type WhisperTier } from '../../audio/whisper-model.ts';
import type { TranscriptResult } from '../../audio/whisper-parse.ts';
import { transcriptStatement } from '../../db/sqlite/repos/assets.stage-patches.ts';
import type { TranscriptDoc } from '../../db/schema.ts';
import { loadEnrichmentConfig } from '../../enrichment/enrichment-config.repo.ts';
import { resolveEnrichmentConfig } from '../../enrichment/enrichment-config.resolve.ts';
import { assetAbsPath, assetPrimaryFileInfo } from '../../indexer/images.repo.ts';
import { loadLibraryRoots } from '../../indexer/libraries.cache.ts';
import { isAudioFilename, isVideoFilename } from '../../indexer/media-types.ts';
import {
  defineStage,
  runStage,
  type ImageDoc,
  type RunStageHandle,
  type StageResult,
} from '../run-stage.ts';

interface TranscribeDeps {
  hasAudioStream: (path: string) => Promise<boolean>;
  extractAudioWav: (mediaPath: string, wavPath: string) => Promise<boolean>;
  transcribeWav: (
    wavPath: string,
    modelPath: string,
    options?: { timeoutMs?: number; signal?: AbortSignal },
  ) => Promise<TranscriptResult | null>;
  ensureWhisperModel: (
    tier: WhisperTier,
    options?: { signal?: AbortSignal },
  ) => Promise<string | null>;
  wavByteLength: (path: string) => Promise<number>;
  assertReadable: (path: string) => Promise<void>;
  tier: WhisperTier;
}

/** Whisper CPU time varies by host. Scale from the extracted PCM duration,
 * allow at least five minutes, and cap at six hours so a wedged process is
 * eventually killed even for very long recordings. */
export function transcriptionTimeoutMs(wavBytes: number): number {
  const durationSeconds = Math.max(0, wavBytes - 44) / (16_000 * 2);
  return Math.min(6 * 60 * 60_000, Math.max(5 * 60_000, durationSeconds * 4_000 + 120_000));
}

let injectedDeps: TranscribeDeps | null = null;

function isTranscribableFilename(filename: string | undefined): boolean {
  return filename !== undefined && (isVideoFilename(filename) || isAudioFilename(filename));
}

export function setTranscribeDepsForTests(deps: TranscribeDeps | null): void {
  injectedDeps = deps;
}

async function dependencies(): Promise<TranscribeDeps> {
  if (injectedDeps) return injectedDeps;
  const config = resolveEnrichmentConfig(await loadEnrichmentConfig());
  return {
    hasAudioStream,
    extractAudioWav,
    transcribeWav,
    ensureWhisperModel,
    wavByteLength: async (path) => (await stat(path)).size,
    assertReadable: async (path) => void (await stat(path)),
    tier: config.transcribe_model_tier,
  };
}

async function transcribeMedia(
  image: ImageDoc,
  absolutePath: string,
  deps: TranscribeDeps,
  signal: AbortSignal,
): Promise<StageResult> {
  const modelPath = await deps.ensureWhisperModel(deps.tier, { signal });
  if (!modelPath) throw new Error('whisper model not available');

  const wavPath = join(
    tmpdir(),
    `maple-transcribe-${process.pid}-${randomBytes(6).toString('hex')}.wav`,
  );
  try {
    if (!(await deps.extractAudioWav(absolutePath, wavPath))) {
      throw new Error('audio extraction failed');
    }
    const wavBytes = await deps.wavByteLength(wavPath);
    const result = await deps.transcribeWav(wavPath, modelPath, {
      signal,
      timeoutMs: transcriptionTimeoutMs(wavBytes),
    });
    if (!result) throw new Error('transcription failed');
    const transcript: TranscriptDoc = {
      ...result,
      model: deps.tier,
      duration_sec: result.segments.at(-1)?.end ?? null,
      generated_at: new Date().toISOString(),
    };
    // The transcript and the search-stage re-arm go back to the runner rather
    // than being written here, which is what makes them atomic with this
    // stage's own success row. On Mongo they were one `$set` the handler issued
    // itself — the transcript plus five `stages.meili.*` keys — and it returned
    // `{ wrote: true }` precisely because the runner refuses a patch that
    // touches stage bookkeeping. `invalidates` is that same re-arm expressed as
    // something the runner owns, so the handler no longer has to reach around
    // it.
    return {
      patch: [transcriptStatement(image._id.toHexString(), transcript)],
      invalidates: ['meili'],
    };
  } finally {
    await unlink(wavPath).catch(() => {});
  }
}

const transcribeStage = defineStage({
  name: 'transcribe',
  targetVersion: 1,
  dependsOn: [],
  tagsMissingOnEnoent: true,
  // Only claim assets that actually have a video/audio file, so the stage
  // never sweeps the (much larger) photo library stamping `not-media` skips —
  // it goes straight to media. The handler's own extension + `no-audio` skips
  // stay the correctness backstop; this only narrows what gets claimed.
  //
  // An `EXISTS` over `assets` rather than a join, because the claim scans
  // `stage_state` and this has to stay a probe per candidate row — `media_kind`
  // has a partial index over exactly the two minority kinds (#3492), so the
  // probe is a seek.
  claimResidual: {
    sql: `EXISTS (SELECT 1 FROM assets
                   WHERE id = stage_state.asset_id AND media_kind IN (?, ?))`,
    params: ['video', 'audio'],
  },
  defaults: {
    concurrency: 1,
    maxAttempts: 5,
    paused: false,
    pausedOnFirstBoot: true,
    last_seen_target_version: 0,
  },
  handler: async (image, context): Promise<StageResult> => {
    const primary = assetPrimaryFileInfo(image);
    if (!isTranscribableFilename(primary?.filename)) {
      return { skip: 'not-media' };
    }
    const absolutePath = assetAbsPath(image, await loadLibraryRoots());
    if (!absolutePath) return { skip: 'no-resolvable-location' };

    const deps = await dependencies();
    await deps.assertReadable(absolutePath);
    if (!(await deps.hasAudioStream(absolutePath))) return { skip: 'no-audio' };
    return transcribeMedia(image, absolutePath, deps, context.signal);
  },
});

export default transcribeStage;

export async function startTranscribeStage(): Promise<RunStageHandle> {
  return runStage(transcribeStage);
}
