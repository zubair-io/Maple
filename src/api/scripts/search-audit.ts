#!/usr/bin/env bun
/**
 * Search audit replay (#4463): runs every query of a file through `GET /api/search` against a
 * running server and prints per-query latency, whether the in-process engine answered, and how
 * many of the returned results its vector leg found.
 *
 *   bun scripts/search-audit.ts --base-url http://localhost:3000 --dev-login
 *   bun scripts/search-audit.ts --base-url https://maple.example --token <owner access token> \
 *     [--queries tests/fixtures/search-audit/queries.txt] [--top 30] [--out audit.json]
 *
 * Waits for the in-process engine to finish loading before timing it, and marks any answer the
 * server served from the database full-text path instead. When the server reports a
 * `Server-Timing` header (#4503), the median of each phase is printed beside the client-side
 * latency, so the time spent outside the engine has a name.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';

interface EngineStatus {
  status: { phase: string; vectors: number; texts: number; textReady: boolean; error?: string };
}

export interface QueryRun {
  query: string;
  ms: number;
  servedInProcess: boolean;
  semanticHits: number | null;
  /** Server-side milliseconds per phase, from `Server-Timing`; empty when the server sends none. */
  phases: Record<string, number>;
}

const READY_POLL_MS = 2_000;
const DEFAULT_QUERIES = resolve(import.meta.dir, '../tests/fixtures/search-audit/queries.txt');

export function readQueries(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
}

export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((x, y) => x - y);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!;
}

/** `Server-Timing` → phase → milliseconds; entries without a `dur` are skipped. */
export function parseServerTiming(header: string | null): Record<string, number> {
  const pairs = (header ?? '')
    .split(',')
    .map((entry) => /^\s*([^;\s]+)\s*;(?:.*;)?\s*dur=([\d.]+)/.exec(entry))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => [match[1]!, Number(match[2])] as const)
    .filter(([, ms]) => Number.isFinite(ms));
  return Object.fromEntries(pairs);
}

/** The median of every phase the server reported, in first-seen order. */
function phaseLines(runs: readonly QueryRun[]): string[] {
  const names = [...new Set(runs.flatMap((run) => Object.keys(run.phases)))];
  if (names.length === 0) return [];
  const medians = names.map((name) => {
    const values = runs.flatMap((run) => (name in run.phases ? [run.phases[name]!] : []));
    return `${name} ${percentile(values, 50).toFixed(1)}`;
  });
  return [`server phases (median ms): ${medians.join('  ')}`];
}

export function summaryLines(runs: readonly QueryRun[]): string[] {
  const ms = runs.map((run) => run.ms);
  const fellBack = runs.filter((run) => !run.servedInProcess).length;
  const withSemantic = runs.filter((run) => (run.semanticHits ?? 0) > 0).length;
  return [
    `median ${percentile(ms, 50).toFixed(0)} ms  p95 ${percentile(ms, 95).toFixed(0)} ms  max ${Math.max(...ms, 0).toFixed(0)} ms`,
    `in-process answered ${runs.length - fellBack} / ${runs.length}; semantic hits on ${withSemantic} / ${runs.length}`,
    ...phaseLines(runs),
  ];
}

function options() {
  const { values } = parseArgs({
    options: {
      'base-url': { type: 'string', default: 'http://localhost:3000' },
      token: { type: 'string' },
      'dev-login': { type: 'boolean', default: false },
      queries: { type: 'string', default: DEFAULT_QUERIES },
      top: { type: 'string', default: '30' },
      out: { type: 'string' },
      'ready-timeout': { type: 'string', default: '1800' },
    },
  });
  return {
    baseUrl: values['base-url']!.replace(/\/+$/, ''),
    token: values.token,
    devLogin: values['dev-login']!,
    queries: values.queries!,
    top: Number(values.top),
    out: values.out,
    readyTimeoutMs: Number(values['ready-timeout']) * 1000,
  };
}

async function accessToken(baseUrl: string, token: string | undefined, devLogin: boolean) {
  if (token) return token;
  if (!devLogin) throw new Error('pass --token <owner access token> or --dev-login');
  const response = await fetch(`${baseUrl}/api/auth/dev-login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  if (!response.ok) throw new Error(`dev-login failed: ${response.status}`);
  return ((await response.json()) as { access_token: string }).access_token;
}

function client(baseUrl: string, token: string) {
  const respond = async (path: string, init: RequestInit = {}): Promise<Response> => {
    const response = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    });
    if (!response.ok) throw new Error(`${init.method ?? 'GET'} ${path}: ${response.status}`);
    return response;
  };
  const call = async <T>(path: string, init: RequestInit = {}): Promise<T> =>
    (await (await respond(path, init)).json()) as T;
  return {
    engine: () => call<EngineStatus>('/api/ai/search-engine/'),
    search: async (query: string, top: number): Promise<QueryRun> => {
      const started = performance.now();
      const response = await respond(
        `/api/search?placeQuery=${encodeURIComponent(query)}&limit=${top}`,
      );
      const body = (await response.json()) as {
        rankedBy?: { engine: string; semanticHits: number };
      };
      return {
        query,
        ms: performance.now() - started,
        servedInProcess: body.rankedBy?.engine === 'in-process',
        semanticHits: body.rankedBy?.semanticHits ?? null,
        phases: parseServerTiming(response.headers.get('server-timing')),
      };
    },
  };
}

async function waitUntilReady(api: ReturnType<typeof client>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { status } = await api.engine();
    if (status.phase === 'ready' && status.textReady) {
      console.log(`in-process engine ready: ${status.vectors} vectors, ${status.texts} texts`);
      return;
    }
    if (Date.now() > deadline)
      throw new Error(`in-process engine not ready: ${JSON.stringify(status)}`);
    console.log(`waiting for the in-process engine (${status.phase}, ${status.vectors} vectors)…`);
    await Bun.sleep(READY_POLL_MS);
  }
}

async function runAll(api: ReturnType<typeof client>, queries: string[], top: number) {
  await api.search(queries[0]!, top);
  const runs: QueryRun[] = [];
  for (const query of queries) runs.push(await api.search(query, top));
  return runs;
}

async function main(): Promise<void> {
  const opts = options();
  const queries = readQueries(readFileSync(opts.queries, 'utf-8'));
  const api = client(opts.baseUrl, await accessToken(opts.baseUrl, opts.token, opts.devLogin));
  await waitUntilReady(api, opts.readyTimeoutMs);
  const runs = await runAll(api, queries, opts.top);
  console.log(`\n${'query'.padEnd(64)}    ms  semantic`);
  for (const run of runs) {
    const marker = run.servedInProcess ? ' ' : '*';
    console.log(
      `${run.query.slice(0, 63).padEnd(64)}${run.ms.toFixed(0).padStart(6)}${marker}${String(run.semanticHits ?? '-').padStart(8)}`,
    );
  }
  console.log(`\n* answered by the database full-text path\n`);
  for (const line of summaryLines(runs)) console.log(line);
  if (opts.out) writeFileSync(opts.out, JSON.stringify({ top: opts.top, runs }, null, 2));
}

if (import.meta.main) await main();
