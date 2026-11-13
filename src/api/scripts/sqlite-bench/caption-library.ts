/**
 * A benchmark library whose search text reads like production's captions (#4514).
 *
 * `generate.ts` draws every search blob from a fifteen-word bag, which is enough
 * for facet and index timings but not for the failure #4514 is about: a long
 * natural-language query whose OR-group of terms matches most of the library.
 * This rewrites every blob as a describe-style sentence over a few hundred words,
 * with the vocabulary of the incident's three For You cards common enough that
 * each of their queries matches the large majority of the library, as on
 * production, and marks a few people hidden so `excludeHiddenPeople` has ids to
 * drop.
 *
 *   bun scripts/sqlite-bench/caption-library.ts /tmp/caption-300k.sqlite 300000
 */

import type { Database } from 'bun:sqlite';
import {
  ASSET_SEARCH_TRIGGER_DDL,
  ASSET_SEARCH_TRIGGER_NAMES,
  ASSETS_FTS_OPTIMIZE_SQL,
  ASSETS_FTS_REBUILD_SQL,
} from '../../src/db/sqlite/ddl/search.ts';
import { buildLibrary } from './bench-db.ts';

const COMMON = [
  'photo',
  'image',
  'shows',
  'featuring',
  'scene',
  'vibrant',
  'street',
  'city',
  'buildings',
  'people',
  'red',
  'orange',
  'light',
  'tall',
  'urban',
  'early',
  'digital',
  'film',
  'shot',
  'trees',
];

const FILLER = Array.from({ length: 400 }, (_unused, index) => `w${index.toString(36)}x`);

function makeRandom(seed: number): () => number {
  const state = { value: seed >>> 0 };
  return () => {
    state.value = (state.value + 0x6d2b79f5) >>> 0;
    const a = Math.imul(state.value ^ (state.value >>> 15), state.value | 1);
    const b = a ^ (a + Math.imul(a ^ (a >>> 7), a | 61));
    return ((b ^ (b >>> 14)) >>> 0) / 4294967296;
  };
}

/** One caption: forty words, a quarter of them from the common vocabulary. */
function caption(random: () => number): string {
  return Array.from({ length: 40 }, () =>
    random() < 0.25
      ? COMMON[Math.floor(random() * COMMON.length)]!
      : FILLER[Math.floor(random() ** 2 * FILLER.length)]!,
  ).join(' ');
}

/** Rewrite every search blob as a caption and rebuild the inverted index once. */
export function rewriteCaptions(db: Database, seed = 0x4514): number {
  const random = makeRandom(seed);
  for (const name of ASSET_SEARCH_TRIGGER_NAMES) db.exec(`DROP TRIGGER IF EXISTS ${name}`);
  const rows = db.query('SELECT rowid FROM asset_search').all() as Array<{ rowid: number }>;
  const update = db.prepare('UPDATE asset_search SET search_blob = ? WHERE rowid = ?');
  db.transaction(() => {
    for (const row of rows) update.run(caption(random), row.rowid);
  })();
  db.exec(ASSET_SEARCH_TRIGGER_DDL);
  db.exec(ASSETS_FTS_REBUILD_SQL);
  db.exec(ASSETS_FTS_OPTIMIZE_SQL);
  db.run(`UPDATE people SET hidden = 1 WHERE rowid IN (SELECT rowid FROM people LIMIT 6)`);
  db.exec('ANALYZE');
  return rows.length;
}

if (import.meta.main) {
  const [path, size] = process.argv.slice(2);
  if (!path) throw new Error('usage: caption-library.ts <path> [assets]');
  const started = performance.now();
  const db = await buildLibrary(path, Number(size ?? 300_000));
  const rewritten = rewriteCaptions(db);
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  db.close();
  console.log(
    `${path}: ${rewritten} captions in ${Math.round((performance.now() - started) / 1000)} s`,
  );
}
