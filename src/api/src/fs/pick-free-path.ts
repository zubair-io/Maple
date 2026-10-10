import * as fs from './mirrored.ts';
import * as path from 'node:path';
import { child as childLogger } from '../log.ts';

const log = childLogger('fs/relocate');

/** Append `.N.<ext>` until the path is free. Bounded to 1000 attempts.
 *
 * Pass `caller` so the warn log identifies which code path triggered the
 * collision (e.g. `'moveToTrash'`, `'moveToDuplicates'`, `'migration:primary'`).
 * A collision means the destination already held a file with that name — the
 * returned suffixed path is what actually ends up on disk and in the DB, which
 * is how `_MG_4226.1.ARW`-style names are created.
 *
 * Throws after exhausting all candidates rather than returning the last
 * (occupied) one — the prior behaviour would have let the subsequent
 * `fs.rename` overwrite an existing file, causing data loss.
 *
 * Extensionless-input edge case: `path.extname("/x/foo")` returns `""`, and
 * `basePath.slice(0, -0)` is `""` — naively building `${stem}.${n}${ext}`
 * would produce `.1` (a root-level dotfile), losing the basename entirely.
 * Guard the slice on a non-empty ext so an extensionless input simply gets
 * the suffix appended (`/x/foo` → `/x/foo.1`). */
export async function pickFreePath(basePath: string, caller?: string): Promise<string> {
  try {
    await fs.stat(basePath);
  } catch {
    return basePath; // path is free — no collision, no log
  }
  const ext = path.extname(basePath);
  const stem = ext ? basePath.slice(0, -ext.length) : basePath;
  for (let n = 1; n <= 1000; n++) {
    const candidate = `${stem}.${n}${ext}`;
    try {
      await fs.stat(candidate);
    } catch {
      log.warn(
        { caller: caller ?? 'unknown', collision: basePath, chosen: candidate },
        'pickFreePath: destination occupied — suffixed path chosen (this creates a .N. filename)',
      );
      return candidate;
    }
  }
  throw new Error(`pickFreePath: collision — exceeded 1000 candidate paths for ${basePath}`);
}
