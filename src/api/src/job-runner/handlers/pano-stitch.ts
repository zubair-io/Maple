/**
 * `pano_stitch` job handler.
 *
 * Payload:
 *   {
 *     assetIds:      string[],              // ObjectId hex — assets to stitch
 *     libraryId:     string,                // library to import result into
 *     outputDir:     string,                // absolute temp dir for output PNG
 *     retention:     'keep' | 'strict',
 *     localAlign:    'mesh' | 'off',
 *     strategy?:     'auto' | 'rotation' | 'tile',   // only when strategySupported
 *     strategySupported: boolean,
 *     mapleCli:      string,                // resolved maple-cli path
 *     featuresEngine: 'classical' | 'ml' | null, // null: binary predates the flag
 *     modelsDir:     string | null,         // ML only
 *     ortDylibPath:  string | null,         // ML only
 *     matcherNote:   string | null,         // why the planned matcher differs (#5487)
 *     alignmentIn?:  string | null,         // a done preview's alignment.json (#4580)
 *   }
 *
 * The handler:
 *   1. Resolves the absolute paths for the selected assets.
 *   2. Spawns `maple-cli pano stitch <inputs...> --out <output.png>
 *      --report <report.json> --retention <r> --local-align <l>
 *      [--features-engine <e>] [--strategy <s>] [--models-dir <d>]
 *      [--alignment-in <a>]` via Bun.spawn. A null engine means a
 *      pre-#4523 binary, which is ML-only and has no flag.
 *   3. Streams stderr `pano: progress` lines into job progress
 *      (`pano-cli-process.ts`).
 *   4. On exit 0: upserts the output PNG as a new asset in the library and
 *      records the report's alignment verdict — `reused` means the preview's
 *      matching was not repeated.
 *   5. On non-zero exit or spawn error: fails the job with the last stderr
 *      content.
 *
 * Single-concurrent constraint: the route enforces this (409 when a
 * pano_stitch job is already running); the handler itself is stateless.
 */

import { mkdir, readFile, rename, rm, unlink } from 'node:fs/promises';
import path from 'node:path';
import { ObjectId } from '../../db/object-id.ts';
import { upsertAssetByMapleId } from '../../db/repos/assets.upsert.ts';
import { hashFileForId } from '../../indexer/id.ts';
import { loadLibraryRoots } from '../../indexer/libraries.cache.ts';
import { child as childLogger } from '../../log.ts';
import type { PanoMatcher } from '../../pano/pano-config.repo.ts';
import { ownedPreviewDir, removePreviewDir, sweepStalePreviews } from '../../pano/pano-previews.ts';
import type { JobHandler, JobHandlerContext, JobHandlerResult } from './index.ts';
import {
  cliFailure,
  panoOptionArgs,
  PROGRESS_PER_STAGE,
  PROGRESS_TOTAL,
  reportPath,
  resolveInputPaths,
  runPanoCli,
} from './pano-cli-process.ts';

const log = childLogger('job:pano-stitch');

export interface PanoStitchPayload {
  assetIds: string[];
  libraryId: string;
  outputDir: string;
  retention: 'keep' | 'strict';
  localAlign: 'mesh' | 'off';
  strategy: 'auto' | 'rotation' | 'tile' | null;
  strategySupported: boolean;
  mapleCli: string;
  featuresEngine: PanoMatcher | null;
  /** Model paths handed to the subprocess; always null for a classical run. */
  modelsDir: string | null;
  ortDylibPath: string | null;
  /** Set when ML was selected but the classical matcher runs instead (#5487). */
  matcherNote: string | null;
  alignmentIn: string | null;
}

/** The report's `alignment` block; null from a binary that predates #4578. */
export interface PanoAlignmentVerdict {
  status: 'solved' | 'reused' | 'stale';
  stale_reason: string | null;
}

/** Which matcher a job ran, for its result (#5487). */
export interface PanoMatcherUsed {
  matcher: PanoMatcher;
  matcherNote: string | null;
}

interface PanoStitchResult extends PanoMatcherUsed {
  outputAssetId: string | null;
  outputPath: string;
  stagesCompleted: number;
  alignment: PanoAlignmentVerdict | null;
  error: string | null;
}

/** A null engine is a pre-#4523 binary, which only runs ML. */
export function matcherUsed(payload: PanoStitchPayload): PanoMatcherUsed {
  return { matcher: payload.featuresEngine ?? 'ml', matcherNote: payload.matcherNote };
}

/** An alignment file inside a preview directory this server handed out. */
function parseAlignmentIn(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const dir = ownedPreviewDir(path.dirname(raw));
  return dir === null ? null : path.join(dir, path.basename(raw));
}

export async function readAlignmentVerdict(
  outputDir: string,
): Promise<PanoAlignmentVerdict | null> {
  const report = await readFile(reportPath(outputDir), 'utf8')
    .then((text) => JSON.parse(text) as { alignment?: PanoAlignmentVerdict })
    .catch(() => null);
  return report?.alignment ?? null;
}

function optionalAbsolutePath(
  raw: Record<string, unknown>,
  key: 'modelsDir' | 'ortDylibPath',
): string | null {
  const value = raw[key];
  if (typeof value !== 'string' || value.length === 0) return null;
  if (value.startsWith('-') || !path.isAbsolute(value)) {
    throw new Error(`pano_stitch: payload.${key} must be an absolute path and not start with "-"`);
  }
  return value;
}

function parseEngine(
  featuresEngine: unknown,
  modelsDir: string | null,
  ortDylibPath: string | null,
): Pick<PanoStitchPayload, 'featuresEngine' | 'modelsDir' | 'ortDylibPath'> {
  if (featuresEngine === 'classical') {
    return { featuresEngine, modelsDir: null, ortDylibPath: null };
  }
  const engine = featuresEngine === 'ml' ? featuresEngine : null;
  if (engine === 'ml' && (modelsDir === null || ortDylibPath === null)) {
    throw new Error('pano_stitch: the ML matcher needs both modelsDir and ortDylibPath');
  }
  return { featuresEngine: engine, modelsDir, ortDylibPath };
}

function requiredString(raw: Record<string, unknown>, key: string): string {
  const value = raw[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`pano_stitch: payload.${key} must be a non-empty string`);
  }
  return value;
}

function parseStrategy(raw: Record<string, unknown>): PanoStitchPayload['strategy'] {
  const s = raw.strategySupported === true ? raw.strategy : null;
  return s === 'auto' || s === 'rotation' || s === 'tile' ? s : null;
}

export function parsePayload(raw: Record<string, unknown>): PanoStitchPayload {
  const ids = raw.assetIds;
  if (!Array.isArray(ids) || ids.length < 2 || ids.some((x) => typeof x !== 'string')) {
    throw new Error('pano_stitch: payload.assetIds must be string[] of length ≥ 2');
  }
  const libraryId = requiredString(raw, 'libraryId');
  const outputDir = requiredString(raw, 'outputDir');
  const mapleCli = requiredString(raw, 'mapleCli');
  if (mapleCli.startsWith('-') || !path.isAbsolute(mapleCli)) {
    throw new Error(
      'pano_stitch: payload.mapleCli must be an absolute path and not start with "-"',
    );
  }
  return {
    assetIds: ids as string[],
    libraryId,
    outputDir,
    retention: raw.retention === 'strict' ? 'strict' : 'keep',
    localAlign: raw.localAlign === 'off' ? 'off' : 'mesh',
    strategy: parseStrategy(raw),
    strategySupported: raw.strategySupported === true,
    mapleCli,
    ...parseEngine(
      raw.featuresEngine,
      optionalAbsolutePath(raw, 'modelsDir'),
      optionalAbsolutePath(raw, 'ortDylibPath'),
    ),
    matcherNote: typeof raw.matcherNote === 'string' ? raw.matcherNote : null,
    alignmentIn: parseAlignmentIn(raw.alignmentIn),
  };
}

export const panoStitchHandler: JobHandler = {
  async run(
    rawPayload: Record<string, unknown>,
    ctx: JobHandlerContext,
  ): Promise<JobHandlerResult> {
    const payload = parsePayload(rawPayload);
    await mkdir(payload.outputDir, { recursive: true });
    // The outputDir is a temp dir created by the route for this job. It must
    // be cleaned up in a finally block regardless of success or failure.
    // The rename path leaves the dir empty after success; the copyFile fallback
    // leaves the source temp PNG behind — that is handled below.

    try {
      const inputPaths = await resolveInputPaths(payload.assetIds);
      await ctx.reportProgress(0, PROGRESS_TOTAL);

      const outputPng = path.join(payload.outputDir, 'pano.png');
      const args = [
        'pano',
        'stitch',
        '--out',
        outputPng,
        '--report',
        reportPath(payload.outputDir),
        ...panoOptionArgs(payload),
        ...(payload.alignmentIn ? ['--alignment-in', payload.alignmentIn] : []),
        '--',
        ...inputPaths,
      ];
      log.info({ cmd: payload.mapleCli, args }, 'spawning maple-cli pano stitch');
      const run = await runPanoCli(payload, args, ctx);
      const stagesCompleted = Math.floor(run.progress / PROGRESS_PER_STAGE);

      if (run.cancelled) {
        const result: PanoStitchResult = {
          outputAssetId: null,
          outputPath: outputPng,
          stagesCompleted,
          alignment: null,
          error: 'cancelled',
          ...matcherUsed(payload),
        };
        return {
          kind: 'cancelled',
          result: result as unknown as Record<string, unknown>,
        };
      }

      if (run.exitCode !== 0) {
        log.error(
          { exitCode: run.exitCode, stderrLines: run.stderrLines.slice(-5) },
          'pano stitch failed',
        );
        throw cliFailure(run);
      }

      const alignment = await readAlignmentVerdict(payload.outputDir);
      log.info({ alignment, alignmentIn: payload.alignmentIn }, 'pano stitch alignment');

      // ── 4. Import result PNG into the library ─────────────────────────────
      await ctx.reportProgress(PROGRESS_TOTAL, PROGRESS_TOTAL);

      const libId = new ObjectId(payload.libraryId);
      const libPath = (await loadLibraryRoots()).get(payload.libraryId);
      if (!libPath) throw new Error(`pano_stitch: library ${payload.libraryId} not found`);

      // Place the result in .maple/panos/<jobId hex>.png under the library root.
      const destDir = path.join(libPath, '.maple', 'panos');
      const destFilename = `${ctx.jobId.toHexString()}.png`;
      const destAbs = path.join(destDir, destFilename);
      await mkdir(destDir, { recursive: true });

      // Move the output PNG into the library. On a cross-device rename (tmpdir
      // on a different mount), fall back to copy + unlink of the source temp so
      // the temp dir is empty before the finally block removes it.
      try {
        await rename(outputPng, destAbs);
      } catch {
        // Cross-device rename (e.g. tmpdir on different mount) — fallback to copy.
        const { copyFile } = await import('node:fs/promises');
        await copyFile(outputPng, destAbs);
        // Unlink the source temp PNG so the temp dir is empty before the
        // finally block removes it.
        await unlink(outputPng).catch(() => {});
      }

      // Derive the real content identity the same way the discover watcher does:
      // hashFileForId reads the first 64 KB, computes sha1_head, and derives a
      // fallback-form MapleId (tag 0x02 || BLAKE3(sha1Full || filesize)).
      // A stitched PNG has no camera serial or shutter count, so the fallback
      // form is the correct choice — no exif stage upgrade will follow.
      //
      // Using the real maple_id means the discover scanner's upsert will
      // coalesce onto this same row if it ever visits .maple/panos/
      // (the sweeper's isInsideMapleCache guard already refuses such events,
      // but if that guard ever fails the real id prevents a duplicate row).
      const fileIdentity = await hashFileForId(destAbs);

      // The upsert reports which row it settled on, so the result payload needs
      // no second lookup by `maple_id` — and cannot be answered by a concurrent
      // writer's asset the way a re-query could.
      const upserted = await upsertAssetByMapleId({
        libraryId: libId,
        relDir: '.maple/panos',
        filename: destFilename,
        size: fileIdentity.size,
        mtime: fileIdentity.mtime,
        mapleId: fileIdentity.maple_id,
        sha1Head: fileIdentity.sha1_head,
      });
      const outputAssetId = upserted.id.toHexString();

      log.info({ outputAssetId, destAbs }, 'pano stitch complete');

      const result: PanoStitchResult = {
        outputAssetId,
        outputPath: destAbs,
        stagesCompleted,
        alignment,
        error: null,
        ...matcherUsed(payload),
      };
      if (payload.alignmentIn) await removePreviewDir(path.dirname(payload.alignmentIn));
      return {
        kind: 'done',
        result: result as unknown as Record<string, unknown>,
      };
    } finally {
      // Remove the temp dir created by the route for this job. On success the
      // rename path has already emptied it; on the copy-fallback path we
      // unlinked the temp PNG above; on error any partial files are cleaned up.
      // Never remove anything outside the job's own outputDir.
      await rm(payload.outputDir, { recursive: true, force: true }).catch((e) => {
        log.warn(
          { err: e, outputDir: payload.outputDir },
          'pano_stitch: failed to remove temp dir',
        );
      });
      await sweepStalePreviews();
    }
  },
};
