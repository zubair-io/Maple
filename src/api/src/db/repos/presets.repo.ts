/**
 * `presets` — the SQLite port of the named-adjustment store (#3751).
 *
 * A preset is a sparse bag of canonical adjustment keys a person saved under a
 * name. Three operations, all spelled inline in `routes/presets.ts` today:
 * list them alphabetically, create one, delete one.
 *
 * ## Two columns stay JSON, deliberately
 *
 * `fields` is a sparse map of adjustment keys to scalars, and `extra` exists
 * precisely to hold top-level keys this server version does not understand so
 * a newer client round-trips its own data — the same passthrough philosophy
 * the XMP writer follows. Columns would destroy the one property `extra` is
 * for, and nothing ever filters into either.
 *
 * ## The alphabetical order is case-insensitive, and so is the uniqueness
 *
 * The Mongo list applied `collation({ locale: 'en', strength: 2 })` so
 * "Bright" and "bright" sort together, and the unique index used the same
 * collation so they cannot both exist. `COLLATE NOCASE` is SQLite's version of
 * both: the schema's `presets_name_unique` index carries it, and the `ORDER
 * BY` below asks for it explicitly, because a collation on an index does not
 * change how an unrelated `ORDER BY` compares.
 *
 * NOCASE folds ASCII only, where ICU strength 2 folds accents too. In practice
 * a preset name is what someone typed on their own keyboard, and the practical
 * difference is that "Café" and "CAFÉ" are now two presets rather than a
 * conflict — a strictly more permissive outcome, and never a lost one.
 */

import type { ObjectId, WithId } from '../object-id.ts';
import { newObjectIdHex } from '../object-id.ts';
import { deleteOutcome, sqliteDb, type DeleteOutcome, type SqliteDb } from './db-handle.ts';
import { parseJson, toHex, toObjectId } from './values.ts';
import type { PresetDoc } from '../schema.ts';

export type { SqliteDb } from './db-handle.ts';

interface PresetRow {
  id: string;
  name: string;
  schema_version: number;
  fields: string;
  extra: string | null;
  created_at: string;
  updated_at: string;
}

function toPreset(row: PresetRow): WithId<PresetDoc> {
  const extra = parseJson<Record<string, unknown> | null>(row.extra, null);
  return {
    _id: toObjectId(row.id),
    name: row.name,
    schema_version: row.schema_version,
    fields: parseJson<PresetDoc['fields']>(row.fields, {}),
    // Absent rather than null when there was nothing to preserve, matching the
    // optional field the create path writes.
    ...(extra === null ? {} : { extra }),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/** Every preset, ordered by name the way a person reads a list. */
export async function listPresets(dbOverride?: SqliteDb): Promise<WithId<PresetDoc>[]> {
  const rows = await sqliteDb(dbOverride).read<PresetRow>(
    `SELECT id, name, schema_version, fields, extra, created_at, updated_at
       FROM presets ORDER BY name COLLATE NOCASE ASC`,
  );
  return rows.map(toPreset);
}

/**
 * Save a preset and return its new id.
 *
 * Throws when the name is taken, case-insensitively — see
 * {@link isPresetNameConflict}, which is what the route turns into a 409.
 */
export async function insertPreset(doc: PresetDoc, dbOverride?: SqliteDb): Promise<ObjectId> {
  const id = newObjectIdHex();
  await sqliteDb(dbOverride).write(
    `INSERT INTO presets (id, name, schema_version, fields, extra, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      doc.name,
      doc.schema_version,
      JSON.stringify(doc.fields),
      doc.extra === undefined ? null : JSON.stringify(doc.extra),
      doc.created_at,
      doc.updated_at,
    ],
  );
  return toObjectId(id);
}

/**
 * Whether a failed insert failed because that name is already taken.
 *
 * Replaces the route's `/E11000/` test on the error message. Naming the index
 * keeps some future constraint on this table from being reported to the person
 * as a duplicate name.
 */
export function isPresetNameConflict(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /UNIQUE constraint failed:\s*presets\.name/i.test(message);
}

/** Delete a preset. `deletedCount` of 0 is the route's 404. */
export async function deletePreset(id: ObjectId, dbOverride?: SqliteDb): Promise<DeleteOutcome> {
  const result = await sqliteDb(dbOverride).write(`DELETE FROM presets WHERE id = ?`, [toHex(id)]);
  return deleteOutcome(result.changes);
}
