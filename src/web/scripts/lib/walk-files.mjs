// walk-files.mjs — shared recursive directory walker for the small
// `scripts/*.mjs` CI check scripts (check-hosted-capability-boundary.mjs,
// check-maple-ui-adoption.mjs — #3020 dedup). Each script filters to its own
// file set via `predicate`.

import { readdir } from 'node:fs/promises';
import { resolve } from 'node:path';

/** Recursively lists every file under `directory` whose absolute path
 * satisfies `predicate`. */
export async function walkFiles(directory, predicate) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) return walkFiles(path, predicate);
      return predicate(path) ? [path] : [];
    }),
  );
  return files.flat();
}
