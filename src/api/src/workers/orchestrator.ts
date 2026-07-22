/**
 * Per-stage orchestrator — boots and drains the in-process stage runners.
 *
 * Replaces the deleted multi-process supervisor (`supervisor.ts`) — see issue
 * #135. Each `startXxxStage()` function in `stages/*.ts` calls `runStage()`
 * which publishes itself into the in-process `stageRegistry` and returns a
 * `RunStageHandle` whose `stop()` drains in-flight work. This file tracks
 * those handles for graceful shutdown.
 *
 * Boot is best-effort: a failing stage logs and is skipped so a misconfigured
 * dependency (e.g. ONNX model missing) doesn't take the whole API down. For
 * transient failures (Mongo hiccup during `bootConfig`, network blip while
 * loading a dependency) the failed starter is retried in the background with
 * exponential backoff so the stage eventually comes up without an API restart
 * — the old multi-process supervisor used to retry boot, and `/api/workers/
 * status` would otherwise report the stage as permanently missing.
 */

import { child as childLogger } from '../log.ts';
import type { RunStageHandle } from './run-stage.ts';
import { resolveStageDeps } from './run-stage.ts';
import { stageRegistry } from './registry.ts';
import { stageManifest } from './stages/manifest.ts';
import { startExifStage } from './stages/exif.ts';
import { startThumbStage } from './stages/thumb.ts';
import { startPreviewStage } from './stages/preview.ts';
import { startFaceDetectStage } from './stages/face-detect.ts';
import { startFaceEmbedStage } from './stages/face-embed.ts';
import { startDescribeStage } from './stages/describe.ts';
import { startGeocodeStage } from './stages/geocode.ts';
import { startMeiliStage } from './stages/meili.ts';
import { startSidecarMetadataIndexStage } from './stages/sidecar-metadata-index.ts';
import { startCfThumbSyncStage } from './stages/cf-thumb-sync.ts';
import { startTranscribeStage } from './stages/transcribe.ts';

const log = childLogger('workers:orchestrator');

const STAGE_STARTERS: ReadonlyArray<readonly [string, () => Promise<RunStageHandle>]> = [
  ['exif', startExifStage],
  ['thumb', startThumbStage],
  ['preview', startPreviewStage],
  ['face-detect', startFaceDetectStage],
  ['face-embed', startFaceEmbedStage],
  ['describe', startDescribeStage],
  ['geocode', startGeocodeStage],
  ['meili', startMeiliStage],
  ['sidecar-metadata-index', startSidecarMetadataIndexStage],
  ['cf-thumb-sync', startCfThumbSyncStage],
  ['transcribe', startTranscribeStage],
];

const handles = new Map<string, RunStageHandle>();
const retryTimers = new Map<string, ReturnType<typeof setTimeout>>();

// Bounded retry schedule for failed starters. Matches the per-tick poll-loop
// backoff in run-stage.ts so transient Mongo / dependency failures recover on
// the same order-of-magnitude as in-loop errors. Saturates at the final value.
const RETRY_BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000];

async function attemptStart(
  name: string,
  starter: () => Promise<RunStageHandle>,
  attempt: number,
): Promise<void> {
  try {
    const handle = await starter();
    handles.set(name, handle);
    // Clear any error left over from a prior failed attempt so the registry
    // reports a clean recovery once the stage is running.
    stageRegistry.clearError(name);
    if (attempt > 0) {
      log.info({ stage: name, attempt }, `${name} stage started after retry`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Record into the registry so /api/workers/status surfaces the failure.
    // The stage was pre-registered at boot, so even the very first failed
    // attempt shows up as a `status: "error"` row instead of going missing.
    stageRegistry.recordError(name, msg);
    const idx = Math.min(attempt, RETRY_BACKOFF_MS.length - 1);
    const delay = RETRY_BACKOFF_MS[idx]!;
    // Pass the raw `err` to pino so its standard serializer expands the
    // Error object (stack trace + driver-specific fields like MongoDB's
    // error codes survive). Restores the fix from #25 — a stringified
    // `err.message` strips structured fields that triage relies on.
    log.error(
      { stage: name, err, attempt, retryInMs: delay },
      `${name} stage failed to start — retrying`,
    );
    const timer = setTimeout(() => {
      retryTimers.delete(name);
      void attemptStart(name, starter, attempt + 1);
    }, delay);
    retryTimers.set(name, timer);
  }
}

/**
 * Boot every stage runner in parallel. A failing stage logs and is scheduled
 * for a bounded retry in the background; the other stages still come up.
 *
 * Pre-registers all stages with the registry first so `GET /api/workers/status`
 * always returns the full set of 10 entries — even when a stage's `bootConfig()`
 * is still mid-retry. Otherwise a slow-booting stage (Mongo blip, ONNX model
 * missing) silently vanishes from the API surface until it succeeds, which
 * regresses the old multi-process supervisor's contract.
 */
export async function startAllStages(): Promise<void> {
  for (const stage of stageManifest) {
    stageRegistry.preregister(stage.name, stage.targetVersion, resolveStageDeps(stage.dependsOn));
  }
  await Promise.all(STAGE_STARTERS.map(([name, starter]) => attemptStart(name, starter, 0)));
}

/**
 * Stop every running stage in parallel and wait for in-flight handlers to
 * drain. Each stage's stop() is bounded internally (~30s) so this won't hang.
 * Also cancels any pending boot-retry timers so a retry doesn't fire (and
 * register a stage) mid-shutdown.
 */
export async function stopAllStages(): Promise<void> {
  for (const timer of retryTimers.values()) clearTimeout(timer);
  retryTimers.clear();
  const entries = [...handles.entries()];
  handles.clear();
  await Promise.all(
    entries.map(async ([name, handle]) => {
      try {
        await handle.stop();
      } catch (err) {
        // Pass raw `err` so pino's serializer expands Error fields.
        log.warn({ stage: name, err }, `${name} stage stop() raised`);
      }
    }),
  );
}
