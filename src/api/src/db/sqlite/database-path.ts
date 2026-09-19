/**
 * Where the library database lives.
 *
 * An environment variable rather than a DB-backed setting, and one of the few
 * cases where that is the right answer rather than the lazy one: this is the
 * path to the database the settings themselves are stored in, so it has to be
 * known before anything is readable.
 *
 * The default sits beside the repository's other runtime state rather than in
 * a system directory, so a developer who sets nothing gets a working server and
 * an operator who sets it gets exactly the file they named.
 *
 * Deliberately a module of its own with no imports. Four process roles need
 * this string — the API, the worker child, the discover worker and a decode
 * child resolving a lens profile — and the last of those is a short-lived
 * process that should not load the schema, the migration runner or anything
 * else just to learn a path.
 */

const DEFAULT_SQLITE_PATH = './data/maple.sqlite';

export function sqliteDatabasePath(): string {
  return process.env.MAPLE_SQLITE_PATH ?? DEFAULT_SQLITE_PATH;
}
