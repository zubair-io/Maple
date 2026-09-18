/**
 * The ordered migration list for the SQLite backend.
 *
 * Append only. An id that has shipped is frozen — live databases carry it in
 * `schema_migrations`, and `assertMigrationOrder` refuses a list whose ids are
 * not in ascending order, so a new migration goes at the bottom with a higher
 * number and never in the middle.
 *
 * Nothing in this epic had shipped while it was being built, so there is
 * exactly one migration: every correction the port slices found went into the
 * initial schema rather than into a rebuild on top of it. A database that
 * records `0001-initial-schema` never re-runs it, so the freeze starts at the
 * cutover (#3752) and not before.
 */

import type { Migration } from '../migrate.ts';
import { initialSchemaMigration } from './0001-initial-schema.ts';

export const ALL_MIGRATIONS: readonly Migration[] = [initialSchemaMigration];
