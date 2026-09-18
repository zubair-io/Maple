/**
 * The destination file, and the one question `--restart` has to ask before it
 * deletes anything.
 */

import { Database } from 'bun:sqlite';
import { existsSync, statSync, unlinkSync } from 'node:fs';

/**
 * Deletes a previous run's destination, and refuses to delete anything else.
 *
 * `--restart` is the flag an operator reaches for when they want to redo the
 * migration, and after a successful cutover the LIVE database is at exactly
 * the path they would type. Deleting that takes everything the server has
 * written since, with no prompt. So the file has to identify itself first: a
 * database this importer produced carries `import_checkpoint`,
 * `import_rejects` and `import_meta` beside the library, and a file that
 * carries none of them is either live — the bookkeeping is documented as safe
 * to drop after a cutover — or not ours at all. Either way it is not this
 * command's to remove.
 *
 * The `-wal` and `-shm` siblings go with it. A journal left beside a deleted
 * database is at best confusing and at worst replayed into the new one.
 */
export function discardDestination(path: string): void {
  if (!existsSync(path)) return;
  if (statSync(path).size > 0 && !isImporterDatabase(path)) {
    throw new Error(
      `--restart will not delete ${path}: it holds none of the importer's bookkeeping tables, ` +
        'so it is either a live database or a file this importer did not produce. Move it aside ' +
        'yourself if you really mean to replace it.',
    );
  }
  for (const suffix of ['', '-wal', '-shm']) {
    const sibling = `${path}${suffix}`;
    if (existsSync(sibling)) unlinkSync(sibling);
  }
}

/** True when the file at `path` is a SQLite database with importer bookkeeping. */
function isImporterDatabase(path: string): boolean {
  try {
    const db = new Database(path, { readonly: true });
    try {
      const row = db
        .query(
          `SELECT COUNT(*) AS n FROM sqlite_master
            WHERE type = 'table'
              AND name IN ('import_checkpoint', 'import_rejects', 'import_meta')`,
        )
        .get() as { n: number };
      return row.n > 0;
    } finally {
      db.close();
    }
  } catch {
    // Not a SQLite file at all, or unreadable. Either way, not ours to delete.
    return false;
  }
}
