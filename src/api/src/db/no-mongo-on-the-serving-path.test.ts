/**
 * The cutover's exit criterion, as a test (#3787).
 *
 * After the boot migration finishes, nothing in the running server may read or
 * write MongoDB. That is a property of the import graph, so it is checkable
 * without booting anything, and checking it here is what keeps it true: a
 * single route that goes on calling `assetsCollection()` does not degrade the
 * build, it forks it — both stores hold a complete library after the migration,
 * so they diverge from the first write and every later read is a coin toss
 * about which reality it sees. There is no partial state worth shipping, which
 * is why this is one test with no allowance for "mostly".
 *
 * Three things are deliberately still permitted, and each is permitted for a
 * reason rather than as a concession:
 *
 * 1. **The boot migration.** Reading MongoDB is its entire job. It opens its
 *    own `MongoClient` under `db/sqlite/import/` rather than going through
 *    `db/client.ts`, so it does not need an exemption from the first rule at
 *    all — only from the second.
 *
 * 2. **`ObjectId`.** Ids on the wire are 24-character hex strings and clients
 *    hold them; the type travels with them. It is an identifier concern, not a
 *    query, and 68 modules import it purely to parse or mint one.
 *
 * 3. **Tests.** Some still drive MongoDB directly — the boot migration's own
 *    suite has to. `bun test` is expected to pass with no mongod running, and
 *    those suites skip when they cannot reach one.
 *
 * `db/client.ts` itself is what this is really about. After the cutover it has
 * no production consumer at all: everything that used to call it now calls a
 * repository, and the importer never used it. So the rule is the simple one —
 * outside tests, nothing imports it. It stays in the tree because reverting
 * this merge has to put the service back on MongoDB (#3752); deleting it is
 * #3785.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { Glob } from 'bun';

/** Every import statement in a file, with whether it was `import type`. */
const IMPORT_RE = /^[ \t]*import[ \t]+(type[ \t]+)?([\s\S]*?)[ \t]+from[ \t]*['"]([^'"]+)['"]/gm;

interface ImportSite {
  readonly file: string;
  readonly specifier: string;
  readonly typeOnly: boolean;
  readonly names: readonly string[];
}

/**
 * The value bindings an import clause introduces.
 *
 * `import type { Db }` is dropped by the `typeOnly` flag; an inline
 * `{ type Db, ObjectId }` is filtered per name here. Neither survives to
 * runtime, so neither can reach a database.
 */
function valueBindings(clause: string): string[] {
  return clause
    .replace(/[{}]/g, '')
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0 && !part.startsWith('type '))
    .map((part) => part.split(/\s+as\s+/)[0]!.trim());
}

function importsOf(file: string): ImportSite[] {
  const source = readFileSync(file, 'utf8');
  return [...source.matchAll(IMPORT_RE)].map((match) => ({
    file,
    specifier: match[3]!,
    typeOnly: Boolean(match[1]),
    names: valueBindings(match[2]!),
  }));
}

/** Non-test modules — the code that actually runs in the server. */
function servingModules(): string[] {
  return [...new Glob('src/**/*.ts').scanSync('.')]
    .filter((file) => !file.endsWith('.test.ts'))
    .filter((file) => !file.endsWith('.test-helpers.ts'))
    .filter((file) => !file.includes('/test-support/'))
    .filter((file) => !file.includes('/__fixtures__/'))
    .sort();
}

/**
 * Where the boot migration lives. Everything under it may reach MongoDB,
 * because filling SQLite from MongoDB is what it does.
 */
const IMPORTER_PREFIX = 'src/db/sqlite/import/';

/**
 * Identifier types that travel on the wire and are not a query.
 *
 * `ObjectId` is the whole list on purpose. Anything else imported as a value
 * from the driver — a client, a collection type used as a constructor, an
 * error class matched on — is a module talking to MongoDB.
 */
const IDENTIFIER_ONLY = new Set(['ObjectId']);

describe('#3787 — the serving path does not reach MongoDB', () => {
  test('nothing outside tests imports db/client.ts', () => {
    const offenders = servingModules()
      .filter((file) => file !== 'src/db/client.ts')
      .flatMap(importsOf)
      .filter((site) => /(^|\/)client\.ts$/.test(site.specifier) && site.specifier.includes('/'))
      .filter((site) => site.specifier.includes('db/client.ts'))
      .filter((site) => site.names.length > 0 || !site.typeOnly)
      .map((site) => site.file);

    // Named rather than counted: when this fails, the list is the work left.
    expect([...new Set(offenders)].sort()).toEqual([]);
  });

  test('only the boot migration imports the MongoDB driver for anything but an id', () => {
    const offenders = servingModules()
      .filter((file) => !file.startsWith(IMPORTER_PREFIX))
      .filter((file) => file !== 'src/db/client.ts')
      .flatMap(importsOf)
      .filter((site) => site.specifier === 'mongodb' && !site.typeOnly)
      .flatMap((site) =>
        site.names
          .filter((name) => !IDENTIFIER_ONLY.has(name))
          .map((name) => `${site.file} — ${name}`),
      );

    expect(offenders.sort()).toEqual([]);
  });

  test('no suite outside the boot migration still seeds MongoDB', () => {
    // This is the test that stops the exit criterion being satisfied
    // vacuously. `tryConnectTestMongo` returns null when no server answers and
    // every suite built on it then skip-passes, so "the suite is green with no
    // mongod running" is equally true of a suite that converted and one that
    // quietly stopped testing anything. Counting the callers is the difference
    // between the two, and it is the same lesson a reverted colour change
    // already taught this repository: a gate that skips is not evidence.
    const harness = 'test-db.test-helpers';
    const stragglers = [...new Glob('src/**/*.test.ts').scanSync('.')]
      .concat([...new Glob('src/**/*.test-helpers.ts').scanSync('.')])
      .filter((file) => !file.includes(harness))
      .filter((file) => !file.startsWith(IMPORTER_PREFIX))
      .filter((file) => file !== 'src/db/sqlite/boot-migration.test.ts')
      .filter((file) => importsOf(file).some((site) => site.specifier.includes(harness)))
      .sort();

    expect(stragglers).toEqual([]);
  });

  test('the boot migration is still allowed to, and still does', () => {
    // The complement of the two rules above. Without this, deleting the
    // importer's MongoDB access would make this whole file pass vacuously —
    // and a cutover that migrates nothing also reaches no MongoDB.
    const importerDriverUse = [...new Glob(`${IMPORTER_PREFIX}**/*.ts`).scanSync('.')]
      .filter((file) => !file.endsWith('.test.ts'))
      .flatMap(importsOf)
      .filter((site) => site.specifier === 'mongodb' && !site.typeOnly)
      .flatMap((site) => site.names)
      .filter((name) => !IDENTIFIER_ONLY.has(name));

    expect(importerDriverUse).toContain('MongoClient');
  });
});
