/**
 * The ordered migration list for the SQLite backend.
 *
 * Append only. An id that has shipped is frozen — live databases carry it in
 * `schema_migrations`, and `assertMigrationOrder` refuses a list whose ids are
 * not in ascending order, so a new migration goes at the bottom with a higher
 * number and never in the middle.
 */

import type { Migration } from '../migrate.ts';
import { initialSchemaMigration } from './0001-initial-schema.ts';
import { assetChangesNoForeignKeysMigration } from './0002-asset-changes-no-foreign-keys.ts';

export const ALL_MIGRATIONS: readonly Migration[] = [
  initialSchemaMigration,
  assetChangesNoForeignKeysMigration,
];
