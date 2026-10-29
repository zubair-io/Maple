/**
 * The `maple-cli pano stitch` subprocess shared by the `pano_stitch` and
 * `pano_preview` handlers: input resolution, the option flags both pass, and
 * one spawn with stderr progress, cooperative cancel and failure reporting.
 *
 * Progress is `PROGRESS_PER_STAGE` units for each of the stitch's six stage
 * ordinals (0 decode, 1 features, 2 matching, 3 refine, 4 solve, 5 composite),
 * parsed from the `pano: progress <stage> <label> <percent>%` lines the CLI
 * prints (#4578). A binary that predates those lines prints none, so its job simply
 * sits at zero until it finishes.
 */

import path from 'node:path';
import { ObjectId } from '../../db/object-id.ts';
import { loadAssetLocationViews } from '../../db/repos/assets.locations.repo.ts';
import { assetAbsPath } from '../../indexer/images.repo.ts';
import { invalidateLibraryRoots, loadLibraryRoots } from '../../indexer/libraries.cache.ts';
import { child as childLogger } from '../../log.ts';
import { jailExecutablePaths } from '../../pano/pano-config-paths.ts';
import { decodeMemoryBudget } from '../../ffi/decode-memory-budget.ts';
import type { JobHandlerContext } from './index.ts';
import type { PanoStitchPayload } from './pano-stitch.ts';

const PANO_STAGE_COUNT = 6;
export const PROGRESS_PER_STAGE = 100;
export const PROGRESS_TOTAL = PANO_STAGE_COUNT * PROGRESS_PER_STAGE;

const PROGRESS_LINE = /^pano: progress (\d+) \S+ (\d+)%$/;
const CANCEL_POLL_MS = 3_000;
const KILL_GRACE_MS = 10_000;

/** Progress units a `pano: progress` line stands for, or null for any other line. */
export function progressFromLine(line: string): number | null {
  const m = PROGRESS_LINE.exec(line);
  if (!m) return null;
  const stage = Math.min(Number(m[1]), PANO_STAGE_COUNT - 1);
  const fraction = Math.min(Number(m[2]), 100) / 100;
  return Math.round((stage + fraction) * PROGRESS_PER_STAGE);
}

/** Absolute paths of the selected assets, sorted by name (= capture order). */
export async function resolveInputPaths(assetIds: readonly string[]): Promise<string[]> {
  const invalid = assetIds.find((id) => !ObjectId.isValid(id));
  if (invalid !== undefined) throw new Error(`pano: invalid asset id: ${invalid}`);
  const [libs, viewsById] = await Promise.all([
    loadLibraryRoots(),
    loadAssetLocationViews(assetIds.map((id) => new ObjectId(id))),
  ]);
  return assetIds
    .map((id) => {
      const view = viewsById.get(id);
      if (!view) throw new Error(`pano: asset not found: ${id}`);
      const p = assetAbsPath(view, libs);
      if (!p) throw new Error(`pano: asset has no resolvable path: ${id}`);
      return p;
    })
    .sort();
}

/**
 * The option flags a preview and the stitch it leads to must agree on — the
 * matcher included, so the stitch can reuse the preview's alignment.
 */
export function panoOptionArgs(payload: PanoStitchPayload): string[] {
  return [
    '--retention',
    payload.retention,
    '--local-align',
    payload.localAlign,
    ...(payload.featuresEngine ? ['--features-engine', payload.featuresEngine] : []),
    ...(payload.strategySupported && payload.strategy ? ['--strategy', payload.strategy] : []),
    ...(payload.modelsDir ? ['--models-dir', payload.modelsDir] : []),
  ];
}

function panoEnv(payload: PanoStitchPayload): Record<string, string> {
  return {
    ...(process.env as Record<string, string>),
    ...(payload.modelsDir ? { MAPLE_PANO_MODELS: payload.modelsDir } : {}),
    ...(payload.ortDylibPath ? { ORT_DYLIB_PATH: payload.ortDylibPath } : {}),
  };
}

export interface PanoCliRun {
  exitCode: number;
  cancelled: boolean;
  stderrLines: string[];
  progress: number;
}

async function drainLines(
  stream: ReadableStream<Uint8Array>,
  onLine: (line: string) => Promise<void>,
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const line of lines) await onLine(line.trim());
  }
  await onLine(buf.trim());
}

async function drainAndDiscard(stream: ReadableStream<Uint8Array>): Promise<void> {
  const reader = stream.getReader();
  while (!(await reader.read()).done);
}

/**
 * Stop the CLI and wait until it has exited: SIGTERM, then SIGKILL once the
 * grace period passes. Only an exited process has given its memory back.
 */
export async function terminateCli(
  proc: Bun.Subprocess,
  graceMs: number = KILL_GRACE_MS,
): Promise<void> {
  if (proc.exitCode !== null || proc.signalCode !== null) return;
  proc.kill('SIGTERM');
  if (!(await exitsWithin(proc, graceMs))) proc.kill('SIGKILL');
  await proc.exited;
}

/** Whether the process exits within `ms`; the timer is cleared either way so
 * no grace-period wait outlives the process. */
async function exitsWithin(proc: Bun.Subprocess, ms: number): Promise<boolean> {
  const timer: { id?: ReturnType<typeof setTimeout> } = {};
  const deadline = new Promise<boolean>((resolve) => {
    timer.id = setTimeout(resolve, ms, false);
  });
  try {
    return await Promise.race([proc.exited.then(() => true), deadline]);
  } finally {
    clearTimeout(timer.id);
  }
}

// The poll races the process exit so it wakes as soon as the CLI is done,
// instead of adding a fixed tail of one poll interval to every job.
async function killOnCancel(proc: Bun.Subprocess, ctx: JobHandlerContext): Promise<void> {
  while (true) {
    const tick = await Promise.race([
      Bun.sleep(CANCEL_POLL_MS).then(() => 'tick' as const),
      proc.exited.then(
        () => 'exited' as const,
        () => 'exited' as const,
      ),
    ]);
    if (tick === 'exited') return;
    if (await ctx.shouldCancel()) return terminateCli(proc);
  }
}

export async function runPanoCli(
  payload: PanoStitchPayload,
  args: readonly string[],
  ctx: JobHandlerContext,
): Promise<PanoCliRun> {
  // The payload was validated when the job was created; roots can have been
  // registered since, and legacy payloads predate the guard (#4743), so the
  // executables are re-checked right before spawn against roots read fresh
  // from the database — this worker's cache is never invalidated by the API
  // process that registers libraries.
  invalidateLibraryRoots();
  const jailed = await jailExecutablePaths({
    maple_cli_path: payload.mapleCli,
    ort_dylib_path: payload.ortDylibPath,
  });
  if (!jailed.ok) throw new Error(`pano: refusing to spawn — ${jailed.error}`);
  const executables = {
    ...payload,
    mapleCli: jailed.canonical.maple_cli_path ?? payload.mapleCli,
    ortDylibPath: jailed.canonical.ort_dylib_path ?? payload.ortDylibPath,
  };
  // A stitch peaks at tens of GB, so it reserves the whole decode memory
  // budget and runs only once every in-flight decode has released (#5467).
  const release = await decodeMemoryBudget().acquireAll();
  try {
    if (await ctx.shouldCancel()) {
      return { exitCode: 0, cancelled: true, stderrLines: [], progress: 0 };
    }
    return await spawnPanoCli(executables, args, ctx);
  } finally {
    release();
  }
}

async function spawnPanoCli(
  executables: PanoStitchPayload,
  args: readonly string[],
  ctx: JobHandlerContext,
): Promise<PanoCliRun> {
  const proc = Bun.spawn([executables.mapleCli, ...args], {
    env: panoEnv(executables),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const stderrLines: string[] = [];
  let progress = 0;
  const onLine = async (line: string) => {
    if (line.length === 0) return;
    stderrLines.push(line);
    const units = progressFromLine(line);
    if (units === null || units <= progress) return;
    progress = units;
    await ctx.reportProgress(progress, PROGRESS_TOTAL).catch(() => {});
  };
  // A lost lease makes shouldCancel throw mid-run; the CLI must still be
  // stopped before the caller releases the memory budget it holds.
  try {
    const [exitCode] = await Promise.all([
      proc.exited,
      drainLines(proc.stderr, onLine),
      drainAndDiscard(proc.stdout),
      killOnCancel(proc, ctx),
    ]);
    return { exitCode, cancelled: await ctx.shouldCancel(), stderrLines, progress };
  } finally {
    await terminateCli(proc);
  }
}

const log = childLogger('job:pano-cli');

export const PANO_CLI_FAILURE_MESSAGE =
  'The panorama merge failed. The server log has the details.';

/** The job's error is shown to the user verbatim, so the exit code and the
 *  tool's stderr go to the log instead (#5487). */
export function cliFailure(run: PanoCliRun): Error {
  log.error(
    { exitCode: run.exitCode, stderr: run.stderrLines.slice(-10) },
    'maple-cli pano failed',
  );
  return new Error(PANO_CLI_FAILURE_MESSAGE);
}

export function reportPath(outputDir: string): string {
  return path.join(outputDir, 'report.json');
}
