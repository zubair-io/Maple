/**
 * `pano_preview` job handler (#4580): a quick ~2048 px panorama preview plus
 * the solved alignment a follow-up `pano_stitch` starts from, so the full
 * stitch does not repeat feature matching.
 *
 * Payload: the `pano_stitch` payload (see `pano-stitch.ts`), with `outputDir`
 * a directory from `pano/pano-previews.ts` and `alignmentIn` an earlier
 * preview's alignment — a re-preview after an option change that leaves the
 * geometry key alone (retention, local alignment) skips matching too.
 *
 * Spawns `maple-cli pano stitch --preview-out … --alignment-out … --report …`
 * and, on success, keeps the directory for `GET /api/pano/jobs/:id/preview`
 * and the stitch; a failed or cancelled preview removes it.
 */

import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { child as childLogger } from '../../log.ts';
import { PREVIEW_FILES, removePreviewDir, sweepStalePreviews } from '../../pano/pano-previews.ts';
import type { JobHandler, JobHandlerResult } from './index.ts';
import {
  cliFailure,
  panoOptionArgs,
  PROGRESS_TOTAL,
  reportPath,
  resolveInputPaths,
  runPanoCli,
} from './pano-cli-process.ts';
import { parsePayload, readAlignmentVerdict, type PanoAlignmentVerdict } from './pano-stitch.ts';

const log = childLogger('job:pano-preview');

interface PanoPreviewResult {
  alignment: PanoAlignmentVerdict | null;
  width: number | null;
  height: number | null;
  seconds: number | null;
}

interface PreviewReport {
  width?: number;
  height?: number;
  timings_s?: { total?: number };
}

async function readPreviewReport(outputDir: string): Promise<PreviewReport> {
  return Bun.file(reportPath(outputDir))
    .json()
    .then((r) => r as PreviewReport)
    .catch(() => ({}));
}

const cancelled = (): JobHandlerResult => ({
  kind: 'cancelled',
  result: { alignment: null, width: null, height: null, seconds: null },
});

export const panoPreviewHandler: JobHandler = {
  async run(rawPayload, ctx) {
    const payload = parsePayload(rawPayload);
    await sweepStalePreviews();
    // A superseded preview is cancelled while still queued; skip it outright.
    if (await ctx.shouldCancel()) {
      await removePreviewDir(payload.outputDir);
      return cancelled();
    }
    try {
      const inputPaths = await resolveInputPaths(payload.assetIds);
      await mkdir(payload.outputDir, { recursive: true });
      await ctx.reportProgress(0, PROGRESS_TOTAL);
      const args = [
        'pano',
        'stitch',
        '--preview-out',
        path.join(payload.outputDir, PREVIEW_FILES.image),
        '--alignment-out',
        path.join(payload.outputDir, PREVIEW_FILES.alignment),
        '--report',
        reportPath(payload.outputDir),
        ...panoOptionArgs(payload),
        ...(payload.alignmentIn ? ['--alignment-in', payload.alignmentIn] : []),
        '--',
        ...inputPaths,
      ];
      log.info({ cmd: payload.mapleCli, args }, 'spawning maple-cli pano preview');
      const run = await runPanoCli(payload, args, ctx);
      if (run.cancelled) {
        await removePreviewDir(payload.outputDir);
        return cancelled();
      }
      if (run.exitCode !== 0) throw cliFailure(run);

      await ctx.reportProgress(PROGRESS_TOTAL, PROGRESS_TOTAL);
      const [alignment, report] = await Promise.all([
        readAlignmentVerdict(payload.outputDir),
        readPreviewReport(payload.outputDir),
      ]);
      const result: PanoPreviewResult = {
        alignment,
        width: report.width ?? null,
        height: report.height ?? null,
        seconds: report.timings_s?.total ?? null,
      };
      log.info({ jobId: ctx.jobId.toHexString(), ...result }, 'pano preview complete');
      return { kind: 'done', result: { ...result } };
    } catch (err) {
      await removePreviewDir(payload.outputDir);
      throw err;
    }
  },
};
