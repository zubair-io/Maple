// fallow-ignore-file complexity code-duplication
/**
 * Request serving versus background work: shows that the pipeline stages run outside the HTTP
 * process by timing the warm folder listing and a trivial route while the worker tier is busy.
 *
 *   bun scripts/bench-background-stages.ts [--temporal PATH] [--api-root DIR] [--photos 2000]
 *     [--jpeg-megapixels 12] [--runs 30] [--probe-seconds 30] [--settle-timeout 900]
 *     [--temporal-port N] [--json]
 *
 * Needs the `temporal` CLI and `ffmpeg`. `--temporal` names the CLI binary; without it the script
 * looks `temporal` up on PATH. The library is `--photos` generated files whose JPEG slots are
 * APFS clones of one real photo, so the exif, thumbnail and preview stages decode real pixels.
 * A Temporal dev server is started on non-default ports; it and every server the script booted
 * are stopped, and the scratch directories removed, however the run ends.
 *
 * States, in order: idle (the server booted without a worker tier, nothing indexed), busy (a
 * server with the worker tier on, while the stages and the discover sweep run), settled (the same
 * server once the exif, thumbnail and preview stages report nothing pending; stages that need
 * a model or an external service never drain and are not waited for). In each: `GET /api/health`
 * every 20 ms for `--probe-seconds`, the CPU the server and its children used meanwhile, the event-loop stalls
 * the server's own diagnostic (`MAPLE_DIAG_EVENTLOOP`, 10 ms threshold) logged, and the warm
 * folder listing's min / median over `--runs`.
 */
import { suffix } from 'bun:ffi';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  apiRoot,
  buildWorkspace,
  flag,
  freePort,
  jsonOutput,
  median,
  photoCount,
  processCpuSeconds,
  runs,
  SLUG,
} from './bench-library-server.ts';

const temporalBinary = flag('temporal', '') || Bun.which('temporal') || '';
const temporalPort = Number(flag('temporal-port', String(freePort())));
const probeSeconds = Number(flag('probe-seconds', '30'));
const settleTimeoutSeconds = Number(flag('settle-timeout', '900'));
const jpegMegapixels = Number(flag('jpeg-megapixels', '12'));
const PROBE_INTERVAL_MS = 20;

interface Workspace {
  root: string;
  library: string;
  sqlitePath: string;
}

interface Booted {
  pid: number;
  base: string;
  token: string;
  logFile: string;
  stop: () => Promise<void>;
}

async function bootServer(work: Workspace, workerTier: boolean, label: string): Promise<Booted> {
  const port = freePort();
  const logFile = join(work.root, `server-${label}.log`);
  const child = Bun.spawn(['bun', join(apiRoot, 'src/index.ts')], {
    cwd: work.root,
    env: {
      ...process.env,
      PORT: String(port),
      MAPLE_SQLITE_PATH: work.sqlitePath,
      MAPLE_NATIVE_LIB: join(apiRoot, 'native', `libraw_ffi.${suffix}`),
      MAPLE_DEV_AUTH: '1',
      MAPLE_INDEXER_AUTOSTART: workerTier ? '1' : '0',
      MAPLE_TEMPORAL_ADDRESS: `127.0.0.1:${temporalPort}`,
      MAPLE_JWT_SECRET: 'bench-secret-bench-secret-1234',
      MAPLE_BACKUP_TMP: join(work.root, 'chunks'),
      MAPLE_DIAG_EVENTLOOP: '1',
      MAPLE_DIAG_EVENTLOOP_MS: '10',
      MAPLE_DIAG_EVENTLOOP_SUMMARY: '0',
      LOG_LEVEL: flag('log-level', 'warn'),
    },
    stdout: Bun.file(logFile),
    stderr: Bun.file(`${logFile}.err`),
  });
  const base = `http://127.0.0.1:${port}`;
  const stopped = async (reason: string): Promise<never> => {
    child.kill();
    await child.exited;
    throw new Error(reason);
  };
  const healthy = () =>
    fetch(`${base}/api/health`)
      .then((r) => r.ok)
      .catch(() => false);
  const gone = () => child.exitCode !== null || child.signalCode !== null;
  for (let attempt = 0; attempt < 400 && !gone(); attempt++) {
    if (await healthy()) break;
    await Bun.sleep(50);
  }
  if (gone() || !(await healthy())) {
    return stopped(`the ${label} server did not become ready on port ${port}`);
  }
  const login = await fetch(`${base}/api/auth/dev-login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  })
    .then((r) => r.json() as Promise<{ access_token?: unknown }>)
    .catch(() => null);
  const token = login?.access_token;
  if (typeof token !== 'string') {
    return stopped(`the ${label} server refused the development sign-in`);
  }
  return {
    pid: child.pid,
    base,
    token,
    logFile,
    stop: async () => {
      child.kill();
      await child.exited;
    },
  };
}

async function descendants(rootPid: number): Promise<number[]> {
  const rows = (await Bun.$`ps -axo pid=,ppid=`.text())
    .split('\n')
    .map((line) => /^\s*(\d+)\s+(\d+)\s*$/.exec(line))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => ({ pid: Number(match[1]), ppid: Number(match[2]) }));
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
  found.delete(rootPid);
  return [...found];
}

async function cpuOf(pids: number[]): Promise<number> {
  const each = await Promise.all(pids.map((pid) => processCpuSeconds(pid).catch(() => 0)));
  return each.reduce((sum, seconds) => sum + seconds, 0);
}

const percentile = (sorted: number[], fraction: number) =>
  sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))]!;

async function healthProbe(base: string, seconds: number) {
  const timings: number[] = [];
  const end = performance.now() + seconds * 1000;
  while (performance.now() < end) {
    const started = performance.now();
    const response = await fetch(`${base}/api/health`);
    await response.arrayBuffer();
    timings.push(performance.now() - started);
    const wait = PROBE_INTERVAL_MS - (performance.now() - started);
    if (wait > 0) await Bun.sleep(wait);
  }
  const sorted = [...timings].sort((a, b) => a - b);
  return {
    samples: timings.length,
    minMs: Number(sorted[0]!.toFixed(2)),
    medianMs: Number(median(timings).toFixed(2)),
    p95Ms: Number(percentile(sorted, 0.95).toFixed(2)),
    p99Ms: Number(percentile(sorted, 0.99).toFixed(2)),
    maxMs: Number(sorted.at(-1)!.toFixed(2)),
  };
}

async function listingLatency(base: string, token: string) {
  const url = `${base}/api/folder/${SLUG}`;
  const headers = { Authorization: `Bearer ${token}` };
  for (let i = 0; i < 3; i++) await (await fetch(url, { headers })).arrayBuffer();
  const timings: number[] = [];
  let items = 0;
  for (let i = 0; i < runs; i++) {
    const started = performance.now();
    const response = await fetch(url, { headers });
    const body = (await response.json()) as { images?: unknown[] };
    timings.push(performance.now() - started);
    items = body.images?.length ?? 0;
    await Bun.sleep(100);
  }
  return {
    n: timings.length,
    minMs: Number(Math.min(...timings).toFixed(2)),
    medianMs: Number(median(timings).toFixed(2)),
    maxMs: Number(Math.max(...timings).toFixed(2)),
    imagesListed: items,
  };
}

interface StageRow {
  name: string;
  status: string;
  inFlight: number;
  pending: number;
}

async function stageRows(base: string, token: string): Promise<StageRow[]> {
  const response = await fetch(`${base}/api/workers/status`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return ((await response.json()) as { stages: StageRow[] }).stages;
}

const SETTLING_STAGES = new Set(['exif', 'thumb', 'preview']);

const summariseStages = (rows: StageRow[]) => {
  const settling = rows.filter((row) => SETTLING_STAGES.has(row.name));
  return {
    pending: settling.reduce((sum, row) => sum + row.pending, 0),
    inFlight: settling.reduce((sum, row) => sum + row.inFlight, 0),
    pendingElsewhere: rows
      .filter((row) => !SETTLING_STAGES.has(row.name))
      .reduce((sum, row) => sum + row.pending, 0),
  };
};

async function stallsSince(logFile: string, sinceMs: number) {
  const lines = (await readFile(logFile, 'utf8').catch(() => '')).split('\n');
  const lags = lines.flatMap((line) => {
    try {
      const entry = JSON.parse(line) as { msg?: string; lagMs?: number; time?: number };
      return entry.msg === 'event-loop stall' && (entry.time ?? 0) >= sinceMs ? [entry.lagMs!] : [];
    } catch {
      return [];
    }
  });
  return {
    stallsOver10Ms: lags.length,
    maxStallMs: lags.length > 0 ? Math.max(...lags) : 0,
  };
}

async function measureState(label: string, server: Booted, hasWorker: boolean) {
  const startedAt = Date.now();
  const children = await descendants(server.pid);
  const serverCpuBefore = await processCpuSeconds(server.pid);
  const childCpuBefore = await cpuOf(children);
  const probe = await healthProbe(server.base, probeSeconds);
  const serverCpu = (await processCpuSeconds(server.pid)) - serverCpuBefore;
  const childCpu = (await cpuOf(await descendants(server.pid))) - childCpuBefore;
  const stalls = await stallsSince(server.logFile, startedAt);
  const stagesDuringProbe = hasWorker
    ? summariseStages(await stageRows(server.base, server.token))
    : null;
  const listing = await listingLatency(server.base, server.token);
  return {
    state: label,
    healthProbeEvery20Ms: probe,
    serverHttpProcessCpuSeconds: Number(serverCpu.toFixed(2)),
    childProcessesCpuSeconds: Number(childCpu.toFixed(2)),
    eventLoopDiagnostic: stalls,
    stagesAfterProbe: stagesDuringProbe,
    listing,
  };
}

function portOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port });
    socket.once('connect', () => (socket.destroy(), resolve(true)));
    socket.once('error', () => resolve(false));
  });
}

async function startTemporal(root: string): Promise<{ stop: () => Promise<void> }> {
  const child = Bun.spawn(
    [
      temporalBinary,
      ...['server', 'start-dev', '--headless', '--ip', '127.0.0.1'],
      ...['--port', String(temporalPort), '--ui-port', String(freePort())],
      ...['--db-filename', join(root, 'temporal.db'), '--log-level', 'error'],
    ],
    { stdout: 'ignore', stderr: 'ignore' },
  );
  for (let attempt = 0; attempt < 300; attempt++) {
    if (await portOpen(temporalPort)) {
      return {
        stop: async () => {
          child.kill();
          await child.exited;
        },
      };
    }
    await Bun.sleep(200);
  }
  child.kill();
  throw new Error('the Temporal dev server did not open its port within 60 s');
}

async function realPhoto(root: string): Promise<string> {
  const height = Math.round(Math.sqrt((jpegMegapixels * 1e6) / 1.5));
  const width = Math.round(height * 1.5);
  const out = join(root, 'real.jpg');
  const encode = Bun.spawn(
    [
      'ffmpeg',
      ...['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=size=${width}x${height}`],
      ...['-vf', 'noise=alls=25:allf=t', '-frames:v', '1', '-q:v', '3', out],
    ],
    { stdout: 'inherit', stderr: 'inherit' },
  );
  if ((await encode.exited) !== 0) throw new Error('ffmpeg could not write the source photo');
  return out;
}

async function main() {
  if (!temporalBinary)
    throw new Error('no Temporal CLI: pass --temporal PATH or put `temporal` on PATH');
  const work = await buildWorkspace();
  const scratch = await mkdtemp(join(tmpdir(), 'maple-bench-stages-'));
  try {
    const temporal = await startTemporal(scratch);
    try {
      await measureAllStates(work, scratch);
    } finally {
      await temporal.stop();
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
    await rm(work.root, { recursive: true, force: true });
  }
}

async function measureAllStates(work: Workspace, scratch: string) {
  const photo = await realPhoto(scratch);
  const jpgs = (await Bun.$`ls ${work.library}`.text())
    .split('\n')
    .filter((n) => n.endsWith('.jpg'));
  await Promise.all(jpgs.map((name) => Bun.$`cp -c ${photo} ${join(work.library, name)}`.quiet()));

  const idleServer = await bootServer(work, false, 'idle');
  const idleState = await measureState(
    'idle: no worker tier, library not indexed',
    idleServer,
    false,
  ).finally(() => idleServer.stop());

  const busyServer = await bootServer(work, true, 'busy');
  const busy = await (async () => {
    try {
      const bootedAt = Date.now();
      let sawWork = false;
      for (let waited = 0; waited < 180 && !sawWork; waited++) {
        await Bun.sleep(1000);
        const rows = await stageRows(busyServer.base, busyServer.token).catch(() => []);
        sawWork = summariseStages(rows).inFlight > 0;
      }
      const busyState = await measureState(
        'busy: worker tier running stages and discover',
        busyServer,
        true,
      );

      const deadline = Date.now() + settleTimeoutSeconds * 1000;
      let settled = false;
      while (Date.now() < deadline && !settled) {
        await Bun.sleep(5000);
        const summary = summariseStages(await stageRows(busyServer.base, busyServer.token));
        settled = summary.pending === 0 && summary.inFlight === 0 && Date.now() - bootedAt > 60_000;
      }
      const settledState = await measureState(
        settled ? 'settled: worker tier idle, nothing pending' : 'not settled at the timeout',
        busyServer,
        true,
      );
      return { sawWork, settled, states: [busyState, settledState] };
    } finally {
      await busyServer.stop();
    }
  })();

  const output = {
    apiRoot,
    photos: photoCount,
    jpegClones: jpgs.length,
    jpegMegapixels,
    runs,
    probeSeconds,
    workAppeared: busy.sawWork,
    settledBeforeTimeout: busy.settled,
    states: [idleState, ...busy.states],
  };
  console.log(jsonOutput ? JSON.stringify(output) : JSON.stringify(output, null, 2));
}

await main();
