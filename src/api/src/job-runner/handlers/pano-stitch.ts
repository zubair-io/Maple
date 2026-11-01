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
 *   2. Spawns `maple-cli pano stitch <inputs...> --display <output.png>
 *      --report <report.json> --retention <r> --local-align <l>
 *      [--features-engine <e>] [--strategy <s>] [--models-dir <d>]
 *      [--alignment-in <a>]` via Bun.spawn. A null engine means a
 *      pre-#4523 binary, which is ML-only and has no flag.
 *   3. Streams stderr `pano: progress` lines into job progress
 *      (`pano-cli-process.ts`).
 *   4. On exit 0: moves the PNG next to the first source frame and upserts it
 *      as an asset (`pano-output-location.ts`), and records the report's
 *      alignment verdict — `reused` means the preview's matching was not
 *      repeated. When that file already exists, the panorama was made before:
 *      the job imports it and finishes without stitching again.
 *   5. On non-zero exit or spawn error: fails the job with the last stderr
 *      content.
 *
 * Single-concurrent constraint: the job store's insert fence enforces this
 * (`pano/pano-admission.ts`); the handler itself is stateless.
 */

import { mkdir as mkdirTemp, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { ObjectId } from '../../db/object-id.ts';
import { lstat, mkdir, withMirrorRoot } from '../../fs/mirrored.ts';
import { errnoCode } from '../../fs/relocate-publish.ts';
import { writeSidecarExclusive } from '../../fs/sidecar-io.ts';
import { xmpSidecarPath } from '../../fs/xmp-sidecar-path.ts';
import { panoCropSidecar } from '../../pano/pano-crop-sidecar.ts';
import { readEdgesReport, type PanoEdgesReport } from '../../pano/pano-edges.ts';
import { publishWhole } from '../../pano/pano-publish.ts';
import { isWithinRoot, resolveRealPathThroughAncestors } from '../../fs/root.ts';
import { recordAndPublishAssetChange } from '../../db/changes.repo.ts';
import { upsertAssetByMapleId } from '../../db/repos/assets.upsert.ts';
import { hashFileForId } from '../../indexer/id.ts';
import { loadLibraryRoots } from '../../indexer/libraries.cache.ts';
import { child as childLogger } from '../../log.ts';
import type { PanoMatcher } from '../../pano/pano-config.repo.ts';
import { panoOutputLocation, type PanoOutputLocation } from '../../pano/pano-output-location.ts';
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
  /** Boundary Warp strength in percent, 0 to 100 (#5576). */
  boundaryWarp: number;
  autoCrop: boolean;
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
  edges: PanoEdgesReport | null;
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

/** The preview directory whose alignment this job reads, if any. */
export const alignmentDir = (payload: PanoStitchPayload): string | null =>
  payload.alignmentIn === null ? null : path.dirname(payload.alignmentIn);

export async function readAlignmentVerdict(
  outputDir: string,
): Promise<PanoAlignmentVerdict | null> {
  const report = await readFile(reportPath(outputDir), 'utf8')
    .then((text) => JSON.parse(text) as { alignment?: PanoAlignmentVerdict })
    .catch(() => null);
  return report?.alignment ?? null;
}

function parseEdges(
  raw: Record<string, unknown>,
): Pick<PanoStitchPayload, 'boundaryWarp' | 'autoCrop'> {
  const warp = raw.boundaryWarp;
  const inRange = typeof warp === 'number' && Number.isFinite(warp) && warp >= 0 && warp <= 100;
  return { boundaryWarp: inRange ? warp : 0, autoCrop: raw.autoCrop === true };
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
    ...parseEdges(raw),
  };
}

async function importOutput(libraryId: string, location: PanoOutputLocation): Promise<string> {
  // The real content identity, derived the way the discover watcher does, so
  // its own upsert coalesces onto this row when it visits the folder. A
  // stitched PNG has no camera serial, so the fallback form is the right one.
  const fileIdentity = await hashFileForId(location.absPath);
  const upserted = await upsertAssetByMapleId({
    libraryId: new ObjectId(libraryId),
    relDir: location.relDir,
    filename: location.filename,
    size: fileIdentity.size,
    mtime: fileIdentity.mtime,
    mapleId: fileIdentity.maple_id,
    sha1Head: fileIdentity.sha1_head,
  });
  return upserted.id.toHexString();
}

/** Tell open clients a freshly stitched panorama exists. */
async function announceCreated(
  libraryId: string,
  assetId: string,
  libraryAbsPath: string,
  location: PanoOutputLocation,
): Promise<void> {
  await recordAndPublishAssetChange({
    kind: 'create',
    asset_id: new ObjectId(assetId),
    folder_id: new ObjectId(libraryId),
    abs_path: libraryAbsPath,
    relative_path:
      location.relDir === '' ? location.filename : `${location.relDir}/${location.filename}`,
  });
}

/** `location` with its folder resolved through symlinks, refused unless that
 * folder is inside the library: a symlinked `Panoramas/` never sends the
 * panorama out of it. */
async function containedLocation(
  realRoot: string,
  location: PanoOutputLocation,
): Promise<PanoOutputLocation> {
  const realDir = await resolveRealPathThroughAncestors(path.dirname(location.absPath));
  if (!isWithinRoot(realRoot, realDir)) {
    throw new Error('pano_stitch: the Panoramas folder resolves outside the library');
  }
  return {
    absPath: path.join(realDir, location.filename),
    relDir: path.relative(realRoot, realDir).split(path.sep).join('/'),
    filename: location.filename,
  };
}

/** Whether an earlier run made this panorama. Anything there that is not a
 * regular file (a planted symlink, say) is refused rather than imported. */
async function alreadyMade(absPath: string): Promise<boolean> {
  const found = await lstat(absPath).catch((err: unknown) => {
    if (errnoCode(err) === 'ENOENT') return null;
    throw err;
  });
  if (found === null) return false;
  if (!found.isFile()) throw new Error(`pano_stitch: ${absPath} is occupied by a non-file`);
  return true;
}

/** Publish the stitched PNG under its name without following a link there or
 * replacing whatever holds the name; the folder is re-checked once it exists.
 * The bytes are copied and verified beside the name first, so a crash never
 * leaves a truncated panorama that a retry would take as already made. Mirrors
 * are addressed through the library's registered spelling. A crop sidecar goes
 * down first, so the indexer never sees the panorama without its crop; one
 * already there is left alone, it may carry edits (#5608). */
async function publishIntoLibrary(
  outputPng: string,
  root: { real: string; registered: string },
  location: PanoOutputLocation,
  cropSidecar: string | null,
): Promise<PanoOutputLocation> {
  return withMirrorRoot(root.real, root.registered, async () => {
    await mkdir(path.dirname(location.absPath), { recursive: true });
    const placed = await containedLocation(root.real, location);
    if (cropSidecar !== null) {
      const written = await writeSidecarExclusive(
        xmpSidecarPath(placed.absPath),
        cropSidecar,
        'pano_stitch: writing the crop sidecar failed',
      );
      if (!written.ok && 'error' in written) throw new Error(written.error);
    }
    await publishWhole(outputPng, placed.absPath);
    return placed;
  });
}

async function fileStamp(p: string): Promise<string> {
  const { size, mtimeMs } = await stat(p);
  return `${size}:${Math.trunc(mtimeMs)}`;
}

export const panoStitchHandler: JobHandler = {
  async run(
    rawPayload: Record<string, unknown>,
    ctx: JobHandlerContext,
  ): Promise<JobHandlerResult> {
    const payload = parsePayload(rawPayload);
    await mkdirTemp(payload.outputDir, { recursive: true });
    // The outputDir is a temp dir created by the route for this job. It must
    // be cleaned up in a finally block regardless of success or failure.

    try {
      const inputPaths = await resolveInputPaths(payload.assetIds);
      const libPath = (await loadLibraryRoots()).get(payload.libraryId);
      if (!libPath) throw new Error(`pano_stitch: library ${payload.libraryId} not found`);
      const realRoot = await resolveRealPathThroughAncestors(libPath);
      const registeredPath = (p: string) => path.join(libPath, path.relative(realRoot, p));
      const location = await containedLocation(
        realRoot,
        panoOutputLocation(realRoot, inputPaths, {
          assetIds: payload.assetIds,
          inputStamps: await Promise.all(inputPaths.map(fileStamp)),
          retention: payload.retention,
          localAlign: payload.localAlign,
          strategy: payload.strategy,
          matcher: matcherUsed(payload).matcher,
          boundaryWarp: payload.boundaryWarp,
          autoCrop: payload.autoCrop,
        }),
      );
      if (await alreadyMade(location.absPath)) {
        log.info({ destAbs: location.absPath }, 'pano stitch already made; importing it');
        await ctx.reportProgress(PROGRESS_TOTAL, PROGRESS_TOTAL);
        const result: PanoStitchResult = {
          outputAssetId: await importOutput(payload.libraryId, location),
          outputPath: registeredPath(location.absPath),
          stagesCompleted: PROGRESS_TOTAL / PROGRESS_PER_STAGE,
          alignment: null,
          edges: null,
          error: null,
          ...matcherUsed(payload),
        };
        return { kind: 'done', result: result as unknown as Record<string, unknown> };
      }
      await ctx.reportProgress(0, PROGRESS_TOTAL);

      const outputPng = path.join(payload.outputDir, 'pano.png');
      const args = [
        'pano',
        'stitch',
        // The display PNG (AgX + sRGB + EXIF) is the library file; `--out`
        // would be the scene-linear carrier, which reads back flat and dark.
        '--display',
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
          edges: null,
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

      const [alignment, edges] = await Promise.all([
        readAlignmentVerdict(payload.outputDir),
        readEdgesReport(reportPath(payload.outputDir)),
      ]);
      log.info({ alignment, alignmentIn: payload.alignmentIn }, 'pano stitch alignment');

      // ── 4. Import result PNG into the library ─────────────────────────────
      await ctx.reportProgress(PROGRESS_TOTAL, PROGRESS_TOTAL);

      const placed = await publishIntoLibrary(
        outputPng,
        { real: realRoot, registered: libPath },
        location,
        payload.autoCrop && edges ? panoCropSidecar(edges) : null,
      );
      const outputAssetId = await importOutput(payload.libraryId, placed);
      const destAbs = registeredPath(placed.absPath);
      await announceCreated(payload.libraryId, outputAssetId, destAbs, placed);

      log.info({ outputAssetId, destAbs }, 'pano stitch complete');

      const result: PanoStitchResult = {
        outputAssetId,
        outputPath: destAbs,
        stagesCompleted,
        alignment,
        edges,
        error: null,
        ...matcherUsed(payload),
      };
      if (payload.alignmentIn) await removePreviewDir(path.dirname(payload.alignmentIn));
      return {
        kind: 'done',
        result: result as unknown as Record<string, unknown>,
      };
    } finally {
      // Remove the temp dir created by the route for this job, stitched PNG
      // included. Never remove anything outside the job's own outputDir.
      await rm(payload.outputDir, { recursive: true, force: true }).catch((e) => {
        log.warn(
          { err: e, outputDir: payload.outputDir },
          'pano_stitch: failed to remove temp dir',
        );
      });
      await sweepStalePreviews(alignmentDir(payload));
    }
  },
};
