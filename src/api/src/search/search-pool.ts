/**
 * The API side of the search child (#4463): spawns it, mirrors the state it reports, sends it one
 * query at a time and restarts it when it dies.
 *
 * Every failure answers `null` rather than throwing — the child not running, still loading, dead
 * mid-query, a query queued past its deadline — and callers take that as "use the Meilisearch
 * path". A search never fails because the in-process engine is unavailable.
 *
 * One query in flight: a query already uses every thread the embedder and the vector scan are
 * given, so a second concurrent one would only slow both. Waiting queries keep their place and
 * give up at {@link QUERY_TIMEOUT_MS} from when they arrived.
 */

import { child as childLogger } from '../log.ts';
import {
  ChildProcessWorker,
  childScriptPath,
  DEFAULT_NATIVE_CHILD_NICE,
} from '../runtime/child-process-worker.ts';
import type { FusedSearchHit } from './search-engine-ffi.ts';
import type {
  SearchChildConfig,
  SearchChildResponse,
  SearchChildState,
} from './search-protocol.ts';

const log = childLogger('search-pool');
const SEARCH_CHILD_SCRIPT = childScriptPath(import.meta.url, './search.child.ts');

export const QUERY_TIMEOUT_MS = 2_000;
const MAX_WAITING = 32;
const RESTART_MIN_MS = 1_000;
const RESTART_MAX_MS = 5 * 60_000;
const HEALTHY_UPTIME_MS = 10 * 60_000;

export type SearchEnginePhase = 'stopped' | 'starting' | SearchChildState['phase'];

export interface SearchEngineStatus extends Omit<SearchChildState, 'phase'> {
  phase: SearchEnginePhase;
  restarts: number;
}

/** What the routes depend on; tests install a fake through {@link setInProcessSearchForTests}. */
export interface InProcessSearch {
  search(query: string, k: number): Promise<FusedSearchHit[] | null>;
  status(): SearchEngineStatus;
}

interface Job {
  id: number;
  query: string;
  k: number;
  settled: boolean;
  resolve: (hits: FusedSearchHit[] | null) => void;
  timer: ReturnType<typeof setTimeout>;
}

const STOPPED: SearchChildState = { phase: 'loading', vectors: 0, texts: 0, textReady: false };

export class SearchChildPool implements InProcessSearch {
  private worker: ChildProcessWorker | null = null;
  private wanted = false;
  private phase: SearchEnginePhase = 'stopped';
  private childState: SearchChildState = STOPPED;
  private restarts = 0;
  private restartMs = RESTART_MIN_MS;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private spawnedAt = 0;
  private nextId = 1;
  private current: Job | null = null;
  private readonly waiting: Job[] = [];

  constructor(
    private readonly config: () => SearchChildConfig,
    private readonly spawnChild: (script: string) => ChildProcessWorker = (script) =>
      new ChildProcessWorker(script, { nice: DEFAULT_NATIVE_CHILD_NICE, label: 'search' }),
  ) {}

  start(): void {
    this.wanted = true;
    if (this.worker || this.restartTimer) return;
    this.spawn();
  }

  stop(): void {
    this.wanted = false;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    this.worker?.terminate();
    this.worker = null;
    this.phase = 'stopped';
    this.childState = STOPPED;
    this.abandonAll();
  }

  status(): SearchEngineStatus {
    const { phase: _phase, ...counts } = this.childState;
    return { ...counts, phase: this.phase, restarts: this.restarts };
  }

  search(query: string, k: number): Promise<FusedSearchHit[] | null> {
    if (this.phase !== 'ready' || !this.worker) return Promise.resolve(null);
    if (this.waiting.length >= MAX_WAITING) return Promise.resolve(null);
    return new Promise((resolve) => {
      const job: Job = {
        id: this.nextId++,
        query,
        k,
        settled: false,
        resolve,
        timer: setTimeout(() => this.expire(job), QUERY_TIMEOUT_MS),
      };
      this.waiting.push(job);
      this.pump();
    });
  }

  private spawn(): void {
    this.restartTimer = null;
    if (!this.wanted) return;
    try {
      const worker = this.spawnChild(SEARCH_CHILD_SCRIPT);
      worker.addEventListener('message', (event) =>
        this.onMessage(worker, event.data as SearchChildResponse),
      );
      worker.addEventListener('error', (event) =>
        this.onDeath(worker, event.message ?? 'search child died'),
      );
      this.worker = worker;
      this.spawnedAt = Date.now();
      this.phase = 'starting';
      worker.postMessage({ type: 'start', config: this.config() });
    } catch (err) {
      this.onDeath(null, err instanceof Error ? err.message : String(err));
    }
  }

  private onMessage(worker: ChildProcessWorker, message: SearchChildResponse): void {
    if (worker !== this.worker || !message || typeof message !== 'object') return;
    if (message.type === 'state') {
      this.childState = message.state;
      this.phase = message.state.phase;
      if (message.state.phase === 'failed') this.onDeath(worker, message.state.error ?? 'failed');
      return;
    }
    const job = this.current;
    if (!job || job.id !== message.id) return;
    this.current = null;
    this.settle(job, message.ok ? (message.hits ?? []) : null);
    if (!message.ok) log.warn({ err: message.error }, 'in-process search query failed');
    this.pump();
  }

  private onDeath(worker: ChildProcessWorker | null, reason: string): void {
    if (worker !== this.worker) return;
    worker?.terminate();
    this.worker = null;
    this.abandonAll();
    if (Date.now() - this.spawnedAt >= HEALTHY_UPTIME_MS) this.restartMs = RESTART_MIN_MS;
    const delayMs = this.restartMs;
    this.restartMs = Math.min(this.restartMs * 2, RESTART_MAX_MS);
    this.phase = this.childState.phase === 'failed' ? 'failed' : 'starting';
    log.error({ reason, restartInMs: delayMs }, 'search child down — restarting');
    if (!this.wanted) return;
    this.restarts++;
    this.restartTimer = setTimeout(() => this.spawn(), delayMs);
  }

  private pump(): void {
    if (this.current || !this.worker) return;
    const next = this.waiting.shift();
    if (!next) return;
    this.current = next;
    this.worker.postMessage({ type: 'query', id: next.id, query: next.query, k: next.k });
  }

  private expire(job: Job): void {
    const queued = this.waiting.indexOf(job);
    if (queued >= 0) this.waiting.splice(queued, 1);
    this.settle(job, null);
  }

  private settle(job: Job, hits: FusedSearchHit[] | null): void {
    clearTimeout(job.timer);
    if (job.settled) return;
    job.settled = true;
    job.resolve(hits);
  }

  private abandonAll(): void {
    const jobs = [...(this.current ? [this.current] : []), ...this.waiting.splice(0)];
    this.current = null;
    for (const job of jobs) this.settle(job, null);
  }
}

let pool: SearchChildPool | null = null;
let testSearch: InProcessSearch | null = null;

/** The process-wide pool, created on first use with the config `search-child-config.ts` builds. */
export function searchChildPool(config: () => SearchChildConfig): SearchChildPool {
  pool ??= new SearchChildPool(config);
  return pool;
}

export function stopSearchChildPool(): void {
  pool?.stop();
}

/** The engine the routes query: the test fake when one is installed, else the pool if created. */
export function inProcessSearch(): InProcessSearch | null {
  return testSearch ?? pool;
}

export function setInProcessSearchForTests(search: InProcessSearch | null): void {
  testSearch = search;
}

/** Installs the process-wide pool, so a test can start and stop one whose child is a fake. */
export function setSearchChildPoolForTests(installed: SearchChildPool | null): void {
  pool?.stop();
  pool = installed;
}
