/**
 * `damaged` tagging — the write a file-reading stage makes when an original is
 * unreadable (corrupt/truncated bytes, or a format no decoder can parse). The
 * runner calls it down two paths: when a stage exhausts its retries, and when a
 * stage classifies the bytes as unreadable up front via a `{ damaged }` result
 * (e.g. a 0-byte file). Extracted from run-stage.ts to keep that file under the
 * size budget, mirroring `tag-missing.ts`.
 *
 * Observability: every tag emits a structured `asset.damaged` log record. The
 * backend's pino logger is bridged into OpenTelemetry by `otel.ts`
 * (`PinoInstrumentation`), so when SigNoz export is enabled this record ships
 * to SigNoz automatically — no separate emitter. The fields are flat + stable
 * so an operator can pivot on `event` / `stage` in SigNoz's log explorer.
 */

import type { Collection, ObjectId } from 'mongodb';
// Type-only import — erased at compile, so this does NOT create a runtime
// import cycle with run-stage.ts (which imports the function below).
import type { ImageDoc } from './run-stage.ts';
import { child as childLogger } from '../log.ts';

const log = childLogger('workers:damaged');

/** Cap the stored (and logged) error so a verbose decoder dump can't bloat the
 * asset row or the log record. */
const MAX_REASON_LEN = 500;

/**
 * Conditional, first-detection `damaged` stamp (best-effort). The
 * `$or: [absent, null]` guard means the FIRST detection wins, so `since`
 * records when the file first became unprocessable and repeated stage runs
 * (or a second file-reading stage hitting the same corrupt bytes) can't push
 * it forward. Failures are swallowed — a tagging hiccup must not mask the
 * stage outcome — but the `asset.damaged` log is emitted regardless so the
 * event still reaches SigNoz.
 */
export async function tagDamaged(
  images: Collection<ImageDoc>,
  id: ObjectId,
  stage: string,
  reason: string,
): Promise<void> {
  const trimmed = reason.length > MAX_REASON_LEN ? `${reason.slice(0, MAX_REASON_LEN)}…` : reason;
  // Neutral wording on purpose: this is called both when a stage exhausts its
  // retries and when a stage classifies the bytes as unreadable up front (the
  // `{ damaged }` fast-path). The `reason` field carries what actually went
  // wrong, so the message must not assert "exhausted retries" for either case.
  log.warn(
    {
      event: 'asset.damaged',
      asset_id: id.toHexString(),
      stage,
      reason: trimmed,
    },
    `asset ${id.toHexString()} tagged damaged by ${stage}: ${trimmed}`,
  );
  await images
    .updateOne(
      { _id: id, $or: [{ damaged: { $exists: false } }, { damaged: null }] },
      {
        $set: {
          damaged: { since: new Date().toISOString(), stage, reason: trimmed },
        },
      },
    )
    .catch(() => {});
}
