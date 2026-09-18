/**
 * The service route's lexical fallback.
 *
 * Two things matter here and neither is the row count. An exact filename match
 * has to lead, because a caller searching for `harbour.dng` means that file and
 * not the best caption about harbours. And the two passes have to see the same
 * universe: the exact pass and the ranked pass apply the request's scope
 * separately, so a filter honoured by one and not the other would let a hidden
 * or out-of-window asset in through whichever pass forgot it.
 */

import { describe, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { createTestDatabase, testSqliteDb } from '../test-sqlite.test-helpers.ts';
import { serviceLexicalSearch, type ServiceSearchScope } from './search.service.ts';
import { seedSearchLibrary, type SeededLibrary } from './search.test-helpers.ts';

const OPEN: ServiceSearchScope = {
  includeHidden: false,
  mediaTypes: undefined,
  capturedFrom: undefined,
  capturedBefore: undefined,
};

/** `maple_id` → the filename it belongs to, for readable assertions. */
function filenamesById(db: Database): Map<string, string> {
  const rows = db
    .query(
      `SELECT a.maple_id AS maple_id, l.filename AS filename
         FROM assets a JOIN asset_locations l ON l.asset_id = a.id AND l.ordinal = 0`,
    )
    .all() as Array<{ maple_id: string; filename: string }>;
  return new Map(rows.map((row) => [row.maple_id, row.filename] as const));
}

async function search(
  db: Database,
  query: string,
  scope: Partial<ServiceSearchScope> = {},
  limit = 20,
): Promise<{ names: string[]; exact: string[] }> {
  const hits = await serviceLexicalSearch({ ...OPEN, ...scope }, query, limit, testSqliteDb(db));
  const names = filenamesById(db);
  return {
    names: hits.ids.map((id) => names.get(id) ?? id),
    exact: [...hits.exactIds].map((id) => names.get(id) ?? id),
  };
}

async function seeded(): Promise<{
  handle: Awaited<ReturnType<typeof createTestDatabase>>;
  library: SeededLibrary;
}> {
  const handle = await createTestDatabase();
  return { handle, library: seedSearchLibrary(handle.db) };
}

describe('serviceLexicalSearch', () => {
  test('an exact filename match leads, and is flagged as exact', async () => {
    const { handle } = await seeded();
    using h = handle;
    const result = await search(h.db, 'harbour.dng');
    expect(result.names[0]).toBe('harbour.dng');
    expect(result.exact).toEqual(['harbour.dng']);
  });

  test('the filename match ignores case', async () => {
    const { handle } = await seeded();
    using h = handle;
    expect((await search(h.db, 'HARBOUR.DNG')).exact).toEqual(['harbour.dng']);
  });

  test('a wildcard in the query is a literal, not a pattern', async () => {
    const { handle } = await seeded();
    using h = handle;
    // Were `%` honoured, this would match every `.dng` in the library.
    expect((await search(h.db, '%.dng')).exact).toEqual([]);
  });

  test('ranked full-text matches fill the rest of the page', async () => {
    const { handle } = await seeded();
    using h = handle;
    const result = await search(h.db, 'harbour');
    // No file is literally named "harbour", so every hit comes from the index.
    expect(result.exact).toEqual([]);
    expect(result.names.sort()).toEqual(['clip.mp4', 'harbour.dng']);
  });

  test('an exact hit is not repeated by the ranked pass', async () => {
    const { handle } = await seeded();
    using h = handle;
    const result = await search(h.db, 'harbour.dng');
    expect(result.names.filter((name) => name === 'harbour.dng').length).toBe(1);
  });

  test('hidden assets stay out unless the caller asks for them', async () => {
    const { handle } = await seeded();
    using h = handle;
    expect((await search(h.db, 'private')).names).toEqual([]);
    expect((await search(h.db, 'private', { includeHidden: true })).names).toEqual(['private.dng']);
  });

  test('a media-type filter reads the denormalised column, not the filename', async () => {
    const { handle } = await seeded();
    using h = handle;
    const videos = await search(h.db, 'harbour', { mediaTypes: ['video'] });
    expect(videos.names).toEqual(['clip.mp4']);
    const images = await search(h.db, 'harbour', { mediaTypes: ['image'] });
    expect(images.names).toEqual(['harbour.dng']);
  });

  test('a capture window applies to both passes', async () => {
    const { handle } = await seeded();
    using h = handle;
    const windowed = { capturedFrom: '2024-01-01', capturedBefore: '2024-05-01' };
    // The exact pass would find harbour.dng; the window is what keeps it out.
    expect((await search(h.db, 'harbour.dng', windowed)).names).toEqual(['clip.mp4']);
  });

  test('the limit bounds the combined result', async () => {
    const { handle } = await seeded();
    using h = handle;
    expect((await search(h.db, 'new york harbour lanterns', {}, 2)).names.length).toBe(2);
  });

  test('a query with nothing searchable in it returns nothing, not everything', async () => {
    const { handle } = await seeded();
    using h = handle;
    expect((await search(h.db, '???')).names).toEqual([]);
  });

  test('the excluded assets never surface', async () => {
    const { handle } = await seeded();
    using h = handle;
    for (const name of ['trashed.dng', 'replaced.dng', 'vanished.dng']) {
      expect((await search(h.db, name)).names).toEqual([]);
    }
  });
});
