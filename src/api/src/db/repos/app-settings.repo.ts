/**
 * `app_settings` — the SQLite port of the one collection every operator-facing
 * settings page writes to (#3751).
 *
 * ## What this replaces
 *
 * Twenty-odd modules named `*-config.repo.ts` each own one document in
 * `app_settings` and each performs exactly the same two operations on it:
 * `findOne({ _id })` and `updateOne({ _id }, { $set }, { upsert: true })`.
 * `workers/migration-config.repo.ts` adds a third, `$unset`, to prune the
 * state of migrations that no longer exist. That is the entire surface, and it
 * is why this is one module rather than twenty: the collection has one access
 * pattern, and the per-domain modules differ only in the shape they parse out
 * of the document and the defaults they fall back to — neither of which is
 * storage's business.
 *
 * At the cutover (#3752) each of those modules swaps its two `getDb()` calls
 * for {@link readAppSettings} and {@link patchAppSettings}; the clamping,
 * validation and env fallbacks around them are untouched.
 *
 * ## Why the patch is atomic and the obvious implementation is not
 *
 * The tempting port of a partial `$set` is read the row, merge in TypeScript,
 * write it back. That loses an update whenever two settings pages save at the
 * same moment, which the Mongo version could not do — `$set` on a document
 * only touches the named paths.
 *
 * `json_set` keeps that property. One statement reads the stored document,
 * overwrites just the named paths, and writes the result, inside SQLite's own
 * statement atomicity, so a concurrent write to a different key survives. It
 * also creates missing intermediate objects, which is what makes a dotted Mongo
 * path like `migrations.refile-backups.enabled` port unchanged.
 */

import { sqliteDb, type SqliteDb } from './db-handle.ts';
import { parseJson } from './values.ts';

export type { SqliteDb } from './db-handle.ts';

/**
 * Anything that survives a JSON round trip, which is everything these
 * documents hold: flags, thresholds, URLs, model names, and the
 * migration row's nested per-migration state.
 *
 * The composite branch is `object` rather than a recursive index signature
 * because several settings documents store an `interface`-typed payload whole —
 * the describe-server list and AI-connection block on the `enrichment` row, the
 * `change-log-gc` run summary, the `managed_https` config — and TypeScript only
 * grants an implicit index signature to a *type alias*, so a structurally
 * JSON-shaped interface is rejected by `{ [key: string]: SettingsValue }`.
 * Spelling it `object` is what lets those call sites hand their own declared
 * type over unchanged instead of casting at the boundary. Nothing is lost at
 * runtime: every value is `JSON.stringify`d on the way in either way.
 */
export type SettingsValue = string | number | boolean | null | object;

/**
 * A `$set` payload: field path → new value. A path may be dotted
 * (`'migrations.refile-backups.enabled'`), exactly as the Mongo call sites
 * spell it.
 */
export type SettingsPatch = Readonly<Record<string, SettingsValue | undefined>>;

const SELECT_SQL = `SELECT doc FROM app_settings WHERE id = ?`;

/**
 * A dotted Mongo field path as a SQLite JSON path.
 *
 * Each segment is quoted, so a settings key containing a space or a dash — and
 * every migration id is kebab-case — addresses the field it names rather than
 * tripping the path parser.
 *
 * Inside those quotes SQLite reads the segment as a JSON string, so `"` and `\`
 * are escaped the way JSON escapes them, with a backslash. Doubling the quote
 * instead — the SQL convention, and the wrong one here — does not produce a
 * differently-targeted write but a hard `bad JSON path` error, which would make
 * such a key unwritable rather than mis-written. No key in the codebase
 * contains either character, so this is defence rather than a fix for a live
 * call site.
 */
function jsonPath(dotted: string): string {
  const segments = dotted
    .split('.')
    .map((segment) => `"${segment.replace(/[\\"]/g, (char) => `\\${char}`)}"`);
  return `$.${segments.join('.')}`;
}

/**
 * The settings document with this id, or `null` when nothing has written one.
 *
 * `_id` is present on the result because the Mongo documents carried it and
 * the per-domain `*Doc` interfaces declare it; a caller that ignores it —
 * which is all of them — is unaffected.
 */
export async function readAppSettings<T extends object>(
  id: string,
  dbOverride?: SqliteDb,
): Promise<(T & { _id: string }) | null> {
  const rows = await sqliteDb(dbOverride).read<{ doc: string }>(SELECT_SQL, [id]);
  const doc = rows[0]?.doc;
  if (doc === undefined) return null;
  return { ...parseJson<T>(doc, {} as T), _id: id };
}

/**
 * Apply a partial update, creating the document when it does not exist yet.
 *
 * Mirrors `updateOne({ _id }, { $set: patch }, { upsert: true })`, including
 * the detail that a patch with no fields is a no-op rather than an insert of
 * an empty document — `updateOne` with an empty `$set` is rejected by the
 * driver, so no call site produces one and nothing should start now.
 *
 * `undefined` values are dropped rather than stored, matching the way every
 * caller builds its `set` object by spreading optional fields.
 */
export async function patchAppSettings(
  id: string,
  patch: SettingsPatch,
  dbOverride?: SqliteDb,
): Promise<void> {
  const fields = Object.entries(patch).filter(([, value]) => value !== undefined);
  if (fields.length === 0) return;

  // json_set takes (path, value) pairs, so each field contributes two bound
  // parameters, and the statement binds them once for the insert branch and
  // once for the conflict branch.
  const assignments = fields.map(() => `?, json(?)`).join(', ');
  const pairs = fields.flatMap(([path, value]) => [jsonPath(path), JSON.stringify(value)]);

  await sqliteDb(dbOverride).write(
    `INSERT INTO app_settings (id, doc) VALUES (?, json_set('{}', ${assignments}))
     ON CONFLICT (id) DO UPDATE SET doc = json_set(doc, ${assignments})`,
    [id, ...pairs, ...pairs],
  );
}

/**
 * Remove fields from an existing document. Mirrors `$unset`, down to doing
 * nothing when the document does not exist.
 *
 * Used by the migration settings row to drop the state of migrations that are
 * no longer registered, so a retired migration's stale `enabled: true` cannot
 * come back to life if its id is ever reused.
 */
export async function unsetAppSettings(
  id: string,
  paths: readonly string[],
  dbOverride?: SqliteDb,
): Promise<void> {
  if (paths.length === 0) return;
  const args = paths.map(() => '?').join(', ');
  await sqliteDb(dbOverride).write(
    `UPDATE app_settings SET doc = json_remove(doc, ${args}) WHERE id = ?`,
    [...paths.map(jsonPath), id],
  );
}

/**
 * Delete a settings document outright. Not used by a route — it is what a test
 * needs to get back to "no operator has touched this yet", which on Mongo was
 * `deleteMany({})` on the collection.
 */
export async function deleteAppSettings(id: string, dbOverride?: SqliteDb): Promise<void> {
  await sqliteDb(dbOverride).write(`DELETE FROM app_settings WHERE id = ?`, [id]);
}
