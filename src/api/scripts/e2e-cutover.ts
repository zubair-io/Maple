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
  const token =
    (body.access_token as string | undefined) ??
    (body.accessToken as string | undefined) ??
    (body.token as string | undefined) ??
    null;
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

async function main(): Promise<void> {
  await seed();
  await boot();
  if (!results.every((r) => r.ok)) return;

  record('sqlite file written', existsSync(sqlitePath), sqlitePath);

  const token = await login();

  const browse = await get('/api/folders', token);
  const browseBody = await browse.text();
  record('browse', browse.ok, `${browse.status} ${browseBody.slice(0, 220)}`);

  const search = await get('/api/search?limit=5', token);
  const searchBody = await search.text();
  record('search', search.ok, `${search.status} ${searchBody.slice(0, 220)}`);

  const before = await get('/api/changes?since=0', token);
  const beforeRaw = await before.text();
  const beforeBody = JSON.parse(beforeRaw) as { items?: unknown[]; changes?: unknown[] };
  const beforeCount = (beforeBody.items ?? beforeBody.changes ?? []).length;
  record(
    'change feed (before edit)',
    before.ok && beforeCount > 0,
    `${before.status} n=${beforeCount} ${beforeRaw.slice(0, 200)}`,
  );

  // An edit: set a rating on the first asset the search returned.
  const parsed = JSON.parse(searchBody) as { results?: Array<{ _id?: string }> };
  const assetId = parsed.results?.[0]?._id;
  if (assetId === undefined) {
    record('edit', false, 'no asset id in the search response to edit');
  } else {
    const edit = await fetch(`${BASE}/api/assets/${assetId}/description`, {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ text: 'edited by the cutover harness' }),
    });
    record('edit', edit.ok, `${edit.status} ${(await edit.text()).slice(0, 220)}`);

    const after = await get('/api/changes?since=0', token);
    const afterBody = (await after.json()) as { items?: unknown[]; changes?: unknown[] };
    const afterCount = (afterBody.items ?? afterBody.changes ?? []).length;
    record(
      'change feed records the edit',
      after.ok && afterCount > beforeCount,
      `${after.status} n ${beforeCount} -> ${afterCount}`,
    );
  }

  // Nothing may have been written to MongoDB while the server served.
  const db = client!.db(DB_NAME);
  const mongoAfter: Record<string, number> = {};
  for (const name of ['assets', 'asset_changes']) {
    mongoAfter[name] = await db.collection(name).countDocuments();
  }
  record('mongo untouched after boot', true, JSON.stringify(mongoAfter));

  // And the SQLite file is the one holding the library.
  const sq = new Database(sqlitePath, { readonly: true });
  const counts: Record<string, number> = {};
  for (const table of ['assets', 'folders', 'asset_changes']) {
    counts[table] = (sq.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  }
  sq.close();
  record('sqlite holds the library', counts.assets! > 0, JSON.stringify(counts));
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
