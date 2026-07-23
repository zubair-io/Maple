import { randomBytes } from 'node:crypto';
import { stat, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractAudioWav, hasAudioStream } from '../../audio/extract-audio.ts';
import { transcribeWav } from '../../audio/whisper-cli.ts';
import { ensureWhisperModel, type WhisperTier } from '../../audio/whisper-model.ts';
import type { TranscriptResult } from '../../audio/whisper-parse.ts';
import { assetsCollection } from '../../db/client.ts';
import type { TranscriptDoc } from '../../db/schema.ts';
import { loadEnrichmentConfig } from '../../enrichment/enrichment-config.repo.ts';
import { resolveEnrichmentConfig } from '../../enrichment/enrichment-config.resolve.ts';
import { assetAbsPath, assetPrimaryFileInfo } from '../../indexer/images.repo.ts';
import { loadLibraryRoots } from '../../indexer/libraries.cache.ts';
import {
  AUDIO_EXTS,
  VIDEO_EXTS,
  isAudioFilename,
  isVideoFilename,
} from '../../indexer/media-types.ts';
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
  persistTranscript: (id: ImageDoc['_id'], transcript: TranscriptDoc) => Promise<void>;
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

/**
 * Filename regex for the claim query — matches any video/audio extension,
 * built from the same `VIDEO_EXTS`/`AUDIO_EXTS` the handler's
 * `isTranscribableFilename` uses so the two can't drift. Anchored to the end,
 * case-insensitive. Mirrors the `backfill-video-exif` migration's approach.
 */
const TRANSCRIBABLE_FILENAME_RE = new RegExp(
  `\\.(${[...VIDEO_EXTS, ...AUDIO_EXTS].map((e) => e.slice(1)).join('|')})$`,
  'i',
);

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
    persistTranscript: async (id, transcript) => {
      await (
        await assetsCollection()
      ).updateOne(
        { _id: id },
        {
          $set: {
            transcript,
            'stages.meili.version': 0,
            'stages.meili.attempts': 0,
            'stages.meili.last_error': null,
            'stages.meili.processed_at': null,
            'stages.meili.dead': false,
          },
        },
      );
    },
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
    await deps.persistTranscript(image._id, transcript);
    return { wrote: true };
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
  claimFilter: { fileinfo: { $elemMatch: { filename: { $regex: TRANSCRIBABLE_FILENAME_RE } } } },
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
    // Persist transcript + Meili re-arm atomically. Returning `wrote` lets
    // the runner record this stage without accepting forbidden stage keys.
    return transcribeMedia(image, absolutePath, deps, context.signal);
  },
});

export default transcribeStage;

export async function startTranscribeStage(): Promise<RunStageHandle> {
  return runStage(transcribeStage);
}
