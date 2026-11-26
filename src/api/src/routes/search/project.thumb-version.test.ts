import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { searchPage } from '../../db/repos/search.page.ts';
import { seedSearchAsset } from '../../db/repos/search.test-helpers.ts';
import { buildSearchWhere } from '../../db/repos/search.where.ts';
import {
  createTestDatabase,
  insertFolder,
  testSqliteDb,
  type TestDatabase,
} from '../../db/sqlite/test-sqlite.test-helpers.ts';
import * as fs from '../../fs/mirrored.ts';
import { resolveThumbPath } from '../../fs/xmp.ts';
import { projectAssets } from './project.ts';

let database: TestDatabase;
let root: string;
let libraryId: string;
const past = new Date('2026-01-01T00:00:00Z');
const later = new Date('2026-02-01T00:00:00Z');

async function original(name: string): Promise<string> {
  const file = join(root, name);
  await fs.writeFile(file, 'x');
  await fs.utimes(file, past, past);
  return file;
}

async function thumb(file: string, bytes: string): Promise<void> {
  const cached = resolveThumbPath(file);
  await fs.mkdir(dirname(cached), { recursive: true });
  await fs.writeFile(cached, bytes);
  await fs.utimes(cached, later, later);
}

async function searchResults() {
  const where = buildSearchWhere({});
  if ('error' in where) throw new Error(where.error);
  const docs = await searchPage(
    where,
    { sort: 'captured_desc', limit: 10, skip: 0 },
    testSqliteDb(database.db),
  );
  const results = await projectAssets(
    docs,
    new Map([[libraryId, root]]),
    new Map([[libraryId, 'waves']]),
  );
  return new Map(results.map((result) => [result.filename, result]));
}

beforeEach(async () => {
  database = await createTestDatabase();
  root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'maple-search-thumb-version-')));
  libraryId = insertFolder(database.db, { slug: 'waves', path: root });
  for (const mapleId of ['rendered', 'unrendered']) {
    seedSearchAsset(database.db, libraryId, { mapleId, path: '', filename: `${mapleId}.dng` });
  }
});

afterEach(async () => {
  database.close();
  await fs.rm(root, { recursive: true, force: true });
});

describe('search results name the thumb their URL can cache forever #6016', () => {
  it('carries thumb_version for a fresh thumb and omits it where none is rendered', async () => {
    await thumb(await original('rendered.dng'), 'thumb');
    await original('unrendered.dng');

    const results = await searchResults();

    expect(results.get('rendered.dng')?.abs_path).toBe(join(root, 'rendered.dng'));
    expect(results.get('rendered.dng')?.thumb_version).toBeString();
    expect(results.get('unrendered.dng')).toBeDefined();
    expect(results.get('unrendered.dng')).not.toHaveProperty('thumb_version');
  });

  it('names a different version once the thumb is rendered again', async () => {
    const file = await original('rendered.dng');
    await thumb(file, 'thumb');
    const before = (await searchResults()).get('rendered.dng')?.thumb_version;

    await thumb(file, 'thumb, rendered again');

    const after = (await searchResults()).get('rendered.dng')?.thumb_version;
    expect(before).toBeString();
    expect(after).toBeString();
    expect(after).not.toBe(before);
  });
});
