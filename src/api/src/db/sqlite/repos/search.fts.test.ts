/**
 * The FTS5 translation, and what it means for what a search finds.
 *
 * Two halves. The first is pure: a user's string becomes a `MATCH` expression,
 * and no string they can type becomes a syntax error — an FTS5 syntax error
 * throws rather than returning nothing, so it would 500 the search route. The
 * second runs those expressions against the fixture library and checks the
 * semantics survived the translation: terms OR, phrases are required, `-`
 * excludes, and `bm25()` ranks the best match first rather than last.
 */

import { describe, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { createTestDatabase, testSqliteDb } from '../test-sqlite.test-helpers.ts';
import { toTextFilter } from './search.fts.ts';
import { searchCount, searchPage } from './search.page.ts';
import { buildSearchWhere } from './search.where.ts';
import { seedSearchLibrary } from './search.test-helpers.ts';

/** The expression, for the cases that produce one. */
function expression(raw: string): string | null {
  const filter = toTextFilter(raw);
  return filter.kind === 'match' ? filter.expression : null;
}

describe('toTextFilter', () => {
  test('ORs bare terms, as $text does', () => {
    expect(expression('harbour lantern')).toBe('(("harbour" OR "lantern"))');
  });

  test('requires a quoted phrase', () => {
    expect(expression('"paper lanterns"')).toBe('("paper lanterns")');
  });

  test('ANDs a phrase with the OR group of bare terms', () => {
    expect(expression('"paper lanterns" kyoto street')).toBe(
      '("paper lanterns" AND ("kyoto" OR "street"))',
    );
  });

  test('excludes a negated term', () => {
    expect(expression('harbour -boat')).toBe('(("harbour")) NOT ("boat")');
  });

  test('excludes a negated phrase', () => {
    expect(expression('kyoto -"paper lanterns"')).toBe('(("kyoto")) NOT ("paper lanterns")');
  });

  test('an unterminated quote runs to the end of the string', () => {
    // Which is what a person half-way through typing a phrase means by it: the
    // rest becomes one phrase, and the word before the quote stays a term.
    expect(expression('say "hi')).toBe('("hi" AND ("say"))');
  });

  test('a bare term splits on punctuation, as $text tokenizes it', () => {
    // Not `"harbour.dng"`, which FTS5 reads as a two-word phrase and which
    // would stop matching a caption that says only "harbour".
    expect(expression('harbour.dng')).toBe('(("harbour" OR "dng"))');
    expect(expression('well-lit room')).toBe('(("well" OR "lit" OR "room"))');
  });

  test('a quoted phrase is not split, because a phrase is the point of quoting', () => {
    expect(expression('"harbour.dng"')).toBe('("harbour.dng")');
  });

  test('a blank query is the only one that carries no text filter', () => {
    // `none` and `nothing` are different answers and the difference is the
    // whole library: the route attaches `$text` for anything non-blank, so
    // anything non-blank has to stay a filter here too.
    expect(toTextFilter('')).toEqual({ kind: 'none' });
    expect(toTextFilter('   ')).toEqual({ kind: 'none' });
  });

  test('a query with no positive term matches nothing, as $text does', () => {
    // Measured against MongoDB rather than assumed: `$text` answers 0 documents
    // for every one of these, because none of them contributes a term to OR
    // against. Answering `none` instead would widen each one to the entire
    // live library.
    for (const raw of ['???', '((((', '"', '-', '+++', '-boat', '-boat -lanterns']) {
      expect(toTextFilter(raw)).toEqual({ kind: 'nothing' });
    }
  });

  test('keeps non-Latin terms, which an [a-z0-9] test would drop', () => {
    expect(expression('東京')).toBe('(("東京"))');
    expect(expression('naïve')).toBe('(("naïve"))');
  });

  test('a pasted paragraph still searches, capped at the first 24 terms', () => {
    // It used to answer `none` past 500 characters, which handed back every
    // photo in the library. The term cap is what bounds the cost; length is the
    // transport's business.
    const long = Array.from({ length: 200 }, (_, i) => `term${i}`).join(' ');
    expect(long.length).toBeGreaterThan(500);
    const filter = toTextFilter(long);
    expect(filter.kind).toBe('match');
    expect(expression(long)).toContain('"term23"');
    expect(expression(long)).not.toContain('"term24"');
  });
});

describe('what a translated query actually finds', () => {
  async function search(db: Database, placeQuery: string): Promise<string[]> {
    const where = buildSearchWhere({ placeQuery });
    if ('error' in where) throw new Error(where.error);
    const rows = await searchPage(
      where,
      { sort: 'captured_desc', limit: 20, skip: 0 },
      testSqliteDb(db),
    );
    return rows.map((row) => row.fileinfo?.[0]?.filename ?? '');
  }

  test('a single term finds every asset whose blob mentions it', async () => {
    using handle = await createTestDatabase();
    seedSearchLibrary(handle.db);
    expect((await search(handle.db, 'harbour')).sort()).toEqual(['clip.mp4', 'harbour.dng']);
  });

  test('two terms are an OR, not an AND', async () => {
    using handle = await createTestDatabase();
    seedSearchLibrary(handle.db);
    const found = await search(handle.db, 'harbour lanterns');
    expect(found.sort()).toEqual(['clip.mp4', 'harbour.dng', 'lantern.dng']);
  });

  test('a phrase requires the words adjacent', async () => {
    using handle = await createTestDatabase();
    seedSearchLibrary(handle.db);
    expect(await search(handle.db, '"paper lanterns"')).toEqual(['lantern.dng']);
    expect(await search(handle.db, '"lanterns paper"')).toEqual([]);
  });

  test('a negated term removes a match the positive terms found', async () => {
    using handle = await createTestDatabase();
    seedSearchLibrary(handle.db);
    const withBridge = await search(handle.db, 'new york');
    expect(withBridge).toContain('skyline.dng');
    expect(await search(handle.db, 'new york -bridge')).not.toContain('skyline.dng');
  });

  test('the porter stemmer matches a word to its other forms', async () => {
    using handle = await createTestDatabase();
    seedSearchLibrary(handle.db);
    // "cooling" in the blob, "cool" in the query. This is the English stemming
    // the Mongo index got from `default_language: 'english'`.
    expect(await search(handle.db, 'cooling')).toEqual(['kitchen.jpg']);
    expect(await search(handle.db, 'cool')).toEqual(['kitchen.jpg']);
  });

  test('no input a person can type is an FTS5 syntax error', async () => {
    using handle = await createTestDatabase();
    seedSearchLibrary(handle.db);
    // Every one of these is a syntax error forwarded to MATCH unquoted, and an
    // FTS5 syntax error throws rather than matching nothing — so unquoted it
    // would 500 the search route, not return an empty grid.
    const hostile = [
      'C++ (2019)',
      'a:b',
      '^start',
      'foo*',
      'red OR blue',
      'x NEAR y',
      'NOT',
      '"',
      '((((',
      'a - b',
      '{tag}',
      "O'Brien",
    ];
    for (const input of hostile) {
      const filter = toTextFilter(input);
      if (filter.kind !== 'match') continue;
      expect(() =>
        handle.db
          .query(`SELECT COUNT(*) AS n FROM assets_fts WHERE assets_fts MATCH ?`)
          .all(filter.expression),
      ).not.toThrow();
    }
  });

  test('an empty phrase matches nothing and empties an AND, which is why terms drop', async () => {
    using handle = await createTestDatabase();
    seedSearchLibrary(handle.db);
    // The reason `HAS_TOKEN_CHARS` exists, pinned rather than asserted in a
    // comment. A quoted string with no tokens in it is not an error and not a
    // match-all; it is a phrase with nothing in it. Harmless in an OR, fatal in
    // an AND — so `kyoto "???"` has to drop the punctuation rather than emit it.
    const matches = (fts5: string): number =>
      (
        handle.db
          .query('SELECT COUNT(*) AS n FROM assets_fts WHERE assets_fts MATCH ?')
          .get(fts5) as { n: number }
      ).n;
    expect(matches('"harbour"')).toBe(2);
    expect(matches('"!!"')).toBe(0);
    expect(matches('("!!" AND "harbour")')).toBe(0);
    expect(matches('("harbour" OR "!!")')).toBe(2);
  });

  test('a query that cannot match returns nothing, not everything', async () => {
    using handle = await createTestDatabase();
    seedSearchLibrary(handle.db);
    // The library has nine live assets, and each of these used to return all
    // nine: the translation answered "no text filter" and the structured search
    // fell through to the whole live set. `$text` answers zero for all three.
    const where = buildSearchWhere({ placeQuery: '???' });
    if ('error' in where) throw new Error(where.error);
    expect(where.match).toEqual({ kind: 'nothing' });
    expect(await search(handle.db, '???')).toEqual([]);
    expect(await search(handle.db, '-boat')).toEqual([]);
    expect(await search(handle.db, '((((')).toEqual([]);
    // And an empty one still is not a filter, so the whole live set is right.
    expect((await search(handle.db, '')).length).toBe(9);
  });

  test('a pasted paragraph searches its terms rather than matching everything', async () => {
    using handle = await createTestDatabase();
    seedSearchLibrary(handle.db);
    // 500+ characters, a real term and then filler past the term cap. This
    // used to come back as the entire live library.
    const padded = `harbour ${'filler '.repeat(80)}`;
    expect(padded.length).toBeGreaterThan(500);
    expect((await search(handle.db, padded)).sort()).toEqual(['clip.mp4', 'harbour.dng']);
  });

  test('a total count and a page agree on a query that matches nothing', async () => {
    using handle = await createTestDatabase();
    seedSearchLibrary(handle.db);
    const where = buildSearchWhere({ placeQuery: '-boat' });
    if ('error' in where) throw new Error(where.error);
    expect(await searchCount(where, testSqliteDb(handle.db))).toBe(0);
    expect(await search(handle.db, '-boat')).toEqual([]);
  });
});
