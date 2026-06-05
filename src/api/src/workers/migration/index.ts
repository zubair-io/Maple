/**
 * The migration registry — every named one-shot migration the `migration`
 * worker knows how to run. Add a new entry here to ship another migration; the
 * worker, routes, status surface, and settings UI pick it up generically.
 */
import type { Migration } from './types.ts';
import { restructureBackupFolders } from './restructure-backup-folders.ts';
import { restructureBackupGeo } from './restructure-backup-geo.ts';

export const MIGRATIONS: readonly Migration[] = [restructureBackupFolders, restructureBackupGeo];

export function getMigration(id: string): Migration | undefined {
  return MIGRATIONS.find((m) => m.id === id);
}

export type { Migration, MigrationBatchResult } from './types.ts';
