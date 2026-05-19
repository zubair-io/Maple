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
 * dependency (e.g. ONNX model missing) doesn't take the whole API down.
 */

import { child as childLogger } from "../log.ts";
import type { RunStageHandle } from "./run-stage.ts";
import { startHashStage } from "./stages/hash.ts";
import { startExifStage } from "./stages/exif.ts";
import { startThumbStage } from "./stages/thumb.ts";
import { startFaceStage } from "./stages/face.ts";
import { startOcrStage } from "./stages/ocr.ts";
import { startDescribeStage } from "./stages/describe.ts";
import { startGeocodeStage } from "./stages/geocode.ts";
import { startMeiliStage } from "./stages/meili.ts";

const log = childLogger("workers:orchestrator");

const STAGE_STARTERS: ReadonlyArray<readonly [string, () => Promise<RunStageHandle>]> = [
  ["hash", startHashStage],
  ["exif", startExifStage],
  ["thumb", startThumbStage],
  ["face", startFaceStage],
  ["ocr", startOcrStage],
  ["describe", startDescribeStage],
  ["geocode", startGeocodeStage],
  ["meili", startMeiliStage],
];

const handles = new Map<string, RunStageHandle>();

/**
 * Boot every stage runner in parallel. A failing stage logs and is skipped;
 * the other stages still come up.
 */
export async function startAllStages(): Promise<void> {
  await Promise.all(
    STAGE_STARTERS.map(async ([name, starter]) => {
      try {
        const handle = await starter();
        handles.set(name, handle);
      } catch (err) {
        log.error(
          { stage: name, err: err instanceof Error ? err.message : err },
          `${name} stage failed to start`,
        );
      }
    }),
  );
}

/**
 * Stop every running stage in parallel and wait for in-flight handlers to
 * drain. Each stage's stop() is bounded internally (~30s) so this won't hang.
 */
export async function stopAllStages(): Promise<void> {
  const entries = [...handles.entries()];
  handles.clear();
  await Promise.all(
    entries.map(async ([name, handle]) => {
      try {
        await handle.stop();
      } catch (err) {
        log.warn(
          { stage: name, err: err instanceof Error ? err.message : err },
          `${name} stage stop() raised`,
        );
      }
    }),
  );
}

/** Test-only: snapshot of stage names whose start() resolved. */
export function startedStageNames(): string[] {
  return [...handles.keys()];
}
