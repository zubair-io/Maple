/**
 * `stage_handlers` — the SQLite port of per-stage handler routing (#3751).
 *
 * One row per stage whose implementation has been overridden; today only `ai`
 * is honoured by the pipeline. The table has exactly one live reader —
 * `handler-registry/registry.ts`, which loads every enabled row once and
 * caches the result in process — and no writer anywhere in the repository:
 * rows are planted by hand. So the ported surface is one function, and adding
 * an insert or an update here would be inventing a surface the application
 * does not have.
 *
 * The registry treats a database it cannot reach as "no overrides" and carries
 * on with its builtins, so this function stays a plain read and lets the
 * caller keep its own catch.
 *
 * MongoDB is still the live database; nothing imports this module yet. The
 * cutover (#3752) swaps the import path.
 */

import { sqliteDb, type SqliteDb } from './db-handle.ts';
import { toBool } from './values.ts';
import type { StageHandlerDoc } from '../../schema.ts';

export type { SqliteDb } from './db-handle.ts';
export type { StageHandlerDoc };

interface StageHandlerRow {
  stage: string;
  impl: 'builtin' | 'http';
  url: string | null;
  timeout_ms: number | null;
  enabled: number;
}

/**
 * A row as the document it replaces. A NULL column becomes an absent key
 * rather than a `null` value, which is what the registry's projection tests
 * for (`typeof doc.url === 'string'`, `typeof doc.timeout_ms === 'number'`).
 */
function toDoc(row: StageHandlerRow): StageHandlerDoc {
  return {
    stage: row.stage,
    impl: row.impl,
    ...(row.url === null ? {} : { url: row.url }),
    ...(row.timeout_ms === null ? {} : { timeout_ms: row.timeout_ms }),
    enabled: toBool(row.enabled),
  };
}

/**
 * Every enabled handler override. A disabled row is treated as if it did not
 * exist, so it is filtered here rather than handed to the caller to skip.
 */
export async function listEnabledStageHandlers(dbOverride?: SqliteDb): Promise<StageHandlerDoc[]> {
  const rows = await sqliteDb(dbOverride).read<StageHandlerRow>(
    `SELECT stage, impl, url, timeout_ms, enabled FROM stage_handlers WHERE enabled = 1`,
  );
  return rows.map(toDoc);
}
