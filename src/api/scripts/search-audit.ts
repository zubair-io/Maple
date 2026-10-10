#!/usr/bin/env bun
/**
 * Search audit replay (#4463): runs every query of a file through `GET /api/search` once with the
 * in-process engine selected and once with Meilisearch, through a running server's own settings
 * API, and prints per-query latency and how much the two top-30 lists share.
 *
 *   bun scripts/search-audit.ts --base-url http://localhost:3000 --dev-login
 *   bun scripts/search-audit.ts --base-url https://maple.example --token <owner access token> \
 *     [--queries tests/fixtures/search-audit/queries.txt] [--top 30] [--out audit.json]
 *
 * Switches the server's `search_engine` setting and puts the original back when it finishes, so
 * point it only at a server you mean to switch. Waits for the in-process engine to finish loading
 * before timing it, and marks any in-process answer the server served from Meilisearch instead.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';

type Engine = 'in-process' | 'meilisearch';

interface EngineStatus {
  engine: Engine;
  status: { phase: string; vectors: number; texts: number; textReady: boolean; error?: string };
}

export interface QueryRun {
  ms: number;
  ids: string[];
  servedInProcess: boolean;
  semanticHits: number | null;
}

export interface QueryComparison {
  query: string;
  inProcess: QueryRun;
  meilisearch: QueryRun;
  overlap: number;
}

const ENGINES: readonly Engine[] = ['in-process', 'meilisearch'];
const READY_POLL_MS = 2_000;
const DEFAULT_QUERIES = resolve(import.meta.dir, '../tests/fixtures/search-audit/queries.txt');

export function readQueries(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
}

export function overlapCount(a: readonly string[], b: readonly string[]): number {
  const other = new Set(b);
  return a.filter((id) => other.has(id)).length;
}

export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((x, y) => x - y);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!;
}

export function summaryLines(rows: readonly QueryComparison[], top: number): string[] {
  const line = (label: string, runs: QueryRun[]) => {
    const ms = runs.map((run) => run.ms);
    return `${label.padEnd(12)} median ${percentile(ms, 50).toFixed(0)} ms  p95 ${percentile(ms, 95).toFixed(0)} ms  max ${Math.max(...ms, 0).toFixed(0)} ms`;
  };
  const inProcess = rows.map((row) => row.inProcess);
  const fellBack = inProcess.filter((run) => !run.servedInProcess).length;
  const withSemantic = inProcess.filter((run) => (run.semanticHits ?? 0) > 0).length;
  const meanOverlap = rows.reduce((sum, row) => sum + row.overlap, 0) / Math.max(rows.length, 1);
  return [
    line('in-process', inProcess),
    line(
      'meilisearch',
      rows.map((row) => row.meilisearch),
    ),
    `mean top-${top} overlap ${meanOverlap.toFixed(1)} / ${top}`,
    `in-process answered ${rows.length - fellBack} / ${rows.length}; semantic hits on ${withSemantic} / ${rows.length}`,
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
  const call = async <T>(path: string, init: RequestInit = {}): Promise<T> => {
    const response = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    });
    if (!response.ok) throw new Error(`${init.method ?? 'GET'} ${path}: ${response.status}`);
    return (await response.json()) as T;
  };
  return {
    engine: () => call<EngineStatus>('/api/ai/search-engine/'),
    select: (engine: Engine) =>
      call<EngineStatus>('/api/ai/search-engine/', {
        method: 'PUT',
        body: JSON.stringify({ engine }),
      }),
    search: async (query: string, top: number): Promise<QueryRun> => {
      const started = performance.now();
      const body = await call<{
        results: Array<{ id: string }>;
        rankedBy?: { engine: string; semanticHits: number };
      }>(`/api/search?placeQuery=${encodeURIComponent(query)}&limit=${top}`);
      return {
        ms: performance.now() - started,
        ids: body.results.map((result) => result.id),
        servedInProcess: body.rankedBy?.engine === 'in-process',
        semanticHits: body.rankedBy?.semanticHits ?? null,
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
  const original = (await api.engine()).engine;
  const runs = new Map<Engine, QueryRun[]>();
  try {
    for (const engine of ENGINES) {
      await api.select(engine);
      if (engine === 'in-process') await waitUntilReady(api, opts.readyTimeoutMs);
      runs.set(engine, await runAll(api, queries, opts.top));
    }
  } finally {
    await api.select(original);
  }
  const rows: QueryComparison[] = queries.map((query, index) => {
    const inProcess = runs.get('in-process')![index]!;
    const meilisearch = runs.get('meilisearch')![index]!;
    return { query, inProcess, meilisearch, overlap: overlapCount(inProcess.ids, meilisearch.ids) };
  });
  console.log(`\n${'query'.padEnd(64)} in-proc   meili  overlap  semantic`);
  for (const row of rows) {
    const marker = row.inProcess.servedInProcess ? ' ' : '*';
    console.log(
      `${row.query.slice(0, 63).padEnd(64)}${row.inProcess.ms.toFixed(0).padStart(6)}${marker}${row.meilisearch.ms.toFixed(0).padStart(7)}${String(row.overlap).padStart(8)}${String(row.inProcess.semanticHits ?? '-').padStart(10)}`,
    );
  }
  console.log(`\n* answered by the Meilisearch path while in-process was selected\n`);
  for (const line of summaryLines(rows, opts.top)) console.log(line);
  if (opts.out) writeFileSync(opts.out, JSON.stringify({ top: opts.top, rows }, null, 2));
}

if (import.meta.main) await main();
