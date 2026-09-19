/**
 * Is the FTS5 swap a silent relevance regression? — the second exit criterion
 * of #3750, answered with numbers instead of an opinion.
 *
 *   bun scripts/sqlite-bench/search-relevance.ts            # 20,000 assets
 *   bun scripts/sqlite-bench/search-relevance.ts 60000
 *
 * ## What makes the comparison fair
 *
 * The two engines index *the same text*. The SQLite library is generated first,
 * then every `asset_search` row is copied into MongoDB verbatim as a document
 * with the same `_id` and the same `search_blob`, under the production text
 * index — `{ search_blob: 'text' }`, `default_language: 'english'`, partial over
 * live rows with a non-empty blob. So a difference in the results is a
 * difference between `$text` + `textScore` and `MATCH` + `bm25()`, and not a
 * difference between two corpora that merely resemble each other.
 *
 * The SQLite side runs the shipped translation
 * (`db/sqlite/repos/search.fts.ts`) and the shipped statement, so what is
 * measured is what the route will do.
 *
 * ## What the queries are
 *
 * Drawn from the corpus vocabulary in `./fixtures.ts` rather than from a
 * production query log, which this repository does not keep — so they are real
 * *shapes* rather than real strings: a single common word, a rare token, two
 * words, a place name, a quoted phrase, a negation, a filename with a dot in
 * it, and a few that no document contains. The shapes are the part that can
 * regress: a two-word query that silently became an AND, or a phrase that
 * silently became two terms, changes what a person gets back.
 *
 * ## What is reported, and why it is two things
 *
 * **Recall** is the match count, taken with no limit. If one engine finds 8
 * documents and the other finds 8, the two agree about what the query *means* —
 * that a phrase is a phrase, that a `-` excludes, that two words are an OR. A
 * difference here is a defect.
 *
 * **Ranking** is the order. BM25 and MongoDB's text score are different
 * formulas, so the orders can legitimately differ and a difference is not by
 * itself a regression. The generated library cannot measure this at all: its
 * blobs are drawn from one fifteen-word bag, so on a broad query thousands of
 * documents score almost identically and the top ten is a tie broken
 * arbitrarily. That is what `./search-ranking-corpus.ts` is for — twelve
 * documents whose term frequencies and lengths differ far enough apart that the
 * best match is not a matter of opinion.
 *
 * Nothing here touches production; the Mongo database is uniquely named and
 * dropped at the end.
 */

import type { Database } from 'bun:sqlite';
import { MongoClient, ObjectId, type Collection, type Db } from 'mongodb';
import { toTextFilter } from '../../src/db/sqlite/repos/search.repo.ts';
import { createTestDatabase, run } from '../../src/db/sqlite/test-sqlite.test-helpers.ts';
import { benchDbPath, buildLibrary, removeDatabase, sizeArgument } from './bench-db.ts';
import { agreementPrefix, RANKING_CORPUS, RANKING_PROBES } from './search-ranking-corpus.ts';

const DEFAULT_ASSETS = 20_000;
const TOP_K = 10;
/**
 * How many results the set comparison will fetch.
 *
 * Above it the two lists are arbitrary prefixes of a much larger match set, so
 * comparing them measures tie-breaking rather than relevance and the report says
 * "capped" instead of a number.
 */
const SET_CAP = 500;
const MONGO_URI = process.env.MAPLE_MONGO_URI ?? 'mongodb://localhost:27017';
const DB_PATH = benchDbPath('search-relevance');

/** One query shape, and why it is in the list. */
interface Probe {
  query: string;
  why: string;
}

const PROBES: Probe[] = [
  { query: 'lighthouse', why: 'a common word, in most documents' },
  { query: 'zephyrhold', why: 'a rare token, in a handful' },
  { query: 'harbour evening', why: 'two words — must be an OR, not an AND' },
  { query: 'quillmarsh lantern', why: 'a rare token beside a common one' },
  { query: 'new york', why: 'a place name, two common words' },
  { query: '"harbour evening"', why: 'a quoted phrase — must require adjacency' },
  { query: 'harbour -evening', why: 'a negation — must exclude' },
  { query: 'crosswalk espresso rehearsal', why: 'three words' },
  { query: 'IMG_0001.dng', why: 'a filename: punctuation inside a token' },
  { query: 'skylines', why: 'a plural — stemming should reach the singular' },
  { query: 'portraits of children', why: 'a natural-language phrase with a stop word' },
  { query: 'brambleveil tidewrack', why: 'two rare tokens' },
  { query: 'unfindableword', why: 'matches nothing on either engine' },
  { query: '???', why: 'nothing searchable at all' },
];

function overlap(a: readonly string[], b: readonly string[]): number {
  const set = new Set(b);
  return a.filter((id) => set.has(id)).length;
}

function jaccard(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 && b.length === 0) return 1;
  const left = new Set(a);
  const right = new Set(b);
  const shared = [...left].filter((id) => right.has(id)).length;
  return shared / (left.size + right.size - shared);
}

/** The corpus, exactly as the FTS5 index holds it. */
function readCorpus(db: Database): Array<{ asset_id: string; search_blob: string }> {
  return db.query('SELECT asset_id, search_blob FROM asset_search').all() as Array<{
    asset_id: string;
    search_blob: string;
  }>;
}

/** The same text in MongoDB, under the production text index. */
async function loadMongoCorpus(
  assets: Collection,
  corpus: ReadonlyArray<{ asset_id: string; search_blob: string }>,
): Promise<void> {
  const BATCH = 5000;
  for (let i = 0; i < corpus.length; i += BATCH) {
    await assets.insertMany(
      corpus.slice(i, i + BATCH).map((row) => ({
        _id: new ObjectId(row.asset_id),
        search_blob: row.search_blob,
        deleted_at: null,
      })) as never[],
    );
  }
  await assets.createIndex(
    { search_blob: 'text' },
    {
      name: 'search_blob_text',
      default_language: 'english',
      partialFilterExpression: { deleted_at: null, search_blob: { $type: 'string', $gt: '' } },
    },
  );
}

/**
 * Mongo's answer: ids ordered by text score, best first.
 *
 * The `search_blob` guard is not decoration. The text index is partial, and
 * Mongo's planner refuses a `$text` query it cannot prove implies the partial
 * filter — it errors rather than falling back to a scan. `applyLiveFilter` adds
 * exactly these two keys whenever `$text` is in play, and this mirrors it.
 */
async function mongoSearch(assets: Collection, query: string, limit: number): Promise<string[]> {
  const rows = await assets
    .find({
      deleted_at: null,
      search_blob: { $type: 'string', $gt: '' },
      $text: { $search: query },
    } as never)
    .project({ score: { $meta: 'textScore' } })
    .sort({ score: { $meta: 'textScore' } } as never)
    .limit(limit)
    .toArray();
  return rows.map((row) => (row._id as ObjectId).toHexString());
}

/** SQLite's answer: the shipped translation and the shipped ranking. */
function sqliteSearch(db: Database, query: string, limit: number): string[] {
  const match = toTextFilter(query);
  if (match.kind !== 'match') return [];
  const rows = db
    .query(
      `SELECT s.asset_id AS asset_id
         FROM assets_fts
         JOIN asset_search s ON s.rowid = assets_fts.rowid
        WHERE assets_fts MATCH ?
        ORDER BY bm25(assets_fts)
        LIMIT ?`,
    )
    .all(match.expression, limit) as Array<{ asset_id: string }>;
  return rows.map((row) => row.asset_id);
}

/** How many documents match at all — recall, separately from ranking. */
async function mongoCount(assets: Collection, query: string): Promise<number> {
  return assets.countDocuments({
    deleted_at: null,
    search_blob: { $type: 'string', $gt: '' },
    $text: { $search: query },
  } as never);
}

function sqliteCount(db: Database, query: string): number {
  const match = toTextFilter(query);
  if (match.kind !== 'match') return 0;
  const row = db
    .query('SELECT COUNT(*) AS n FROM assets_fts WHERE assets_fts MATCH ?')
    .get(match.expression) as { n: number };
  return row.n;
}

interface Comparison {
  probe: Probe;
  mongoCount: number;
  sqliteCount: number;
  topKOverlap: number;
  /** Set agreement, or `null` when either side is larger than the fetch cap. */
  jaccard: number | null;
  sameBest: boolean | null;
}

/**
 * Recall and ranking are two different questions and the report keeps them
 * apart.
 *
 * Recall is the match *count*, taken without a limit: if one engine finds 8
 * documents and the other finds 8, they agree about what the query means. Set
 * agreement over a capped list answers nothing when both sides hit the cap —
 * comparing two arbitrary 500-row prefixes of a 3,000-row match set measures
 * tie-breaking, not relevance — so the Jaccard column is reported only when
 * both result sets fit inside the cap and is `null` otherwise.
 */
function compare(
  probe: Probe,
  counts: { mongo: number; sqlite: number },
  top: { mongo: string[]; sqlite: string[] },
  full: { mongo: string[]; sqlite: string[] },
  cap: number,
): Comparison {
  const complete = Math.max(counts.mongo, counts.sqlite) <= cap;
  const bothAnswered = Math.min(top.mongo.length, top.sqlite.length) > 0;
  return {
    probe,
    mongoCount: counts.mongo,
    sqliteCount: counts.sqlite,
    topKOverlap: overlap(top.mongo, top.sqlite),
    jaccard: complete ? jaccard(full.mongo, full.sqlite) : null,
    sameBest: bothAnswered ? top.mongo[0] === top.sqlite[0] : null,
  };
}

/** One row of the recall-and-ranking table. */
function formatComparison(row: Comparison): string {
  const best = row.sameBest === null ? '—' : row.sameBest ? 'yes' : 'no';
  const agreement = row.jaccard === null ? 'capped' : row.jaccard.toFixed(2);
  return (
    `| \`${row.probe.query}\` | ${row.probe.why} | ${row.mongoCount} | ${row.sqliteCount} | ` +
    `${row.topKOverlap}/${TOP_K} | ${agreement} | ${best} |`
  );
}

/** The two sentences under the table: how recall and ranking compared. */
function summarise(rows: readonly Comparison[], corpusSize: number): string {
  const answering = rows.filter((row) => Math.max(row.mongoCount, row.sqliteCount) > 0);
  const sameRecall = answering.filter((row) => row.mongoCount === row.sqliteCount).length;
  const sameBest = answering.filter((row) => row.sameBest === true).length;
  const rankable = answering.filter((row) => row.sameBest !== null).length;
  const shared = answering.reduce((sum, row) => sum + row.topKOverlap, 0);
  const gaps = answering.filter((row) => row.mongoCount !== row.sqliteCount);
  const detail =
    gaps.length === 0
      ? ['', 'No query found documents on one engine and not the other.']
      : [
          '',
          'Queries whose match counts differ:',
          ...gaps.map(
            (row) =>
              `  - \`${row.probe.query}\`: Mongo ${row.mongoCount}, ` +
              `SQLite ${row.sqliteCount} (${row.probe.why})`,
          ),
        ];
  return [
    '',
    `Corpus: ${corpusSize.toLocaleString()} indexed blobs.`,
    `Recall: ${sameRecall}/${answering.length} queries matched the same number of documents.`,
    `Ranking: ${shared}/${answering.length * TOP_K} of the top-${TOP_K} slots are shared; ` +
      `${sameBest}/${rankable} agreed on the single best match.`,
    ...detail,
  ].join('\n');
}

function printReport(rows: readonly Comparison[], corpusSize: number): void {
  const header = [
    `\n| query | why | Mongo matches | SQLite matches | top-${TOP_K} shared | set agreement | same best |`,
    '| --- | --- | --- | --- | --- | --- | --- |',
  ];
  console.log([...header, ...rows.map(formatComparison)].join('\n'));
  console.log(summarise(rows, corpusSize));
}

/**
 * The second half: ranking, on a corpus small enough to have a right answer.
 *
 * The generated library cannot answer this. Its blobs are all drawn from the
 * same fifteen-word bag, so a broad query's top ten is a tie broken arbitrarily
 * and comparing two arbitrary tie-breaks measures nothing. `RANKING_CORPUS`
 * varies term frequency and document length far enough apart that the correct
 * order is not a matter of opinion — see that module.
 */
async function rankingReport(db: Db): Promise<void> {
  using handle = await createTestDatabase();
  for (const doc of RANKING_CORPUS) {
    run(
      handle.db,
      `INSERT INTO assets (id, size, mtime, indexed_at) VALUES (?, 1, 1, '2024-01-01T00:00:00Z')`,
      doc.id,
    );
    run(
      handle.db,
      'INSERT INTO asset_search (asset_id, search_blob) VALUES (?, ?)',
      doc.id,
      doc.blob,
    );
  }

  const assets = db.collection('ranking');
  await assets.insertMany(
    RANKING_CORPUS.map((doc) => ({
      _id: new ObjectId(doc.id),
      search_blob: doc.blob,
      deleted_at: null,
    })) as never[],
  );
  await assets.createIndex(
    { search_blob: 'text' },
    { name: 'search_blob_text', default_language: 'english' },
  );

  const shapes = new Map(RANKING_CORPUS.map((doc) => [doc.id, doc.shape] as const));
  console.log('\n## Ranking, on a corpus built to have a defensible answer\n');
  console.log(
    '| query | what decides the order | Mongo best is defensible | SQLite best is defensible | orderings agree for |',
  );
  console.log('| --- | --- | --- | --- | --- |');
  const detail: string[] = [];
  for (const probe of RANKING_PROBES) {
    const mongo = (
      await assets
        .find({ $text: { $search: probe.query } } as never)
        .project({ score: { $meta: 'textScore' } })
        .sort({ score: { $meta: 'textScore' } } as never)
        .toArray()
    ).map((row) => (row._id as ObjectId).toHexString());
    const sqlite = sqliteSearch(handle.db, probe.query, RANKING_CORPUS.length);
    const shared = agreementPrefix(mongo, sqlite);
    const ok = (ids: string[]): string =>
      ids.length > 0 && probe.acceptableTop.includes(ids[0]!) ? 'yes' : 'no';
    console.log(
      `| \`${probe.query}\` | ${probe.why} | ${ok(mongo)} | ${ok(sqlite)} | ` +
        `${shared} of ${Math.min(mongo.length, sqlite.length)} |`,
    );
    detail.push(
      `  \`${probe.query}\`\n` +
        `    Mongo : ${mongo.map((id) => shapes.get(id) ?? id).join(' > ')}\n` +
        `    SQLite: ${sqlite.map((id) => shapes.get(id) ?? id).join(' > ')}`,
    );
  }
  console.log(`\n${detail.join('\n')}`);
}

const assetCount = sizeArgument(Bun.argv.slice(2), DEFAULT_ASSETS);

console.log(`\n# Full-text relevance: $text vs FTS5, ${assetCount.toLocaleString()} assets\n`);
console.log('Building the SQLite library…');
const sqlite = await buildLibrary(DB_PATH, assetCount);
const corpus = readCorpus(sqlite);

const client = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 2000 });
const databaseName = `maple_search_relevance_${Date.now()}`;
try {
  await client.connect();
} catch {
  console.error(
    `\nNo MongoDB at ${MONGO_URI}. This comparison needs both engines — there is\n` +
      'nothing to compare FTS5 against without one.',
  );
  sqlite.close();
  await removeDatabase(DB_PATH);
  process.exit(1);
}

try {
  const assets = client.db(databaseName).collection('assets');
  console.log(`Copying ${corpus.length.toLocaleString()} blobs into MongoDB…`);
  await loadMongoCorpus(assets, corpus);

  const rows: Comparison[] = [];
  for (const probe of PROBES) {
    const counts = {
      mongo: await mongoCount(assets, probe.query),
      sqlite: sqliteCount(sqlite, probe.query),
    };
    const top = {
      mongo: await mongoSearch(assets, probe.query, TOP_K),
      sqlite: sqliteSearch(sqlite, probe.query, TOP_K),
    };
    const full = {
      mongo: await mongoSearch(assets, probe.query, SET_CAP),
      sqlite: sqliteSearch(sqlite, probe.query, SET_CAP),
    };
    rows.push(compare(probe, counts, top, full, SET_CAP));
  }
  printReport(rows, corpus.length);
  await rankingReport(client.db(databaseName));
  await client.db(databaseName).dropDatabase();
} finally {
  await client.close().catch(() => {});
  sqlite.close();
  await removeDatabase(DB_PATH);
}
