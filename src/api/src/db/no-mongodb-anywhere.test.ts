/**
 * The exit criterion, as a test (#3785).
 *
 * Nothing in this server may import the MongoDB driver. It is not installed any
 * more, so an import would fail at resolve time rather than pass silently — but
 * that is exactly why the check is worth keeping: the way it comes back is
 * somebody adding the dependency to `package.json` alongside the import,
 * because a suggestion or an old snippet reached for `ObjectId` from where it
 * used to live. This fails first, and names the file.
 *
 * The narrower rule it replaces was about the *serving path*: during the
 * cutover the importer was allowed to reach MongoDB, and the identifier type
 * was allowed to be imported from it anywhere, so the gate had to distinguish
 * between a module reading the old store and a module borrowing a type. Both
 * exemptions are gone. The importer is deleted, and the identifier lives in
 * `db/object-id.ts`, which is where the second half of this file makes sure it
 * keeps living: a project that has its own identifier class and 200 modules
 * spelling it four different ways has not really moved off anything.
 *
 * `db/client.ts` — the general-purpose accessor every route used to reach for —
 * went at the cutover, and the third rule keeps it gone. It reads as trivially
 * true today, and that is the point: it is a ratchet, and it fails the moment
 * someone writes one import of a module by that name under `db/`.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { Glob } from 'bun';

/** Every import statement in a file, with whether it was `import type`. */
const IMPORT_RE = /^[ \t]*import[ \t]+(type[ \t]+)?([\s\S]*?)[ \t]+from[ \t]*['"]([^'"]+)['"]/gm;

/** A bare `await import('x')` or `require('x')`, which the above does not see. */
const DYNAMIC_RE = /(?:await[ \t]+import|require)\([ \t]*['"]([^'"]+)['"]/g;

interface ImportSite {
  readonly file: string;
  readonly specifier: string;
}

function importsOf(file: string): ImportSite[] {
  const source = readFileSync(file, 'utf8');
  return [
    ...[...source.matchAll(IMPORT_RE)].map((match) => ({ file, specifier: match[3]! })),
    ...[...source.matchAll(DYNAMIC_RE)].map((match) => ({ file, specifier: match[1]! })),
  ];
}

/** Every TypeScript file in the server, its tests and its scripts. */
function allModules(): string[] {
  return [
    ...new Glob('src/**/*.ts').scanSync('.'),
    ...new Glob('tests/**/*.ts').scanSync('.'),
    ...new Glob('scripts/**/*.ts').scanSync('.'),
  ].sort();
}

/** The one module allowed to define the identifier, and its own test. */
const IDENTIFIER_MODULE = /(^|\/)db\/object-id\.ts$/;

describe('#3785 — MongoDB is gone', () => {
  test('nothing imports the driver, in any form', () => {
    const offenders = allModules()
      .flatMap(importsOf)
      .filter((site) => site.specifier === 'mongodb' || site.specifier.startsWith('mongodb/'))
      .map((site) => site.file);

    // Named rather than counted: when this fails, the list is the work left.
    expect([...new Set(offenders)].sort()).toEqual([]);
  });

  test('nor the in-memory server the old test harness spawned', () => {
    const offenders = allModules()
      .flatMap(importsOf)
      .filter((site) => site.specifier.startsWith('mongodb-memory-server'))
      .map((site) => site.file);

    expect([...new Set(offenders)].sort()).toEqual([]);
  });

  test('the driver and the in-memory server are not dependencies either', () => {
    // An import is how it comes back, and this is what it comes back through.
    const manifest = JSON.parse(readFileSync('package.json', 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const declared = [
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.devDependencies ?? {}),
    ];
    expect(declared.filter((name) => name.includes('mongo'))).toEqual([]);
  });

  test('the identifier has exactly one definition', () => {
    // Every other module imports `ObjectId` from `db/object-id.ts`. A second
    // `class ObjectId` anywhere would be a second opinion about a format that
    // is a client contract, and the two would diverge on the first edit.
    const definitions = allModules().filter((file) =>
      /(?:^|\n)\s*export\s+class\s+ObjectId\b/.test(readFileSync(file, 'utf8')),
    );

    expect(definitions.filter((file) => !IDENTIFIER_MODULE.test(file))).toEqual([]);
    expect(definitions).toHaveLength(1);
  });

  test('nothing outside tests imports db/client.ts', () => {
    const offenders = allModules()
      .filter((file) => !file.endsWith('.test.ts'))
      .flatMap(importsOf)
      .filter((site) => site.specifier.includes('db/client.ts'))
      .map((site) => site.file);

    expect([...new Set(offenders)].sort()).toEqual([]);
  });
});
