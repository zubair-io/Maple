import type { Migration, MigrationDb } from '../migrate.ts';

/** 0031 — re-arm stage rows that recorded a permanent skip (`no-resolvable-location`, or the sidecar index's `no-path`) for a library the worker had not yet loaded (#4722). */
export const rearmUnresolvedLocationSkipsMigration: Migration = {
  id: '0031-rearm-unresolved-location-skips',
  async up(db: MigrationDb): Promise<void> {
    await db.exec(`
      UPDATE stage_state
         SET version = 0, attempts = 0, processed_at = NULL, last_error = NULL, failed_at = NULL
       WHERE last_error = 'skip: no-resolvable-location'
          OR (stage = 'sidecar-metadata-index' AND last_error = 'skip: no-path')`);
  },
};
