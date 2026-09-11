/**
 * `AssetDoc.media_kind` (#3492): one-shot boot backfill + the partial index
 * that makes video/audio-scoped queries cheap.
 *
 * Why a denormalised field: `transcribe` / `video-describe` and the
 * video-scoped migrations used to select videos with a case-insensitive
 * filename regex inside `fileinfo.$elemMatch`. Measured on production (335k
 * assets), a multikey index never filters that regex at the index — every
 * such claim, count, or candidate query examined all 335k keys AND fetched
 * all 335k documents (6–7 s each, disk-bound). With `media_kind` set at every
 * creation site and this partial index over the ~15k video/audio rows, the
 * same queries are an equality on a small index.
 *
 * The backfill derives the kind from every `fileinfo` filename (`video` if
 * any location is a video — a Live Photo backup pairs a still with a `.MOV`
 * on one row) with the SAME extension sets `classifyMediaType` uses, runs once (sentinel-gated like the
 * other boot migrations in `db/migrations.ts`), and must run before any
 * stage starts — a row without `media_kind` is invisible to the media stages.
 */
import type { Db } from 'mongodb';
import { mediaKindExpression } from '../indexer/media-types.ts';

export { mediaKindExpression } from '../indexer/media-types.ts';
import { child as childLogger } from '../log.ts';

const log = childLogger('db:media-kind');

export const MEDIA_KIND_BACKFILL_ID = 'backfill-media-kind-2026-09-11' as const;
export const MEDIA_KIND_INDEX_NAME = 'media_kind_av';

/** The boot-migration sentinel (`db/migrations.ts`'s `migrationApplied` /
 * `recordMigration`), injected by `ensureIndexes` so this module does not
 * import `migrations.ts` (which imports `client.ts`, which imports this). */
export interface MigrationSentinel {
  applied(db: Db, id: typeof MEDIA_KIND_BACKFILL_ID): Promise<boolean>;
  record(db: Db, id: typeof MEDIA_KIND_BACKFILL_ID, rows: number): Promise<void>;
}

/** Backfill `media_kind` on every asset that lacks it (once), then ensure the
 * partial index. Idempotent; safe to call on every boot. */
export async function ensureMediaKind(db: Db, sentinel: MigrationSentinel): Promise<void> {
  const assets = db.collection('assets');
  if (!(await sentinel.applied(db, MEDIA_KIND_BACKFILL_ID))) {
    const res = await assets.updateMany({ media_kind: { $exists: false } }, [
      { $set: { media_kind: mediaKindExpression() } },
    ]);
    await sentinel.record(db, MEDIA_KIND_BACKFILL_ID, res.modifiedCount);
    log.info({ rows: res.modifiedCount }, 'backfilled media_kind from primary filename');
  }
  // Partial over the minority kinds only: `image` rows (the bulk of any
  // library) never enter the index, so it stays small and every video/audio
  // query — claim, count, migration candidate — is an equality lookup on it.
  await assets.createIndex(
    { media_kind: 1 },
    {
      name: MEDIA_KIND_INDEX_NAME,
      partialFilterExpression: { media_kind: { $in: ['video', 'audio'] } },
    },
  );
}
