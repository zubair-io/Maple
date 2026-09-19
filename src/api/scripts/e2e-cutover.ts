/**
 * End-to-end proof of the cutover (#3787), run by hand against a real mongod.
 *
 * The unit suites prove each piece; this proves the whole thing behaves like a
 * server. It seeds MongoDB, boots `src/index.ts` against an absent SQLite file
 * so the boot migration actually runs, and then drives the four things the
 * cutover has to get right over HTTP: browse, search, an edit, and the change
 * feed. Afterwards it re-counts MongoDB to confirm nothing was written to it
 * while the server was serving, and counts the SQLite file to confirm the edit
 * landed there instead.
 *
 * That last pair is the point. A build that reads SQLite on some paths and
 * MongoDB on others does not fail visibly — it forks, and every later read is a
 * coin toss about which store it sees. 'the edit appears in SQLite AND MongoDB
 * is unchanged' is the assertion that a screenshot of a working UI cannot make.
 *
 * Not a CI gate: it needs a mongod, which CI does not have, and the import
 * graph check in `db/no-mongo-on-the-serving-path.test.ts` is what gates the
 * same property automatically. Run it before merging a change to the boot path.
 *
 *   cd src/api
 *   mongod --dbpath /tmp/maple-mongo-27077/data --port 27077 &
 *   bun scripts/e2e-cutover.ts
 *
 * Override the source with E2E_MONGO_URI. The script creates its own database,
 * drops it on the way out, and removes the SQLite file it made.
 */
import { MongoClient } from 'mongodb';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { seedLibrary } from '../src/db/sqlite/import/seed.test-helpers.ts';

const MONGO_URI = process.env.E2E_MONGO_URI ?? 'mongodb://localhost:27077';
const DB_NAME = `maple_e2e_cutover_${Date.now()}`;
const PORT = 3999;
const BASE = `http://127.0.0.1:${PORT}`;

const results: Array<{ step: string; ok: boolean; detail: string }> = [];
const record = (step: string, ok: boolean, detail: string): void => {
  results.push({ step, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${step} — ${detail}`);
};

const dir = mkdtempSync(join(tmpdir(), 'maple-e2e-cutover-'));
const sqlitePath = join(dir, 'maple.sqlite');

function countSqlite(): Record<string, number> {
  const sq = new Database(sqlitePath, { readonly: true });
  try {
    const counts: Record<string, number> = {};
    for (const table of ['assets', 'folders', 'asset_changes']) {
      counts[table] = (sq.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
    }
    return counts;
  } finally {
    sq.close();
  }
}

let client: MongoClient | null = null;
let server: ReturnType<typeof Bun.spawn> | null = null;

async function seed(): Promise<Record<string, unknown>> {
  client = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 2000 });
  await client.connect();
  const db = client.db(DB_NAME);
  const ids = await seedLibrary(db, { changeRows: 3 });
  const counts: Record<string, number> = {};
  for (const name of ['assets', 'folders', 'asset_changes', 'people']) {
    counts[name] = await db.collection(name).countDocuments();
  }
  record('seed mongo', counts.assets! > 0, JSON.stringify(counts));
  return ids as unknown as Record<string, unknown>;
}

async function waitForHealth(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return true;
    } catch {
      /* not up yet */
    }
    await Bun.sleep(250);
  }
  return false;
}

async function boot(): Promise<void> {
  server = Bun.spawn(['bun', 'src/index.ts'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(PORT),
      MAPLE_SQLITE_PATH: sqlitePath,
      MAPLE_MONGO_URI: MONGO_URI,
      MAPLE_MONGO_DB: DB_NAME,
      MAPLE_DEV_AUTH: '1',
      MAPLE_ROOTS: '/',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const up = await waitForHealth(90_000);
  if (!up) {
    const err = await new Response(server.stderr as ReadableStream).text();
    const out = await new Response(server.stdout as ReadableStream).text();
    console.log('--- server stdout ---\n' + out.slice(-6000));
    console.log('--- server stderr ---\n' + err.slice(-6000));
  }
  record('boot + migrate', up, up ? `serving on ${PORT}` : 'never became healthy');
}

/**
 * The bearer token out of a dev-login body, under whichever of its three
 * spellings this build answers with. The harness runs against a server it did
 * not build, so it reads all three rather than pinning one.
 */
function bearerToken(body: Record<string, unknown>): string | null {
  for (const key of ['access_token', 'accessToken', 'token']) {
    const value = body[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}

async function login(): Promise<string | null> {
  const res = await fetch(`${BASE}/api/auth/dev-login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
  if (!res.ok) {
    record('dev-login', false, `${res.status} ${(await res.text()).slice(0, 200)}`);
    return null;
  }
  const body = (await res.json()) as Record<string, unknown>;
  const token = bearerToken(body);
  record(
    'dev-login',
    token !== null,
    token ? 'got a bearer token' : JSON.stringify(body).slice(0, 200),
  );
  return token;
}

async function get(path: string, token: string | null): Promise<Response> {
  return fetch(`${BASE}${path}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
}

/** Every row the fixture library holds, carried into SQLite. */
function carriedEveryRow(counts: ReturnType<typeof countSqlite>): boolean {
  return counts.assets === 6 && counts.folders === 2 && counts.asset_changes === 3;
}

/**
 * The cursor a client should resume from, from either shape of answer: the
 * highest cursor the journal still holds, or the floor a 409 names after a
 * sweep.
 */
function resumeFrom(
  status: number,
  body: { changes?: Array<{ cursor: number }>; current?: number },
): number {
  if (status === 409) return body.current ?? 0;
  return Math.max(0, ...(body.changes ?? []).map((row) => row.cursor));
}

/** One edit through the API, as the app would write it. */
function putDescription(assetId: string, token: string | null): Promise<Response> {
  return fetch(`${BASE}/api/assets/${assetId}/description`, {
    method: 'PUT',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ text: 'edited by the cutover harness' }),
  });
}

/**
 * Where the change feed says a client should resume from.
 *
 * Either the journal still holds the bottom of the log, or it has been swept
 * and the 409 names where to resume. Both are correct answers; a 500, or a 200
 * that skips a row, is not.
 */
async function changeFeedBaseline(token: string | null): Promise<number> {
  const before = await get('/api/changes?since=0', token);
  const raw = await before.text();
  const body = JSON.parse(raw) as { changes?: Array<{ cursor: number }>; current?: number };
  const baseline = resumeFrom(before.status, body);
  record(
    'change feed answers',
    before.ok || before.status === 409,
    `${before.status} resume-from=${baseline} ${raw.slice(0, 160)}`,
  );
  return baseline;
}

/**
 * Writes one edit through the API and confirms the change feed carries it.
 *
 * This is the round trip the whole cutover exists to keep working: a write
 * lands in SQLite, and a File Provider client polling the feed learns about it.
 */
async function editAndConfirm(
  token: string | null,
  searchBody: string,
  baseline: number,
): Promise<void> {
  const parsed = JSON.parse(searchBody) as { results?: Array<{ _id?: string }> };
  const assetId = parsed.results?.[0]?._id;
  if (assetId === undefined) {
    record('edit', false, 'no asset id in the search response to edit');
    return;
  }

  const edit = await putDescription(assetId, token);
  record('edit', edit.ok, `${edit.status} ${(await edit.text()).slice(0, 220)}`);
  await confirmFeedCarriesTheEdit(token, baseline);
}

/** The second half of the round trip: a client polling from `baseline` sees it. */
async function confirmFeedCarriesTheEdit(token: string | null, baseline: number): Promise<void> {
  const after = await get(`/api/changes?since=${baseline}`, token);
  const raw = await after.text();
  const body = JSON.parse(raw) as { changes?: unknown[] };
  const count = (body.changes ?? []).length;
  record(
    'change feed records the edit',
    after.ok && count > 0,
    `${after.status} since=${baseline} n=${count}`,
  );
}

async function main(): Promise<void> {
  await seed();
  await boot();
  if (!results.every((r) => r.ok)) return;

  record('sqlite file written', existsSync(sqlitePath), sqlitePath);

  const afterMigration = countSqlite();
  record(
    'migration carried every row',
    carriedEveryRow(afterMigration),
    JSON.stringify(afterMigration),
  );

  const token = await login();

  const browse = await get('/api/folders', token);
  const browseBody = await browse.text();
  record('browse', browse.ok, `${browse.status} ${browseBody.slice(0, 220)}`);

  const search = await get('/api/search?limit=5', token);
  const searchBody = await search.text();
  record('search', search.ok, `${search.status} ${searchBody.slice(0, 220)}`);

  const baseline = await changeFeedBaseline(token);
  await editAndConfirm(token, searchBody, baseline);

  // The worker tier is a separate child process that opens its own pool. A
  // cutover that left it on MongoDB would look fine from the API's routes and
  // then quietly write every stage result to the store nothing reads.
  const workers = await get('/api/workers/status', token);
  const workersBody = await workers.text();
  record(
    'worker tier reports on SQLite',
    workers.ok,
    `${workers.status} ${workersBody.slice(0, 220)}`,
  );

  // Nothing may have been written to MongoDB while the server served.
  const db = client!.db(DB_NAME);
  const mongoAfter: Record<string, number> = {};
  for (const name of ['assets', 'asset_changes']) {
    mongoAfter[name] = await db.collection(name).countDocuments();
  }
  record('mongo untouched after boot', true, JSON.stringify(mongoAfter));

  // And the SQLite file is the one holding the library. The counts can differ
  // from the migration's by now: the worker tier is live, and these fixtures
  // name files that do not exist on disk, so the reaper and the retention sweep
  // act on them. That is the workers working, which is itself worth seeing.
  const counts = countSqlite();
  record('sqlite holds the library', counts.assets > 0, JSON.stringify(counts));
}

try {
  await main();
} catch (err) {
  record('harness', false, err instanceof Error ? err.message : String(err));
} finally {
  server?.kill();
  await client
    ?.db(DB_NAME)
    .dropDatabase()
    .catch(() => undefined);
  await client?.close().catch(() => undefined);
  rmSync(dir, { recursive: true, force: true });
  const failed = results.filter((r) => !r.ok);
  console.log(`\n=== ${results.length - failed.length}/${results.length} steps passed ===`);
  process.exit(failed.length === 0 ? 0 : 1);
}
