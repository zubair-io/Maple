/**
 * The fold behind every case-insensitive unique index in this schema (#3749).
 *
 * The claim `case-fold.ts` makes is that folding agrees with the Mongo
 * collation `{ locale: 'en', strength: 2 }` these indexes replace. That claim
 * is checkable rather than a matter of opinion: ICU's own rule is reachable
 * from JavaScript as `localeCompare(b, 'en', { sensitivity: 'accent' })`, so
 * every case below asserts the two answers are the same one.
 *
 * `COLLATE NOCASE` is asserted against the same pairs, to show what it would
 * have got wrong — it is not a fold that happens to be weaker, it disagrees
 * with the collation it stands in for.
 */

import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { caseFoldKey } from './case-fold.ts';

/** The rule the Mongo indexes are declared with, asked directly. */
function sameUnderCollation(a: string, b: string): boolean {
  return a.localeCompare(b, 'en', { sensitivity: 'accent' }) === 0;
}

/** What SQLite would have said, had the index stayed on `name COLLATE NOCASE`. */
function sameUnderNocase(db: Database, a: string, b: string): boolean {
  const row = db.query('SELECT (? = ? COLLATE NOCASE) AS same').get(a, b) as { same: number };
  return row.same === 1;
}

/** Pairs that the collation calls one name. */
const SAME = [
  ['Ada', 'ada'],
  ['josé', 'JOSÉ'],
  ['ÅNGSTRÖM', 'ångström'],
  ['Ω', 'ω'],
  // Canonically equivalent: composed é against e + combining acute.
  ['é', 'é'],
  // Compatibility forms — why the normalisation is NFKC and not NFC.
  ['ﬁ', 'fi'],
  ['Ⅻ', 'xii'],
  ['ＡＢ', 'ab'],
];

/** Pairs that the collation calls two names. */
const DIFFERENT = [
  ['e', 'é'],
  ['ß', 'ss'],
  ['İ', 'i'],
  ['Bob', 'bob '],
  ['Ada', 'Grace'],
];

describe('caseFoldKey reproduces the collation it stands in for', () => {
  test('folds together exactly the names the collation calls one name', () => {
    for (const [a, b] of SAME) {
      expect(sameUnderCollation(a, b)).toBe(true);
      expect(caseFoldKey(a)).toBe(caseFoldKey(b));
    }
  });

  test('keeps apart exactly the names the collation calls two names', () => {
    for (const [a, b] of DIFFERENT) {
      expect(sameUnderCollation(a, b)).toBe(false);
      expect(caseFoldKey(a)).not.toBe(caseFoldKey(b));
    }
  });

  test('does not depend on the process locale', () => {
    // Turkish lowercases I to a dotless ı. `toLocaleLowerCase` on a host in
    // that locale would fold "IRIS" and "iris" apart, and whether two people
    // merge is not something the server's locale gets a say in.
    expect(caseFoldKey('IRIS')).toBe('iris');
    expect(caseFoldKey('I')).toBe('i');
  });
});

describe('COLLATE NOCASE is not that collation', () => {
  test('it folds ASCII and leaves every accented pair apart', () => {
    using db = new Database(':memory:');
    const ascii = SAME.filter(([a]) => /^[\x20-\x7e]*$/.test(a));
    const beyond = SAME.filter(([a]) => !/^[\x20-\x7e]*$/.test(a));

    expect(ascii.length).toBeGreaterThan(0);
    for (const [a, b] of ascii) expect(sameUnderNocase(db, a, b)).toBe(true);

    // Every one of these is a name pair the operator means as one person, and
    // NOCASE reports each as two — which is the bug the stored key removes.
    for (const [a, b] of beyond) expect(sameUnderNocase(db, a, b)).toBe(false);
  });
});
