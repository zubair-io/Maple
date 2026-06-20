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
 *     modelsDir:     string | null,
 *     ortDylibPath:  string | null,
 *   }
 *
 * The handler:
 *   1. Resolves the absolute paths for the selected assets.
 *   2. Spawns `maple-cli pano stitch <inputs...> --out <output.png>
 *      --retention <r> --local-align <l> [--strategy <s>]` via Bun.spawn.
 *   3. Streams stderr lines; parses `pano: <stage>` prefix for coarse
 *      progress (≤ 6 stages; total is set to 6 at start).
 *   4. On exit 0: upserts the output PNG as a new asset in the library.
 *   5. On non-zero exit or spawn error: fails the job with the last stderr
 *      content.
 *
 * Single-concurrent constraint: the route enforces this (409 when a
 * pano_stitch job is already running); the handler itself is stateless.
 */

import { mkdir, rename, rm, unlink } from 'node:fs/promises';
import path from 'node:path';
import { ObjectId } from 'mongodb';
import { assetsCollection } from '../../db/client.ts';
import { hashFileForId } from '../../indexer/id.ts';
import { assetAbsPath, upsertByMapleId } from '../../indexer/images.repo.ts';
import { loadLibraryRoots } from '../../indexer/libraries.cache.ts';
import { child as childLogger } from '../../log.ts';
import type { JobHandler, JobHandlerContext, JobHandlerResult } from './index.ts';

const log = childLogger('job:pano-stitch');

/** Coarse stage labels emitted by maple-cli on stderr (prefix `pano:`). */
const PANO_STAGES = ['decoding', 'keypoints', 'graph', 'refine', 'solve', 'wrote'] as const;
const TOTAL_STAGES = PANO_STAGES.length;

interface PanoStitchPayload {
  assetIds: string[];
  libraryId: string;
  outputDir: string;
  retention: 'keep' | 'strict';
  localAlign: 'mesh' | 'off';
  strategy: 'auto' | 'rotation' | 'tile' | null;
  strategySupported: boolean;
  mapleCli: string;
  modelsDir: string | null;
  ortDylibPath: string | null;
}

interface PanoStitchResult {
  outputAssetId: string | null;
  outputPath: string;
  stagesCompleted: number;
  error: string | null;
}

function parsePayload(raw: Record<string, unknown>): PanoStitchPayload {
  const ids = raw.assetIds;
  if (!Array.isArray(ids) || ids.length < 2 || ids.some((x) => typeof x !== 'string')) {
    throw new Error('pano_stitch: payload.assetIds must be string[] of length ≥ 2');
  }
  if (typeof raw.libraryId !== 'string' || raw.libraryId.length === 0) {
    throw new Error('pano_stitch: payload.libraryId must be a non-empty string');
  }
  if (typeof raw.outputDir !== 'string' || raw.outputDir.length === 0) {
    throw new Error('pano_stitch: payload.outputDir must be a non-empty string');
  }
  if (typeof raw.mapleCli !== 'string' || raw.mapleCli.length === 0) {
    throw new Error('pano_stitch: payload.mapleCli must be a non-empty string');
  }
  const retention = raw.retention === 'strict' ? 'strict' : 'keep';
  const localAlign = raw.localAlign === 'off' ? 'off' : 'mesh';
  const strategySupported = raw.strategySupported === true;
  let strategy: PanoStitchPayload['strategy'] = null;
  if (strategySupported && typeof raw.strategy === 'string') {
    const s = raw.strategy;
    if (s === 'auto' || s === 'rotation' || s === 'tile') strategy = s;
  }
  return {
    assetIds: ids as string[],
    libraryId: raw.libraryId as string,
    outputDir: raw.outputDir as string,
    retention,
    localAlign,
    strategy,
    strategySupported,
    mapleCli: raw.mapleCli as string,
    modelsDir: typeof raw.modelsDir === 'string' ? raw.modelsDir : null,
    ortDylibPath: typeof raw.ortDylibPath === 'string' ? raw.ortDylibPath : null,
  };
}

/** Parse a `pano: <stage>` line to a 1-based stage index (1..TOTAL_STAGES),
 * or 0 when the line doesn't match any known stage. */
function parseStage(line: string): number {
  if (!line.startsWith('pano:')) return 0;
  for (let i = 0; i < PANO_STAGES.length; i++) {
    if (line.includes(PANO_STAGES[i])) return i + 1;
  }
  return 0;
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
      // ── 1. Resolve asset paths ────────────────────────────────────────────
      const coll = await assetsCollection();
      const libs = await loadLibraryRoots();
      const inputPaths: string[] = [];

      const objectIds: ObjectId[] = [];
      for (const idHex of payload.assetIds) {
        if (!ObjectId.isValid(idHex)) {
          throw new Error(`pano_stitch: invalid asset id: ${idHex}`);
        }
        objectIds.push(new ObjectId(idHex));
      }

      const docs = await coll.find({ _id: { $in: objectIds } }).toArray();
      const docsById = new Map(docs.map((d) => [d._id.toHexString(), d]));

      for (const idHex of payload.assetIds) {
        const doc = docsById.get(new ObjectId(idHex).toHexString());
        if (!doc) throw new Error(`pano_stitch: asset not found: ${idHex}`);
        const p = assetAbsPath(doc, libs);
        if (!p) throw new Error(`pano_stitch: asset has no resolvable path: ${idHex}`);
        inputPaths.push(p);
      }

      // Sort by filename (capture order) as the CLI expects.
      inputPaths.sort();

      await ctx.reportProgress(0, TOTAL_STAGES);

      const outputPng = path.join(payload.outputDir, 'pano.png');

      // ── 2. Build CLI args ─────────────────────────────────────────────────
      const args: string[] = [
        'pano',
        'stitch',
        '--out',
        outputPng,
        '--retention',
        payload.retention,
        '--local-align',
        payload.localAlign,
      ];
      if (payload.strategySupported && payload.strategy) {
        args.push('--strategy', payload.strategy);
      }
      if (payload.modelsDir) {
        args.push('--models-dir', payload.modelsDir);
      }

      args.push('--', ...inputPaths);

      // ── 3. Spawn maple-cli ────────────────────────────────────────────────
      const env: Record<string, string> = {
        ...(process.env as Record<string, string>),
      };
      if (payload.modelsDir) env.MAPLE_PANO_MODELS = payload.modelsDir;
      if (payload.ortDylibPath) env.ORT_DYLIB_PATH = payload.ortDylibPath;

      log.info({ cmd: payload.mapleCli, args }, 'spawning maple-cli pano stitch');

      const proc = Bun.spawn([payload.mapleCli, ...args], {
        env,
        stdout: 'pipe',
        stderr: 'pipe',
      });

      let stagesCompleted = 0;
      const stderrLines: string[] = [];

      // Drain stderr line-by-line; parse stage progress.
      const stderrDrain = (async () => {
        const reader = proc.stderr!.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const lines = buf.split('\n');
          buf = lines.pop() ?? '';
          for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed.length > 0) stderrLines.push(trimmed);
            const stage = parseStage(trimmed);
            if (stage > stagesCompleted) {
              stagesCompleted = stage;
              await ctx.reportProgress(stagesCompleted, TOTAL_STAGES).catch(() => {});
            }
          }
        }
        if (buf.trim().length > 0) stderrLines.push(buf.trim());
      })();

      // Drain stdout to prevent backpressure; we don't use it.
      const stdoutDrain = (async () => {
        const reader = proc.stdout!.getReader();
        while (true) {
          const { done } = await reader.read();
          if (done) break;
        }
      })();

      // Poll for cancellation while the process runs.
      // Race the 3s sleep against proc.exited so the poll loop wakes promptly
      // when the process exits — instead of always sleeping a full 3s after exit.
      const cancelPoll = (async () => {
        while (true) {
          // Race: either the 3s poll interval expires OR the process exits,
          // whichever comes first. This eliminates the fixed 3s tail latency
          // that the old `await Bun.sleep(3_000)` unconditionally added after
          // process exit.
          const raceResult = await Promise.race([
            Bun.sleep(3_000).then(() => 'tick' as const),
            proc.exited.then(() => 'exited' as const).catch(() => 'exited' as const),
          ]);
          if (raceResult === 'exited') return;
          if (await ctx.shouldCancel()) {
            proc.kill('SIGTERM');
            return;
          }
        }
      })();

      // Wait for process + drains.
      const exitCode = await proc.exited;
      await Promise.all([stderrDrain, stdoutDrain, cancelPoll]);

      if (await ctx.shouldCancel()) {
        const result: PanoStitchResult = {
          outputAssetId: null,
          outputPath: outputPng,
          stagesCompleted,
          error: 'cancelled',
        };
        return {
          kind: 'cancelled',
          result: result as unknown as Record<string, unknown>,
        };
      }

      if (exitCode !== 0) {
        const lastLines = stderrLines.slice(-10).join('\n');
        const errMsg = `maple-cli exited ${exitCode}${lastLines ? `:\n${lastLines}` : ''}`;
        log.error({ exitCode, stderrLines: stderrLines.slice(-5) }, 'pano stitch failed');
        throw new Error(errMsg);
      }

      // ── 4. Import result PNG into the library ─────────────────────────────
      await ctx.reportProgress(TOTAL_STAGES, TOTAL_STAGES);

      const libId = new ObjectId(payload.libraryId);
      const libPath = libs.get(payload.libraryId);
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
      // coalesce onto this same document if it ever visits .maple/panos/
      // (the sweeper's isInsideMapleCache guard already refuses such events,
      // but if that guard ever fails the real id prevents a duplicate row).
      const fileIdentity = await hashFileForId(destAbs);

      await upsertByMapleId({
        libraryId: libId,
        relDir: '.maple/panos',
        filename: destFilename,
        size: fileIdentity.size,
        mtime: fileIdentity.mtime,
        mapleId: fileIdentity.maple_id,
        sha1Head: fileIdentity.sha1_head,
      });

      // Re-query to get the inserted _id for the result payload.
      const inserted = await coll.findOne({ maple_id: fileIdentity.maple_id });
      const outputAssetId = inserted?._id?.toHexString() ?? null;

      log.info({ outputAssetId, destAbs }, 'pano stitch complete');

      const result: PanoStitchResult = {
        outputAssetId,
        outputPath: destAbs,
        stagesCompleted,
        error: null,
      };
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
    }
  },
};
