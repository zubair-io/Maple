/**
 * The publish marker on an import file row (#5932).
 *
 * An attempt copies a file into the library and only then records its outcome,
 * so an attempt that stops between the two leaves a file in the library that no
 * row accounts for. The marker closes that gap: before publishing an image or
 * movie the attempt writes the library-relative name it is about to land under
 * into `import_files.publishing_dest`, and it clears the marker when the group
 * ends. A later attempt that finds a marker knows the group was started, and
 * under which name to look.
 *
 * The marker is committed before the publish. The database runs with
 * `synchronous = NORMAL`, so that holds across the process dying, not across
 * power loss: there the commit can roll back and the group looks never started.
 *
 * Both writes are fenced to the attempt that holds the import, which is what
 * makes the marker trustworthy: an attempt a later one replaced cannot write a
 * marker, so it cannot publish a file the later attempt has no marker for.
 */

import type { ObjectId } from '../object-id.ts';
import { sqliteDb, type SqliteDb } from './db-handle.ts';
import { holdsImport, ImportTakenOver } from './imports.repo.ts';
import { IMPORT_PUBLISHING_DESTS_SQL, publishingDestStatement } from './imports.sql.ts';
import { toHex } from './values.ts';

async function writePublishingDest(
  id: ObjectId,
  index: number,
  destRel: string | null,
  holder: string,
  dbOverride: SqliteDb | undefined,
): Promise<void> {
  const db = sqliteDb(dbOverride);
  const hex = toHex(id);
  const statement = publishingDestStatement(hex, index, destRel, holder);
  const result = await db.write(statement.sql, statement.params);
  if (result.changes === 1) return;
  if (!(await holdsImport(db, hex, holder))) throw new ImportTakenOver();
  throw new Error(`no import_files row for import ${hex} idx ${index}`);
}

export async function markImportFilePublishing(
  id: ObjectId,
  args: { index: number; destRel: string; holder: string },
  dbOverride?: SqliteDb,
): Promise<void> {
  await writePublishingDest(id, args.index, args.destRel, args.holder, dbOverride);
}

export async function clearImportFilePublishing(
  id: ObjectId,
  args: { index: number; holder: string },
  dbOverride?: SqliteDb,
): Promise<void> {
  await writePublishingDest(id, args.index, null, args.holder, dbOverride);
}

/** Keyed by the file's `idx`. */
export async function getImportPublishingDests(
  id: ObjectId,
  dbOverride?: SqliteDb,
): Promise<Map<number, string>> {
  const rows = await sqliteDb(dbOverride).read<{ idx: number; publishing_dest: string }>(
    IMPORT_PUBLISHING_DESTS_SQL,
    [toHex(id)],
  );
  return new Map(rows.map((row) => [row.idx, row.publishing_dest]));
}
