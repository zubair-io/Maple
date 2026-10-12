/**
 * Reproduces #4514's load shape against a library on disk: three For You cards whose themes are
 * long sentences, each reloaded live as soon as its previous request finishes (what the iPhone's
 * snapshot-then-live reload does), on the real worker-thread pool. Alongside it, a small indexed
 * read is issued every 100 ms on the request-path lane — the lookup `/api/auth/me` makes — and
 * the pool's per-reader queue depth is sampled every 50 ms.
 *
 *   bun scripts/sqlite-bench/caption-library.ts /tmp/caption-300k.sqlite 300000
 *   sqlite3 /tmp/caption-300k.sqlite 'DELETE FROM sqlite_stat1'   # the plan production fell into
 *   bun scripts/sqlite-bench/generated-search-load.ts /tmp/caption-300k.sqlite 60 2 [in-process]
 *
 * The third argument is how many clients reload each card at once (a phone and a TV shelf is
 * two). Pass `in-process` to select the in-process engine without starting its child — the state
 * a restart leaves for the minute the child spends loading vectors.
 */

import { Elysia } from 'elysia';
import { openSqlitePool, closeSqlitePool } from '../../src/db/sqlite/index.ts';
import { newObjectIdHex } from '../../src/db/object-id.ts';
import { generatedSearchesRoutes } from '../../src/routes/generated-searches.ts';
import { saveSearchEngine } from '../../src/search/search-engine-selection.ts';

const CARDS: Array<Record<string, string>> = [
  {
    placeQuery: 'grainy film and early digital photos capturing the vibe of the early 2000s',
    from: '2000-01-01',
  },
  { placeQuery: 'scenic shots featuring vibrant orange and red autumn foliage', month: '10' },
  { placeQuery: 'busy city streets, tall buildings, and urban cityscapes' },
];

function percentile(samples: readonly number[], p: number): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted.length === 0
    ? 0
    : sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!;
}

const [path, secondsArg, clientsArg, engine] = process.argv.slice(2);
if (!path) {
  throw new Error('usage: generated-search-load.ts <db> [seconds] [clients per card] [in-process]');
}
const seconds = Number(secondsArg ?? 60);
const clientsPerCard = Number(clientsArg ?? 1);
const pool = await openSqlitePool({ path });
if (engine === 'in-process') await saveSearchEngine('in-process');

const library = (await pool.read<{ id: string }>('SELECT id FROM folders LIMIT 1'))[0]!.id;
const stored = (await pool.read<{ id: string }>('SELECT id FROM assets LIMIT 30')).map((r) => r.id);
const user = newObjectIdHex();
await pool.write(
  `INSERT INTO users (id, email, email_key, role, created_at) VALUES (?, ?, ?, 'owner', ?)`,
  [user, `${user}@maple.local`, `${user}@maple.local`, new Date().toISOString()],
);
const cards = await Promise.all(
  CARDS.map(async (query) => {
    const id = newObjectIdHex();
    await pool.write(
      `INSERT INTO generated_searches
         (id, library_id, generated_for, generated_at, model, attempts, theme, title, subtitle,
          query, result_count, cover_asset_id, first_page_ids)
       VALUES (?, ?, '2026-10-12', ?, 'load', 1, 'load', 'Load', NULL, ?, 100, NULL, ?)`,
      [id, library, new Date().toISOString(), JSON.stringify(query), JSON.stringify(stored)],
    );
    return id;
  }),
);

const app = new Elysia().use(generatedSearchesRoutes);
const deadline = performance.now() + seconds * 1000;
const cardMs: number[] = [];
const cardErrors: string[] = [];
const probeMs: number[] = [];
const probeErrors: string[] = [];
const busyReaders: number[] = [];

async function client(id: string): Promise<void> {
  while (performance.now() < deadline) {
    const started = performance.now();
    const res = await app.handle(
      new Request(`http://localhost/api/generated-searches/${id}/assets?limit=30`),
    );
    cardMs.push(performance.now() - started);
    if (res.status !== 200) cardErrors.push(`${res.status} ${(await res.text()).slice(0, 80)}`);
    else await res.json();
  }
}

async function probe(): Promise<void> {
  while (performance.now() < deadline) {
    const started = performance.now();
    await pool
      .read('SELECT id, email, role FROM users WHERE id = ?', [user])
      .catch((err: unknown) => probeErrors.push(err instanceof Error ? err.message : String(err)));
    probeMs.push(performance.now() - started);
    await Bun.sleep(100);
  }
}

const sampler = setInterval(() => {
  busyReaders.push(pool.stats().readers.filter((reader) => reader.inFlight > 0).length);
}, 50);
const inFlight = { cards: 0 };
await Promise.race([
  Promise.all([
    ...cards
      .flatMap((id) => Array.from({ length: clientsPerCard }, () => id))
      .map(async (id) => {
        inFlight.cards += 1;
        await client(id);
        inFlight.cards -= 1;
      }),
    probe(),
  ]),
  Bun.sleep(seconds * 1000 + 35_000),
]);
clearInterval(sampler);

const readers = pool.stats().readers.length;
const pinned = busyReaders.filter((n) => n === readers).length / Math.max(busyReaders.length, 1);
console.log(
  JSON.stringify(
    {
      engine: engine ?? 'none selected',
      seconds,
      clients: cards.length * clientsPerCard,
      readers,
      cardRequests: cardMs.length,
      cardErrors: cardErrors.length,
      cardRequestsStillRunningAtEnd: inFlight.cards,
      cardMs: { p50: Math.round(percentile(cardMs, 0.5)), max: Math.round(Math.max(0, ...cardMs)) },
      busyReaders: { p50: percentile(busyReaders, 0.5), max: Math.max(0, ...busyReaders) },
      allReadersBusyShare: Number(pinned.toFixed(3)),
      otherRead: {
        count: probeMs.length,
        errors: probeErrors.length,
        p50: Number(percentile(probeMs, 0.5).toFixed(1)),
        p95: Number(percentile(probeMs, 0.95).toFixed(1)),
        max: Number(Math.max(0, ...probeMs).toFixed(1)),
      },
      sampleErrors: [...new Set([...cardErrors, ...probeErrors])].slice(0, 3),
    },
    null,
    2,
  ),
);
closeSqlitePool();
process.exit(0);
