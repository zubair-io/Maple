// fallow-ignore-file complexity code-duplication
/**
 * The `seed` mode of bench-generated-searches.ts: fills a clone of a generated library database (made by
 * bench-generated-searches.ts) with saved collections by driving the real worker writer (`runProposalLoop` with the real search
 * executor, then `saveGeneratedSearches`). Only the text model is scripted: it answers the proposal
 * and title prompts from a fixed list instead of an LLM. The people the roster offers are renamed
 * first, because the generator names every cluster "Person N" and the roster withholds those.
 *
 *   bun scripts/bench-generated-searches.ts seed --db <source> --out <seeded> [--days 30] [--latest 12] [--per-day 4]
 */
import { join } from 'node:path';
import { apiRoot, flag } from './bench-library-server.ts';

const DAY_MS = 86_400_000;

interface Proposal {
  theme: string;
  query: Record<string, string>;
}

async function sourceModule<T>(relative: string): Promise<T> {
  return (await import(join(apiRoot, 'src', relative))) as T;
}

function proposals(years: readonly number[], people: readonly string[]): Proposal[] {
  const first = years[0]!;
  const middle = years[Math.floor(years.length / 2)]!;
  const last = years[years.length - 1]!;
  return [
    { theme: 'one whole year', query: { from: `${middle}-01-01`, to: `${middle}-12-31` } },
    { theme: 'one summer month', query: { from: `${last}-07-01`, to: `${last}-07-31` } },
    { theme: 'every October', query: { month: '10' } },
    { theme: 'outdoors only', query: { sceneType: 'outdoor' } },
    { theme: 'dated phrase only', query: { placeQuery: `June ${middle}` } },
    { theme: 'one person', query: { people: people[0]! } },
    {
      theme: 'one person in a year',
      query: { people: people[1]!, from: `${middle}-01-01`, to: `${middle}-12-31` },
    },
    { theme: 'indoor in spring', query: { sceneType: 'indoor', month: '4' } },
    { theme: 'since the start', query: { from: `${first}-01-01` } },
    { theme: 'ranked: light', query: { placeQuery: 'harbour lantern' } },
    {
      theme: 'ranked: caption sentence',
      query: {
        placeQuery: 'mountain festival evening courtyard with children and espresso on the skyline',
        month: '10',
      },
    },
    {
      theme: 'ranked: text and dated phrase',
      query: { placeQuery: `mountain harbour in ${middle}` },
    },
  ];
}

export async function seed(databasePath: string): Promise<void> {
  const days = Number(flag('days', '30'));
  const latest = Number(flag('latest', '12'));
  const perDay = Number(flag('per-day', '4'));
  const { openSqlitePool, closeSqlitePool, sqlitePool } = await sourceModule<{
    openSqlitePool: (o: { path: string }) => Promise<unknown>;
    closeSqlitePool: () => void;
    sqlitePool: () => {
      read: <T>(sql: string, params?: unknown[]) => Promise<T[]>;
      write: (sql: string, params?: unknown[]) => Promise<unknown>;
    };
  }>('db/sqlite/index.ts');
  await openSqlitePool({ path: databasePath });
  const pool = sqlitePool();
  const names = ['Ada Bench', 'Bo Bench', 'Cy Bench', 'Di Bench'];
  const personRows = await pool.read<{ id: string }>(
    `SELECT id FROM people WHERE name LIKE 'Person %' ORDER BY id LIMIT ?`,
    [names.length],
  );
  for (const [index, row] of personRows.entries()) {
    await pool.write(`UPDATE people SET name = ?, name_key = ? WHERE id = ?`, [
      names[index],
      names[index]!.toLowerCase(),
      row.id,
    ]);
  }
  const library = (
    await pool.read<{ id: string }>(
      `SELECT library_id AS id FROM asset_locations WHERE ordinal = 0 GROUP BY library_id ORDER BY COUNT(*) DESC LIMIT 1`,
    )
  )[0]!.id;

  const { buildDigest } = await sourceModule<{
    buildDigest: (lib: string, now: Date) => Promise<{ people: string[]; coverageYears: number[] }>;
  }>('workers/generated-search/build-digest.ts');
  const { runProposalLoop } = await sourceModule<{
    runProposalLoop: (deps: Record<string, unknown>) => Promise<unknown[]>;
  }>('workers/generated-search/loop.ts');
  const { runGeneratedSearch } = await sourceModule<{ runGeneratedSearch: unknown }>(
    'workers/generated-search/search-adapter.ts',
  );
  const { TITLE_SCHEMA } = await sourceModule<{ TITLE_SCHEMA: unknown }>(
    'workers/generated-search/prompt.ts',
  );
  const { saveGeneratedSearches } = await sourceModule<{
    saveGeneratedSearches: (docs: unknown[]) => Promise<void>;
  }>('workers/generated-search/repo.ts');

  const now = new Date();
  for (let back = days - 1; back >= 0; back -= 1) {
    const day = new Date(now.getTime() - back * DAY_MS);
    const digest = await buildDigest(library, day);
    const wanted = back === 0 ? latest : perDay;
    const offset = (back * 3) % 12;
    const pool12 = proposals(digest.coverageYears, digest.people);
    const chosen = Array.from({ length: wanted }, (_unused, i) => pool12[(offset + i) % 12]!);
    const titled = new Map<string, number>();
    const saved = await runProposalLoop({
      generateJson: async (_prompt: string, schema: unknown) => {
        if (schema === TITLE_SCHEMA) {
          const count = (titled.get('n') ?? 0) + 1;
          titled.set('n', count);
          return { title: `Collection ${back}-${count}`, subtitle: 'generated for the bench' };
        }
        return { collections: chosen };
      },
      runSearch: runGeneratedSearch,
      digest,
      validationContext: { allowedPeople: digest.people, coverageYears: digest.coverageYears },
      libraryId: library,
      generatedFor: day.toISOString().slice(0, 10),
      generatedAt: day.toISOString(),
      model: 'bench-scripted',
      count: wanted,
      minResults: 8,
      maxRounds: 1,
    });
    await saveGeneratedSearches(saved);
    console.error(`day -${back}: proposed ${wanted}, stored ${saved.length}`);
  }
  closeSqlitePool();
}
