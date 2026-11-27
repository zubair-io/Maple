// fallow-ignore-file complexity code-duplication
/**
 * Cost of idle connected clients: boots the real server and, for each client count, holds that many
 * clients on `GET /api/events` (WebSocket) and on `GET /api/changes/subscribe` (server-sent events)
 * for `--hold` seconds, then times the warm folder listing with the same clients still connected.
 *
 *   bun scripts/bench-event-clients.ts [--api-root DIR] [--photos 2000] [--clients 0,1,50,200]
 *     [--endpoints events,changes] [--hold 30] [--runs 30] [--json] [--server-stderr]
 *
 * Per scenario: server CPU seconds used while the clients sat idle (from `ps`, 10 ms resolution),
 * frames and bytes delivered per client per second, server resident memory before and at the end,
 * and the listing's min / median latency over `--runs` requests. Each scenario boots a fresh server
 * against the same generated library so one scenario's heap does not leak into the next.
 */
import { rm } from 'node:fs/promises';
import {
  apiRoot,
  bootServer,
  buildWorkspace,
  flag,
  jsonOutput,
  median,
  photoCount,
  processCpuSeconds,
  runs,
  SLUG,
} from './bench-library-server.ts';

const clientCounts = flag('clients', '0,1,50,200').split(',').map(Number);
const holdSeconds = Number(flag('hold', '30'));
const endpoints = flag('endpoints', 'events,changes').split(',');

interface Counters {
  frames: number;
  bytes: number;
  byType: Record<string, number>;
}

interface Connection {
  counters: Counters;
  close: () => void;
}

const newCounters = (): Counters => ({ frames: 0, bytes: 0, byType: {} });

function frameType(text: string): string {
  const match = /"type":"([a-z-]+)"/.exec(text.slice(0, 80));
  return match?.[1] ?? 'other';
}

async function openEventsSocket(base: string, token: string): Promise<Connection> {
  const counters = newCounters();
  const socket = new WebSocket(`${base.replace('http', 'ws')}/api/events`);
  socket.onmessage = (event) => {
    const text = String(event.data);
    counters.frames += 1;
    counters.bytes += Buffer.byteLength(text);
    const type = frameType(text);
    counters.byType[type] = (counters.byType[type] ?? 0) + 1;
  };
  await new Promise<void>((resolve, reject) => {
    socket.onopen = () => resolve();
    socket.onerror = () => reject(new Error('events socket failed to open'));
  });
  socket.send(JSON.stringify({ type: 'auth', token }));
  return { counters, close: () => socket.close() };
}

async function openChangesStream(base: string, token: string): Promise<Connection> {
  const counters = newCounters();
  const abort = new AbortController();
  const response = await fetch(`${base}/api/changes/subscribe?since=0`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: abort.signal,
  });
  if (response.status !== 200) throw new Error(`changes/subscribe answered ${response.status}`);
  const reader = response.body!.getReader();
  void (async () => {
    try {
      for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
        counters.bytes += chunk.value.byteLength;
        const text = new TextDecoder().decode(chunk.value);
        const frames = text.split('\n\n').filter((part) => part.length > 0);
        counters.frames += frames.length;
        for (const frame of frames) {
          const type = frame.startsWith(':') ? frame.slice(2) : (frame.split('\n')[0] ?? 'other');
          counters.byType[type] = (counters.byType[type] ?? 0) + 1;
        }
      }
    } catch {
      /* closed by the benchmark */
    }
  })();
  return { counters, close: () => abort.abort() };
}

async function residentMb(pid: number): Promise<number> {
  return Number((await Bun.$`ps -o rss= -p ${pid}`.text()).trim()) / 1024;
}

async function listingLatency(base: string, token: string) {
  const url = `${base}/api/folder/${SLUG}`;
  const headers = { Authorization: `Bearer ${token}` };
  for (let i = 0; i < 3; i++) await (await fetch(url, { headers })).arrayBuffer();
  const timings: number[] = [];
  for (let i = 0; i < runs; i++) {
    const started = performance.now();
    const response = await fetch(url, { headers });
    await response.arrayBuffer();
    timings.push(performance.now() - started);
    if (response.status !== 200) throw new Error(`listing answered ${response.status}`);
    await Bun.sleep(100);
  }
  return {
    minMs: Number(Math.min(...timings).toFixed(2)),
    medianMs: Number(median(timings).toFixed(2)),
    n: timings.length,
  };
}

async function scenario(
  work: Awaited<ReturnType<typeof buildWorkspace>>,
  endpoint: 'events' | 'changes',
  count: number,
) {
  const server = await bootServer(work);
  const open = endpoint === 'events' ? openEventsSocket : openChangesStream;
  const connections: Connection[] = [];
  try {
    for (let i = 0; i < count; i++) connections.push(await open(server.base, server.token));
    await Bun.sleep(3000);
    const memoryBefore = await residentMb(server.child.pid);
    const countersBefore = connections.map((c) => ({
      ...c.counters,
      byType: { ...c.counters.byType },
    }));
    const cpuBefore = await processCpuSeconds(server.child.pid);
    const started = performance.now();
    await Bun.sleep(holdSeconds * 1000);
    const seconds = (performance.now() - started) / 1000;
    const cpuUsed = (await processCpuSeconds(server.child.pid)) - cpuBefore;
    const frames = connections.reduce(
      (sum, c, i) => sum + c.counters.frames - countersBefore[i]!.frames,
      0,
    );
    const bytes = connections.reduce(
      (sum, c, i) => sum + c.counters.bytes - countersBefore[i]!.bytes,
      0,
    );
    const byType: Record<string, number> = {};
    connections.forEach((c, i) => {
      for (const [type, n] of Object.entries(c.counters.byType)) {
        byType[type] = (byType[type] ?? 0) + n - (countersBefore[i]!.byType[type] ?? 0);
      }
    });
    const memoryAfterHold = await residentMb(server.child.pid);
    const listing = await listingLatency(server.base, server.token);
    return {
      endpoint,
      clients: count,
      framesOnConnectPerClient: Number(
        (countersBefore.reduce((sum, c) => sum + c.frames, 0) / Math.max(count, 1)).toFixed(2),
      ),
      holdSeconds: Number(seconds.toFixed(1)),
      serverCpuSeconds: Number(cpuUsed.toFixed(2)),
      cpuMillisecondsPerClientPerSecond:
        count > 0 ? Number(((cpuUsed * 1000) / count / seconds).toFixed(3)) : null,
      framesPerClientPerSecond: count > 0 ? Number((frames / count / seconds).toFixed(3)) : null,
      bytesPerClientPerSecond: count > 0 ? Number((bytes / count / seconds).toFixed(1)) : null,
      bytesPerFrame: frames > 0 ? Number((bytes / frames).toFixed(1)) : null,
      framesByType: byType,
      residentMbBefore: Number(memoryBefore.toFixed(1)),
      residentMbAfterHold: Number(memoryAfterHold.toFixed(1)),
      listing,
    };
  } finally {
    connections.forEach((c) => c.close());
    server.child.kill();
    await server.child.exited;
  }
}

async function main() {
  const work = await buildWorkspace();
  try {
    const results = [];
    for (const endpoint of endpoints as ('events' | 'changes')[]) {
      for (const count of clientCounts) {
        if (count === 0 && endpoint === 'changes') continue;
        results.push(await scenario(work, endpoint, count));
      }
    }
    const output = { apiRoot, photos: photoCount, holdSeconds, runs, results };
    console.log(jsonOutput ? JSON.stringify(output) : JSON.stringify(output, null, 2));
  } finally {
    await rm(work.root, { recursive: true, force: true });
  }
}

await main();
