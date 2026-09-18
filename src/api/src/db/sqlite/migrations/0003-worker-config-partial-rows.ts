/**
 * 0003 — `worker_config` rows are partial, and `discover` keeps a knob in one.
 *
 * The initial schema modelled this table from `WorkerConfig`, whose four
 * scalar fields are non-optional in TypeScript. The stored document is not
 * that shape: `WorkerConfigRepo.patch` upserts a partial, so the very first
 * write for a worker can create a row holding nothing but a name and a
 * `paused` flag, and the `discover` row never holds the stage fields at all.
 * `NOT NULL` columns reject both. The rebuild relaxes them and adds the one
 * column the discover worker needs; `WORKER_CONFIG_REBUILD_DDL` in
 * `../ddl/operations.ts` carries the full argument.
 *
 * A new file rather than an edit to `0001`, because a shipped migration id is
 * frozen: a database that already recorded `0001-initial-schema` would never
 * re-run it, so the edit would reach new installs only and the two would
 * diverge with no error anywhere.
 */

import { WORKER_CONFIG_REBUILD_DDL } from '../ddl/operations.ts';
import type { Migration, MigrationDb } from '../migrate.ts';

export const workerConfigPartialRowsMigration: Migration = {
  id: '0003-worker-config-partial-rows',
  async up(db: MigrationDb): Promise<void> {
    await db.exec(WORKER_CONFIG_REBUILD_DDL);
  },
};
