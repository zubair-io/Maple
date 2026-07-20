/**
 * The migration registry — every named one-shot migration the `migration`
 * worker knows how to run. Add a new entry here to ship another migration; the
 * worker, routes, status surface, and settings UI pick it up generically.
 */
import type { Migration } from './types.ts';
import { refileBackups } from './refile-backups.ts';
import { scrubMirrorOrphans } from './scrub-mirror-orphans.ts';
import { backfillLiveLocationCount } from './backfill-live-location-count.ts';
import { backfillVideoExif } from './backfill-video-exif.ts';
import { auditVideoGeoBackfill } from './audit-video-geo-backfill.ts';
import { applyVideoGeoBackfill } from './apply-video-geo-backfill.ts';
import { rearmVideoPosters } from './rearm-video-posters.ts';

export const MIGRATIONS: readonly Migration[] = [
  refileBackups,
  scrubMirrorOrphans,
  backfillLiveLocationCount,
  backfillVideoExif,
  auditVideoGeoBackfill,
  applyVideoGeoBackfill,
  rearmVideoPosters,
];

export function getMigration(id: string): Migration | undefined {
  return MIGRATIONS.find((m) => m.id === id);
}

export type { Migration, MigrationBatchResult } from './types.ts';
