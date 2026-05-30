/**
 * `missing_since` tagging — the one write the stage runner makes when an
 * original-file stage hits ENOENT. Extracted from run-stage.ts to keep that
 * file under the size budget.
 */

import type { Collection, ObjectId } from 'mongodb';
// Type-only import — erased at compile, so this does NOT create a runtime
// import cycle with run-stage.ts (which imports the function below).
import type { ImageDoc } from './run-stage.ts';

/**
 * Conditional, first-detection `missing_since` stamp (best-effort). The
 * `$or: [absent, null]` guard means the FIRST detection wins, so the reaper's
 * age window can't be pushed forward by repeated stage runs. Failures are
 * swallowed — a tagging hiccup must not mask the stage outcome.
 */
export async function tagMissingSince(images: Collection<ImageDoc>, id: ObjectId): Promise<void> {
  await images
    .updateOne(
      { _id: id, $or: [{ missing_since: { $exists: false } }, { missing_since: null }] },
      { $set: { missing_since: new Date().toISOString() } },
    )
    .catch(() => {});
}
