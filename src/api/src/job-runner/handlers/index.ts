/**
 * Handler registry. Each `JobKind` maps to one handler; the runner looks
 * up the handler by kind on each claim and delegates the work. Handlers
 * are intentionally narrow: they own per-job state, observe cancellation,
 * and return a typed result.
 *
 * To add a new kind:
 *   1. Extend the `JobKind` union in `db/schema.ts`.
 *   2. Add a handler under this directory and register it in `HANDLERS`.
 *   3. Make sure `JobHandler.run` reports progress periodically and
 *      consults `ctx.shouldCancel()` between steps.
 */

import type { ObjectId } from 'mongodb';
import type { JobKind } from '../../db/schema.ts';
import { batchJpegExportHandler } from './batch-jpeg-export.ts';
import { panoStitchHandler } from './pano-stitch.ts';

/** Per-step context passed to handlers by the runner. */
export interface JobHandlerContext {
  /** Persistent job id; used by handlers if they need to write progress
   * via the repo directly (most go through `reportProgress`). */
  jobId: ObjectId;
  /** Notify the runner of progress. Total may be set on the first call
   * and held constant thereafter. */
  reportProgress: (current: number, total: number) => Promise<void>;
  /** Returns true once a cancellation has been requested. Handlers MUST
   * consult this between iterations and exit cleanly when it flips. */
  shouldCancel: () => Promise<boolean>;
}

export interface JobHandler {
  run(payload: Record<string, unknown>, ctx: JobHandlerContext): Promise<JobHandlerResult>;
}

/** What a handler returns. `cancelled` lets the runner mark the doc
 * `cancelled` rather than `done`; the result is still recorded in
 * either case so the API caller can see partial counts. */
export type JobHandlerResult =
  | { kind: 'done'; result: Record<string, unknown> }
  | { kind: 'cancelled'; result: Record<string, unknown> };

/** Registry. Add a new kind by extending the union in `db/schema.ts`
 * and assigning a handler here. */
export const HANDLERS: Record<JobKind, JobHandler> = {
  batch_jpeg_export: batchJpegExportHandler,
  pano_stitch: panoStitchHandler,
};
