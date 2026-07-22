import { randomBytes } from 'node:crypto';
import { stat, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractAudioWav, hasAudioStream } from '../../audio/extract-audio.ts';
import { transcribeWav } from '../../audio/whisper-cli.ts';
import { ensureWhisperModel, type WhisperTier } from '../../audio/whisper-model.ts';
import type { TranscriptResult } from '../../audio/whisper-parse.ts';
import {
  loadEnrichmentConfig,
  resolveEnrichmentConfig,
} from '../../enrichment/enrichment-config.repo.ts';
import { assetAbsPath, assetPrimaryFileInfo } from '../../indexer/images.repo.ts';
import { loadLibraryRoots } from '../../indexer/libraries.cache.ts';
import { isAudioFilename, isVideoFilename } from '../../indexer/media-types.ts';
import { defineStage, runStage, type RunStageHandle, type StageResult } from '../run-stage.ts';

interface TranscribeDeps {
  hasAudioStream: (path: string) => Promise<boolean>;
  extractAudioWav: (mediaPath: string, wavPath: string) => Promise<boolean>;
  transcribeWav: (
    wavPath: string,
    modelPath: string,
    options?: { timeoutMs?: number; signal?: AbortSignal },
  ) => Promise<TranscriptResult | null>;
  ensureWhisperModel: (tier: WhisperTier) => Promise<string | null>;
  wavByteLength: (path: string) => Promise<number>;
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
    tier: config.transcribe_model_tier,
  };
}

const transcribeStage = defineStage({
  name: 'transcribe',
  targetVersion: 1,
  dependsOn: [],
  tagsMissingOnEnoent: true,
  defaults: {
    concurrency: 1,
    maxAttempts: 5,
    paused: false,
    pausedOnFirstBoot: true,
    last_seen_target_version: 0,
  },
  handler: async (image, context): Promise<StageResult> => {
    const primary = assetPrimaryFileInfo(image);
    if (!primary || !(isVideoFilename(primary.filename) || isAudioFilename(primary.filename))) {
      return { skip: 'not-media' };
    }
    const absolutePath = assetAbsPath(image, await loadLibraryRoots());
    if (!absolutePath) return { skip: 'no-resolvable-location' };

    const deps = await dependencies();
    if (!(await deps.hasAudioStream(absolutePath))) return { skip: 'no-audio' };
    const modelPath = await deps.ensureWhisperModel(deps.tier);
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
        signal: context.signal,
        timeoutMs: transcriptionTimeoutMs(wavBytes),
      });
      if (!result) throw new Error('transcription failed');
      return {
        patch: {
          transcript: {
            ...result,
            model: deps.tier,
            duration_sec: result.segments.at(-1)?.end ?? null,
            generated_at: new Date().toISOString(),
          },
          'stages.meili.version': 0,
          'stages.meili.attempts': 0,
          'stages.meili.last_error': null,
          'stages.meili.processed_at': null,
          'stages.meili.dead': false,
        },
      };
    } finally {
      await unlink(wavPath).catch(() => {});
    }
  },
});

export default transcribeStage;

export async function startTranscribeStage(): Promise<RunStageHandle> {
  return runStage(transcribeStage);
}
