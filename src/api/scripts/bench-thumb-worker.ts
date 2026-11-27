// fallow-ignore-file complexity code-duplication
/**
 * Thumbnail-cache Worker benchmark: runs `src/cloudflare` in the local runtime (`wrangler dev
 * --local`, with a local R2 bucket) in front of a stub origin, and times each serving path from
 * outside over `--requests` sequential requests.
 *
 *   bun scripts/bench-thumb-worker.ts [--worker-dir src/cloudflare] [--requests 200]
 *     [--thumb-bytes 18000] [--json]
 *
 * Prepare the worker directory once, from `src/cloudflare`:
 *   npm ci
 *   cp wrangler.jsonc.example wrangler.jsonc
 *   npm run cf-typegen
 * Those three leave `node_modules/`, `wrangler.jsonc` and `worker-configuration.d.ts`, all
 * gitignored. The script itself keeps the local R2 bucket in a temp directory it removes, but
 * `wrangler dev` writes its bundle under `.wrangler/` in the worker directory, also gitignored and
 * left behind. Paths: stored hit, conditional 304, versioned hit, versioned
 * miss (token differs, origin fetch, store), cold miss (new key, origin fetch, store), a
 * non-cacheable origin answer, plus two floors: the stub origin hit directly and a request the
 * Worker rejects with 401. CPU per request is the runtime process's CPU time (from `ps`, 10 ms
 * resolution) divided by the request count. The script turns off wrangler's usage metrics; the
 * tool may still check for updates over the network, and the benchmark itself only talks to 127.0.0.1.
 */
import { createHmac } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { flag, freePort, jsonOutput, median, processCpuSeconds } from './bench-library-server.ts';

const workerDir = resolve(flag('worker-dir', join(import.meta.dir, '../../cloudflare')));
const requests = Number(flag('requests', '200'));
const thumbBytes = Number(flag('thumb-bytes', '18000'));
const warmup = 20;
const SECRET = 'bench-worker-secret-bench-worker-1234';
const STORED_VERSION = 'ver-a';

const base64Url = (value: Buffer | string) => Buffer.from(value).toString('base64url');

function bearerToken(): string {
  const now = Math.floor(Date.now() / 1000);
  const head = base64Url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = base64Url(
    JSON.stringify({
      sub: 'bench',
      role: 'owner',
      email: 'bench@example.com',
      iat: now,
      exp: now + 3600,
    }),
  );
  const signature = createHmac('sha256', SECRET).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${signature}`;
}

interface Origin {
  port: number;
  hits: () => number;
  stop: () => void;
}

function startOrigin(): Origin {
  const body = new Uint8Array(thumbBytes).fill(97);
  let hits = 0;
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(request) {
      hits += 1;
      const name = new URL(request.url).pathname.split('/').pop() ?? '';
      const headers: Record<string, string> = {
        'content-type': 'image/avif',
        'x-maple-thumb-version': STORED_VERSION,
        etag: '"origin-etag"',
      };
      if (name.startsWith('nocache-')) headers['x-maple-cacheable'] = '0';
      return new Response(body, { status: 200, headers });
    },
  });
  return { port: server.port!, hits: () => hits, stop: () => void server.stop(true) };
}

async function descendantsOf(rootPid: number): Promise<{ pid: number; command: string }[]> {
  const rows = (await Bun.$`ps -axo pid=,ppid=,comm=`.text())
    .split('\n')
    .map((line) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => ({ pid: Number(match[1]), ppid: Number(match[2]), command: match[3]! }));
  const found = new Set<number>([rootPid]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const row of rows) {
      if (found.has(row.ppid) && !found.has(row.pid)) {
        found.add(row.pid);
        grew = true;
      }
    }
  }
  return rows.filter((row) => found.has(row.pid) && row.pid !== rootPid);
}

async function waitForWorker(base: string): Promise<void> {
  for (let attempt = 0; attempt < 600; attempt++) {
    const up = await fetch(`${base}/api/thumb/probe/x.jpg`)
      .then((response) => response.status === 401)
      .catch(() => false);
    if (up) return;
    await Bun.sleep(100);
  }
  throw new Error('the Worker did not start answering within 60 s');
}

interface PathSpec {
  name: string;
  url: (i: number) => string;
  headers: () => Record<string, string>;
  status: number;
  originShouldBeHit: boolean;
  authorized?: boolean;
}

async function timePath(
  spec: PathSpec,
  origin: Origin,
  cpuPids: { pid: number; command: string }[],
) {
  const fire = async (i: number) => {
    const response = await fetch(spec.url(i), { headers: spec.headers() });
    await response.arrayBuffer();
    if (response.status !== spec.status) {
      throw new Error(`${spec.name}: expected ${spec.status}, got ${response.status}`);
    }
    return response;
  };
  for (let i = 0; i < warmup; i++) await fire(-1 - i);
  const originBefore = origin.hits();
  const cpuBefore = await Promise.all(cpuPids.map((row) => processCpuSeconds(row.pid)));
  const timings: number[] = [];
  let cacheControl: string | null = null;
  for (let i = 0; i < requests; i++) {
    const started = performance.now();
    const response = await fire(i);
    timings.push(performance.now() - started);
    cacheControl = response.headers.get('cache-control');
  }
  const cpuAfter = await Promise.all(cpuPids.map((row) => processCpuSeconds(row.pid)));
  const cpuByProcess = cpuPids.map((row, i) => ({
    command: row.command.split('/').pop()!,
    perRequestMs: Number((((cpuAfter[i]! - cpuBefore[i]!) * 1000) / requests).toFixed(3)),
  }));
  const sorted = [...timings].sort((a, b) => a - b);
  return {
    path: spec.name,
    requests,
    wallMs: {
      min: Number(sorted[0]!.toFixed(3)),
      median: Number(median(timings).toFixed(3)),
      p95: Number(sorted[Math.floor(sorted.length * 0.95)]!.toFixed(3)),
    },
    originRequests: origin.hits() - originBefore,
    expectedOriginRequests: spec.originShouldBeHit ? requests : 0,
    cacheControl,
    cpuPerRequestMs: cpuByProcess,
  };
}

async function main() {
  const origin = startOrigin();
  const persist = await mkdtemp(join(tmpdir(), 'maple-bench-worker-'));
  const port = freePort();
  const wrangler = Bun.spawn(
    [
      'node',
      join(workerDir, 'node_modules/wrangler/bin/wrangler.js'),
      ...['dev', '--local', '--ip', '127.0.0.1', '--port', String(port)],
      ...['--inspector-port', String(freePort()), '--persist-to', persist, '--log-level', 'warn'],
      ...[
        '--var',
        `JWT_SECRET:${SECRET}`,
        '--var',
        `ORIGIN_API_BASE_URL:http://127.0.0.1:${origin.port}`,
      ],
    ],
    {
      cwd: workerDir,
      env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
      stdout: 'ignore',
      stderr: 'inherit',
    },
  );
  const base = `http://127.0.0.1:${port}`;
  let descendants: { pid: number; command: string }[] = [];
  try {
    await waitForWorker(base);
    const auth = () => ({ authorization: `Bearer ${bearerToken()}` });
    const token = auth();
    const seed = async (name: string) => {
      const response = await fetch(`${base}/api/thumb/main/${name}`, { headers: token });
      await response.arrayBuffer();
      return response.headers.get('etag');
    };
    await seed('hit.jpg');
    await seed('vmiss.jpg');
    await Bun.sleep(500);
    const stored = await fetch(`${base}/api/thumb/main/hit.jpg`, { headers: token });
    await stored.arrayBuffer();
    const etag = stored.headers.get('etag')!;

    descendants = await descendantsOf(wrangler.pid);
    const runtimeOnly = descendants.filter((row) => row.command.includes('workerd'));
    const cpuPids = runtimeOnly.length > 0 ? runtimeOnly : descendants;

    const specs: PathSpec[] = [
      {
        name: 'stored hit (200 from R2)',
        url: () => `${base}/api/thumb/main/hit.jpg`,
        headers: auth,
        status: 200,
        originShouldBeHit: false,
      },
      {
        name: 'conditional 304 (If-None-Match matches)',
        url: () => `${base}/api/thumb/main/hit.jpg`,
        headers: () => ({ ...auth(), 'if-none-match': etag }),
        status: 304,
        originShouldBeHit: false,
      },
      {
        name: `versioned hit (?v=${STORED_VERSION} matches)`,
        url: () => `${base}/api/thumb/main/hit.jpg?v=${STORED_VERSION}`,
        headers: auth,
        status: 200,
        originShouldBeHit: false,
      },
      {
        name: 'versioned miss (?v=ver-b differs: origin fetch + store)',
        url: () => `${base}/api/thumb/main/vmiss.jpg?v=ver-b`,
        headers: auth,
        status: 200,
        originShouldBeHit: true,
      },
      {
        name: 'cold miss (new key: origin fetch + store)',
        url: (i) => `${base}/api/thumb/main/cold-${i}.jpg`,
        headers: auth,
        status: 200,
        originShouldBeHit: true,
      },
      {
        name: 'non-cacheable origin answer (x-maple-cacheable: 0)',
        url: () => `${base}/api/thumb/main/nocache-1.jpg`,
        headers: auth,
        status: 200,
        originShouldBeHit: true,
      },
      {
        name: 'floor: 401 rejected by the Worker (no R2, no origin)',
        url: () => `${base}/api/thumb/main/hit.jpg`,
        headers: () => ({}),
        status: 401,
        originShouldBeHit: false,
      },
    ];
    const results = [];
    for (const spec of specs) results.push(await timePath(spec, origin, cpuPids));

    const direct = await timePath(
      {
        name: 'floor: stub origin hit directly (no Worker)',
        url: () => `http://127.0.0.1:${origin.port}/api/thumb/main/hit.jpg`,
        headers: () => ({}),
        status: 200,
        originShouldBeHit: true,
      },
      origin,
      cpuPids,
    );
    const output = {
      workerDir,
      requests,
      warmup,
      thumbBytes,
      runtime: descendants.map((row) => row.command),
      results: [...results, direct],
    };
    console.log(jsonOutput ? JSON.stringify(output) : JSON.stringify(output, null, 2));
  } finally {
    const live = await descendantsOf(wrangler.pid).catch(() => descendants);
    wrangler.kill();
    await wrangler.exited;
    for (const row of live) {
      try {
        process.kill(row.pid, 'SIGTERM');
      } catch {
        /* already gone */
      }
    }
    origin.stop();
    await rm(persist, { recursive: true, force: true });
  }
}

await main();
