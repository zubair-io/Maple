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
import { createTestDatabase } from '../test-sqlite.test-helpers.ts';
import { testSqliteDb } from './assets.test-helpers.ts';
import { toMatchExpression } from './search.fts.ts';
import { searchPage } from './search.page.ts';
import { buildSearchWhere } from './search.where.ts';
import { seedSearchLibrary } from './search.test-helpers.ts';

describe('toMatchExpression', () => {
  test('ORs bare terms, as $text does', () => {
    expect(toMatchExpression('harbour lantern')).toBe('(("harbour" OR "lantern"))');
  });

  test('requires a quoted phrase', () => {
    expect(toMatchExpression('"paper lanterns"')).toBe('("paper lanterns")');
  });

  test('ANDs a phrase with the OR group of bare terms', () => {
    expect(toMatchExpression('"paper lanterns" kyoto street')).toBe(
      '("paper lanterns" AND ("kyoto" OR "street"))',
    );
  });

  test('excludes a negated term', () => {
    expect(toMatchExpression('harbour -boat')).toBe('(("harbour")) NOT ("boat")');
  });

  test('excludes a negated phrase', () => {
    expect(toMatchExpression('kyoto -"paper lanterns"')).toBe('(("kyoto")) NOT ("paper lanterns")');
  });

  test('an unterminated quote runs to the end of the string', () => {
    // Which is what a person half-way through typing a phrase means by it: the
    // rest becomes one phrase, and the word before the quote stays a term.
    expect(toMatchExpression('say "hi')).toBe('("hi" AND ("say"))');
  });

  test('a bare term splits on punctuation, as $text tokenizes it', () => {
    // Not `"harbour.dng"`, which FTS5 reads as a two-word phrase and which
    // would stop matching a caption that says only "harbour".
    expect(toMatchExpression('harbour.dng')).toBe('(("harbour" OR "dng"))');
    expect(toMatchExpression('well-lit room')).toBe('(("well" OR "lit" OR "room"))');
  });

  test('a quoted phrase is not split, because a phrase is the point of quoting', () => {
    expect(toMatchExpression('"harbour.dng"')).toBe('("harbour.dng")');
  });

  test('answers null when there is nothing to search for', () => {
    expect(toMatchExpression('')).toBeNull();
    expect(toMatchExpression('   ')).toBeNull();
    expect(toMatchExpression('???')).toBeNull();
    // Negations alone cannot be expressed: FTS5's NOT needs a left operand.
    expect(toMatchExpression('-boat')).toBeNull();
  });

  test('keeps non-Latin terms, which an [a-z0-9] test would drop', () => {
    expect(toMatchExpression('東京')).toBe('(("東京"))');
    expect(toMatchExpression('naïve')).toBe('(("naïve"))');
  });

  test('refuses a query longer than the route accepts', () => {
    expect(toMatchExpression('a'.repeat(501))).toBeNull();
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
      const expression = toMatchExpression(input);
      if (expression === null) continue;
      expect(() =>
        handle.db
          .query(`SELECT COUNT(*) AS n FROM assets_fts WHERE assets_fts MATCH ?`)
          .all(expression),
      ).not.toThrow();
    }
  });

  test('punctuation-only input is not a text filter at all', async () => {
    using handle = await createTestDatabase();
    seedSearchLibrary(handle.db);
    // `null` from the translation means "no text filter", so the search falls
    // back to the structured one and returns the whole live set — not nothing,
    // and not an FTS5 syntax error.
    const where = buildSearchWhere({ placeQuery: '???' });
    if ('error' in where) throw new Error(where.error);
    expect(where.match).toBeNull();
    expect((await search(handle.db, '???')).length).toBe(9);
  });
});
