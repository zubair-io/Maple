// fallow-ignore-file complexity code-duplication
/**
 * Latency probe for the saved-filter ("For You") routes against a generated library database.
 *
 *   bun scripts/bench-generated-searches.ts seed  --db <source> --out <seeded> [--days 30] [--latest 12] [--per-day 4]
 *   bun scripts/bench-generated-searches.ts plans --db <seeded>
 *   bun scripts/bench-generated-searches.ts ranked --db <seeded> [--runs 30] [--json]
 *   bun scripts/bench-generated-searches.ts run   --db <seeded> [--runs 30] [--prewarm] [--rss] [--json]
 *
 * No mode opens the `--db` file for writing. `seed` (bench-generated-searches.seed.ts) clones it to
 * a new `--out` file and drives the real worker writer against that clone, with only the text model
 * scripted; point the other modes at the seeded file, where each works on a temporary clone that is
 * removed when it ends.
 *
 * `plans` mounts the real routes on the real reader pool, records every statement they issue and
 * prints EXPLAIN QUERY PLAN for each, flagging full scans.
 *
 * `ranked` times the free-text cards in-process (routes mounted on the real reader pool, no HTTP or
 * auth) with the search child replaced by a stand-in that answers a fixed list of ids, because the
 * real child needs a 2 GB embedding model. It measures the database work a ranked card does around
 * the child, not the child itself.
 *
 * `run` boots the real server on its clone and, for every stored collection, times
 * the list route, the stored first page, the live first page (what a client reload asks), the
 * second page and the default-size page: the first request, then the min and median of `--runs` more.
 */
import { suffix } from 'bun:ffi';
import { Database } from 'bun:sqlite';
import { constants, copyFile, mkdtemp, rm } from 'node:fs/promises';
import { loadavg, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { seed } from './bench-generated-searches.seed.ts';
import { apiRoot, flag, freePort, jsonOutput, median, runs } from './bench-library-server.ts';

const mode = Bun.argv[2];
const databasePath = flag('db', '');

interface Card {
  id: string;
  theme: string;
  title: string;
  query: Record<string, string>;
  result_count: number;
  generated_for: string;
}

interface ListBody {
  results: Card[];
}

interface PageBody {
  total: number;
  results: unknown[];
  snapshot?: true;
  pending?: true;
  more?: boolean;
}

async function sourceModule<T>(relative: string): Promise<T> {
  return (await import(join(apiRoot, 'src', relative))) as T;
}

interface Recorded {
  card: string;
  sql: string;
  params: unknown[];
}

async function withClone<T>(source: string, use: (clonePath: string) => Promise<T>): Promise<T> {
  const scratch = await mkdtemp(join(tmpdir(), 'maple-bench-generated-'));
  try {
    const clonePath = join(scratch, 'maple.sqlite');
    await copyFile(source, clonePath, constants.COPYFILE_FICLONE);
    return await use(clonePath);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

async function seedClone(source: string, out: string): Promise<void> {
  if (!out) throw new Error('seed needs --out <path of the seeded copy>');
  await copyFile(source, out, constants.COPYFILE_FICLONE | constants.COPYFILE_EXCL);
  await seed(out).catch(async (error: unknown) => {
    await rm(out, { force: true });
    throw error;
  });
}

async function plans(sqlitePath: string): Promise<void> {
  const { openSqlitePool, closeSqlitePool } = await sourceModule<{
    openSqlitePool: (o: { path: string }) => Promise<Record<string, unknown>>;
    closeSqlitePool: () => void;
  }>('db/sqlite/index.ts');
  const pool = await openSqlitePool({ path: sqlitePath });
  const recorded: Recorded[] = [];
  const current = { card: 'list' };
  for (const method of ['read', 'readBulk'] as const) {
    const original = (pool[method] as (...a: unknown[]) => unknown).bind(pool);
    pool[method] = (sql: string, params: unknown[] = []) => {
      recorded.push({ card: current.card, sql, params });
      return original(sql, params);
    };
  }
  const { Elysia } = await import(join(apiRoot, 'node_modules/elysia'));
  const { generatedSearchesRoutes } = await sourceModule<{ generatedSearchesRoutes: unknown }>(
    'routes/generated-searches.ts',
  );
  const app = new Elysia().use(generatedSearchesRoutes as never);
  const readonly = new Database(sqlitePath, { readonly: true });
  const library = (
    readonly.query(`SELECT library_id AS id FROM generated_searches LIMIT 1`).get() as {
      id: string;
    }
  ).id;
  const call = async (path: string): Promise<unknown> =>
    (await app.handle(new Request(`http://localhost${path}`))).json();
  const list = (await call(`/api/generated-searches?libraryId=${library}`)) as ListBody;
  for (const card of list.results) {
    current.card = `${card.theme} ${JSON.stringify(card.query)}`;
    for (const query of ['limit=30&snapshot=1', 'limit=30', 'limit=30&offset=30']) {
      await call(`/api/generated-searches/${card.id}/assets?${query}`);
    }
  }
  const seen = new Set<string>();
  const report = recorded
    .filter((entry) => {
      const key = `${entry.card}\n${entry.sql.replace(/\s+/g, ' ')}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((entry) => {
      const bound = entry.params as never[];
      const detail = (
        readonly.query(`EXPLAIN QUERY PLAN ${entry.sql}`).all(...bound) as Array<{
          detail: string;
        }>
      ).map((row) => row.detail);
      const statementMs = Array.from({ length: 6 }, () => {
        const started = performance.now();
        readonly.query(entry.sql).all(...bound);
        return performance.now() - started;
      });
      return {
        card: entry.card,
        sql: entry.sql.replace(/\s+/g, ' ').trim(),
        plan: detail,
        warmMinMs: Number(Math.min(...statementMs.slice(1)).toFixed(2)),
        fullScans: detail.filter(
          (line) => line.startsWith('SCAN ') && !/VIRTUAL TABLE|USING (COVERING )?INDEX/.test(line),
        ),
        rangeWalks: detail.filter((line) => /^SCAN .* USING INDEX/.test(line)),
      };
    });
  console.log(JSON.stringify(report, null, 2));
  readonly.close();
  closeSqlitePool();
}

async function ranked(sqlitePath: string): Promise<void> {
  const { openSqlitePool, closeSqlitePool } = await sourceModule<{
    openSqlitePool: (o: { path: string }) => Promise<unknown>;
    closeSqlitePool: () => void;
  }>('db/sqlite/index.ts');
  await openSqlitePool({ path: sqlitePath });
  const readonly = new Database(sqlitePath, { readonly: true });
  const mapleIds = (
    readonly
      .query(`SELECT maple_id FROM assets WHERE maple_id IS NOT NULL AND rowid % 40 = 0 LIMIT 8192`)
      .all() as Array<{ maple_id: string }>
  ).map((row) => row.maple_id);
  const library = (
    readonly.query(`SELECT library_id AS id FROM generated_searches LIMIT 1`).get() as {
      id: string;
    }
  ).id;
  readonly.close();
  const { setInProcessSearchForTests } = await sourceModule<{
    setInProcessSearchForTests: (search: unknown) => void;
  }>('search/search-pool.ts');
  setInProcessSearchForTests({
    search: async (_query: string, k: number) =>
      mapleIds.slice(0, k).map((id, index) => ({
        id,
        score: 1 - index / 10_000,
        vectorRank: index,
        textRank: null,
      })),
    status: () => ({ phase: 'ready' }),
  });
  const { Elysia } = await import(join(apiRoot, 'node_modules/elysia'));
  const { generatedSearchesRoutes } = await sourceModule<{ generatedSearchesRoutes: unknown }>(
    'routes/generated-searches.ts',
  );
  const app = new Elysia().use(generatedSearchesRoutes as never);
  const get = async (path: string) => {
    const started = performance.now();
    const response = await app.handle(new Request(`http://localhost${path}`));
    const text = await response.text();
    return { ms: performance.now() - started, status: response.status, text };
  };
  const loadBefore = loadavg()[0]!.toFixed(2);
  const list = JSON.parse(
    (await get(`/api/generated-searches?libraryId=${library}`)).text,
  ) as ListBody;
  const rows = [] as Array<Record<string, unknown>>;
  for (const card of list.results.filter((candidate) => candidate.query.placeQuery !== undefined)) {
    for (const [label, query] of [
      ['live first page (reload)', 'limit=30'],
      ['second page (offset=30)', 'limit=30&offset=30'],
      ['default page (limit 100)', ''],
    ] as const) {
      const samples = [] as Awaited<ReturnType<typeof get>>[];
      for (let i = 0; i <= runs; i += 1) {
        samples.push(await get(`/api/generated-searches/${card.id}/assets?${query}`));
      }
      const warm = samples.slice(1).map((sampled) => sampled.ms);
      const body = JSON.parse(samples[0]!.text) as PageBody;
      rows.push({
        card: card.theme,
        query: card.query,
        route: label,
        status: samples[0]!.status,
        bytes: samples[0]!.text.length,
        firstMs: Number(samples[0]!.ms.toFixed(1)),
        minMs: Number(Math.min(...warm).toFixed(2)),
        medianMs: Number(median(warm).toFixed(2)),
        rows: body.results?.length ?? null,
        total: body.total ?? null,
        pending: body.pending ?? false,
      });
    }
  }
  const result = { runs, loadBefore, loadAfter: loadavg()[0]!.toFixed(2), rows };
  console.log(jsonOutput ? JSON.stringify(result) : JSON.stringify(result, null, 2));
  closeSqlitePool();
}

async function rssMegabytes(pid: number): Promise<number> {
  const out = await Bun.$`ps -o rss= -p ${pid}`.text();
  return Math.round(Number(out.trim()) / 1024);
}

interface Sample {
  ms: number;
  status: number;
  bytes: number;
  serverTiming: string;
  body: PageBody | ListBody | null;
}

async function sample(url: string, headers: Record<string, string>): Promise<Sample> {
  const started = performance.now();
  const response = await fetch(url, { headers });
  const buffer = await response.arrayBuffer();
  const ms = performance.now() - started;
  const text = new TextDecoder().decode(buffer);
  return {
    ms,
    status: response.status,
    bytes: Number(response.headers.get('content-length') ?? buffer.byteLength),
    serverTiming: response.headers.get('server-timing') ?? '',
    body: response.status === 200 ? (JSON.parse(text) as PageBody | ListBody) : null,
  };
}

async function measure(sqlitePath: string) {
  const scratch = dirname(sqlitePath);
  if (process.argv.includes('--prewarm')) await Bun.$`cat ${sqlitePath} > /dev/null`.quiet();
  const readonly = new Database(sqlitePath);
  const latest = readonly
    .query(`SELECT library_id AS id FROM generated_searches ORDER BY generated_for DESC LIMIT 1`)
    .get() as { id: string } | null;
  const olderDay = latest
    ? (
        readonly
          .query(`SELECT MIN(generated_for) AS day FROM generated_searches WHERE library_id = ?`)
          .get(latest.id) as { day: string }
      ).day
    : null;
  readonly.close();
  if (!latest || !olderDay) {
    throw new Error('the database holds no stored collections; run the seed mode first');
  }
  const libraryId = latest.id;

  const loadBefore = loadavg()[0]!.toFixed(2);
  const bootStarted = performance.now();
  const port = freePort();
  const child = Bun.spawn(['bun', join(apiRoot, 'src/index.ts')], {
    cwd: scratch,
    env: {
      ...process.env,
      PORT: String(port),
      MAPLE_SQLITE_PATH: sqlitePath,
      MAPLE_NATIVE_LIB: join(apiRoot, 'native', `libraw_ffi.${suffix}`),
      MAPLE_DEV_AUTH: '1',
      MAPLE_INDEXER_AUTOSTART: '0',
      MAPLE_JWT_SECRET: 'bench-secret-bench-secret-1234',
      MAPLE_BACKUP_TMP: join(scratch, 'chunks'),
      LOG_LEVEL: 'warn',
    },
    stdout: 'ignore',
    stderr: 'ignore',
  });
  const base = `http://127.0.0.1:${port}`;
  try {
    const healthy = () =>
      fetch(`${base}/api/health`)
        .then((r) => r.ok)
        .catch(() => false);
    const gone = () => child.exitCode !== null || child.signalCode !== null;
    for (let attempt = 0; attempt < 200 && !gone(); attempt += 1) {
      if (await healthy()) break;
      await Bun.sleep(50);
    }
    if (gone() || !(await healthy())) {
      throw new Error(`the benchmark server did not become ready on port ${port}`);
    }
    const bootMs = performance.now() - bootStarted;
    const login = (await fetch(`${base}/api/auth/dev-login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    }).then((r) => r.json())) as { access_token: string };
    const headers = { Authorization: `Bearer ${login.access_token}`, 'Accept-Encoding': 'br' };

    const timeRoute = async (label: string, url: string) => {
      const samples: Sample[] = [];
      for (let i = 0; i <= runs; i += 1) samples.push(await sample(`${base}${url}`, headers));
      const firstSample = samples[0]!;
      const warm = samples.slice(1).map((s) => s.ms);
      const body = firstSample.body as PageBody | null;
      return {
        label,
        status: firstSample.status,
        bytes: firstSample.bytes,
        serverTiming: firstSample.serverTiming,
        firstMs: Number(firstSample.ms.toFixed(1)),
        minMs: Number(Math.min(...warm).toFixed(2)),
        medianMs: Number(median(warm).toFixed(2)),
        rows: body?.results?.length ?? null,
        total: body && 'total' in body ? body.total : null,
        pending: body && 'pending' in body ? (body.pending ?? false) : false,
        snapshot: body && 'snapshot' in body ? (body.snapshot ?? false) : false,
      };
    };

    const listUrl = `/api/generated-searches?libraryId=${libraryId}`;
    const rowsOut: Array<Awaited<ReturnType<typeof timeRoute>> & { kind: string }> = [];
    const listRow = await timeRoute('list (latest day)', listUrl);
    rowsOut.push({ ...listRow, kind: 'list' });
    rowsOut.push({
      ...(await timeRoute('list (oldest day, explicit date)', `${listUrl}&date=${olderDay}`)),
      kind: 'list',
    });
    const cards = ((await sample(`${base}${listUrl}`, headers)).body as ListBody).results;
    for (const card of cards) {
      const kind = Object.keys(card.query).sort().join('+');
      const routes: Array<[string, string]> = [
        ['stored first page (snapshot=1)', `limit=30&snapshot=1`],
        ['live first page (reload)', `limit=30`],
        ['second page (offset=30)', `limit=30&offset=30`],
        ['default page (limit 100)', ``],
      ];
      for (const [label, query] of routes) {
        const row = await timeRoute(
          `${card.id.slice(-6)} ${label}`,
          `/api/generated-searches/${card.id}/assets?${query}`,
        );
        rowsOut.push({
          ...row,
          kind: `${kind} | ${card.theme} (stored count ${card.result_count})`,
        });
      }
    }
    const result = {
      apiRoot,
      runs,
      bootMs: Math.round(bootMs),
      loadBefore,
      loadAfter: loadavg()[0]!.toFixed(2),
      cards: cards.length,
      rssMb: process.argv.includes('--rss') ? await rssMegabytes(child.pid) : null,
      rows: rowsOut,
    };
    console.log(jsonOutput ? JSON.stringify(result) : JSON.stringify(result, null, 2));
  } finally {
    child.kill();
    await child.exited;
  }
}

if (!databasePath) throw new Error('usage: seed|plans|ranked|run --db <file>');
if (mode === 'seed') await seedClone(databasePath, flag('out', ''));
else if (mode === 'plans') await withClone(databasePath, plans);
else if (mode === 'ranked') await withClone(databasePath, ranked);
else if (mode === 'run') await withClone(databasePath, measure);
else throw new Error('mode must be seed, plans, ranked or run');
process.exit(0);
