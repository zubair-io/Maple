// fallow-ignore-file complexity code-duplication
/**
 * Route latency probe against a generated library database: boots the real server on a COPY of
 * the database and times the read routes the web and native clients hit on open.
 *
 *   bun scripts/sqlite-bench/run.ts 335377 --keep      # builds /tmp/maple-sqlite-bench/bench-335377.db
 *   bun scripts/bench-routes.ts --db /tmp/maple-sqlite-bench/bench-335377.db [--runs 15] [--rss] [--prewarm]
 *
 * Reports server boot time, then per route the first request and the min/median of the rest.
 */
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apiRoot, flag, jsonOutput, median, runs } from './bench-library-server.ts';

const databasePath = flag('db', '/tmp/maple-sqlite-bench/bench-335377.db');
const PORT = 3800 + Math.floor(Math.random() * 200);

const ROUTES: ReadonlyArray<readonly [string, string]> = [
  ['health', '/api/health'],
  ['folders', '/api/folders'],
  ['search page (100)', '/api/search?limit=100'],
  ['search page (500)', '/api/search?limit=500'],
  ['search filtered (camera)', '/api/search?limit=100&camera=SONY'],
  ['search filtered (rating, month)', '/api/search?limit=100&rating=4&month=10'],
  ['search filtered (ext, iso)', '/api/search?limit=100&ext=dng&isoMin=100&isoMax=800'],
  ['search buckets (timeline)', '/api/search/buckets'],
  ['search facets', '/api/search/facets'],
  ['assets list (1000)', '/api/assets?limit=1000'],
  ['generated searches', '/api/generated-searches'],
];

async function rssMegabytes(pid: number): Promise<number> {
  const out = await Bun.$`ps -o rss= -p ${pid}`.text();
  return Math.round(Number(out.trim()) / 1024);
}

async function main() {
  const scratch = join(tmpdir(), `maple-bench-routes-${process.pid}`);
  await Bun.$`mkdir -p ${scratch}`.quiet();
  const sqlitePath = join(scratch, 'maple.sqlite');
  await Bun.$`cp -c ${databasePath} ${sqlitePath}`.quiet();
  if (process.argv.includes('--prewarm')) await Bun.$`cat ${sqlitePath} > /dev/null`.quiet();
  const bootStarted = performance.now();
  const child = Bun.spawn(['bun', join(apiRoot, 'src/index.ts')], {
    cwd: scratch,
    env: {
      ...process.env,
      PORT: String(PORT),
      MAPLE_SQLITE_PATH: sqlitePath,
      MAPLE_NATIVE_LIB: join(apiRoot, 'native', 'libraw_ffi.dylib'),
      MAPLE_DEV_AUTH: '1',
      MAPLE_INDEXER_AUTOSTART: '0',
      MAPLE_JWT_SECRET: 'bench-secret-bench-secret-1234',
      MAPLE_BACKUP_TMP: join(scratch, 'chunks'),
      LOG_LEVEL: 'warn',
    },
    stdout: 'ignore',
    stderr: 'ignore',
  });
  const base = `http://127.0.0.1:${PORT}`;
  while (
    !(await fetch(`${base}/api/health`)
      .then((r) => r.ok)
      .catch(() => false))
  ) {
    await Bun.sleep(25);
  }
  const bootMs = performance.now() - bootStarted;
  try {
    const login = (await fetch(`${base}/api/auth/dev-login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    }).then((r) => r.json())) as { access_token: string };
    const headers = { Authorization: `Bearer ${login.access_token}`, 'Accept-Encoding': 'br' };
    const result: Record<string, unknown> = { apiRoot, bootMs: Math.round(bootMs), routes: {} };
    for (const [label, path] of ROUTES) {
      const timings: number[] = [];
      let status = 0;
      let bytes = 0;
      let serverTiming = '';
      for (let i = 0; i <= runs; i++) {
        const started = performance.now();
        const response = await fetch(`${base}${path}`, { headers });
        const body = await response.arrayBuffer();
        timings.push(performance.now() - started);
        status = response.status;
        bytes = Number(response.headers.get('content-length') ?? body.byteLength);
        if (i === 0) serverTiming = response.headers.get('server-timing') ?? '';
      }
      const [first, ...rest] = timings;
      (result.routes as Record<string, unknown>)[label] = {
        status,
        bytes,
        firstMs: Math.round(first!),
        firstServerTiming: serverTiming,
        minMs: Number(Math.min(...rest).toFixed(1)),
        medianMs: Number(median(rest).toFixed(1)),
      };
    }
    if (process.argv.includes('--rss')) result.rssMb = await rssMegabytes(child.pid);
    console.log(jsonOutput ? JSON.stringify(result) : JSON.stringify(result, null, 2));
  } finally {
    child.kill();
    await child.exited;
    await rm(scratch, { recursive: true, force: true });
  }
}

await main();
