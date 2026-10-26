/**
 * The API side of the search child (#4463): spawns it, mirrors the state it reports, sends it one
 * request at a time and restarts it when it dies.
 *
 * Every query failure answers `null` rather than throwing — the child not running, still loading,
 * dead mid-query, a query queued past its deadline — and callers take that as "use the database
 * path". A search never fails because the in-process engine is unavailable.
 *
 * One request in flight: a query already uses every thread the embedder and the vector scan are
 * given, so a second concurrent one would only slow both. Waiting queries keep their place and
 * give up at {@link QUERY_TIMEOUT_MS} from when they arrived. An in-flight query that outlives
 * that deadline means a wedged native call that would hold the queue forever, so the child is
 * killed and restarted exactly as if it had crashed, and everything waiting falls back at once.
 *
 * The `embed` stage's document batches (#5445) share the queue behind every waiting query, so a
 * search waits for at most the one batch in flight; the stage keeps its batches small for that.
 */

import { child as childLogger } from '../log.ts';
import {
  ChildProcessWorker,
  childScriptPath,
  DEFAULT_NATIVE_CHILD_NICE,
} from '../runtime/child-process-worker.ts';
import { vectorFromBase64 } from '../enrichment/vector-codec.ts';
import type { FusedSearchHit } from './search-engine-ffi.ts';
import type {
  EmbedOutcome,
  EmbedResponse,
  QueryResponse,
  SearchChildConfig,
  SearchChildResponse,
  SearchChildState,
} from './search-protocol.ts';

const log = childLogger('search-pool');
const SEARCH_CHILD_SCRIPT = childScriptPath(import.meta.url, './search.child.ts');

export const QUERY_TIMEOUT_MS = 2_000;
/** A document batch still running after this is a wedged native call, like a late query. */
export const EMBED_TIMEOUT_MS = 120_000;
const MAX_WAITING = 32;
const MAX_EMBED_WAITING = 4;
const RESTART_MIN_MS = 1_000;
const RESTART_MAX_MS = 5 * 60_000;
const HEALTHY_UPTIME_MS = 10 * 60_000;

export type SearchEnginePhase = 'stopped' | 'starting' | SearchChildState['phase'];

export interface SearchEngineStatus extends Omit<SearchChildState, 'phase'> {
  phase: SearchEnginePhase;
  restarts: number;
}

/** What a search ranks with: the child's fused top `k`, or null when it cannot answer. */
export interface InProcessRanker {
  search(query: string, k: number): Promise<FusedSearchHit[] | null>;
}

/** What the routes depend on; tests install a fake through {@link setInProcessSearchForTests}. */
export interface InProcessSearch extends InProcessRanker {
  status(): SearchEngineStatus;
}

interface QueryJob {
  kind: 'query';
  id: number;
  query: string;
  k: number;
  settled: boolean;
  resolve: (hits: FusedSearchHit[] | null) => void;
  /** Falls the caller back to the database {@link QUERY_TIMEOUT_MS} after it asked. */
  giveUp: ReturnType<typeof setTimeout>;
  /** Restarts the child when the query itself runs past {@link QUERY_TIMEOUT_MS}. */
  wedged: ReturnType<typeof setTimeout> | null;
}

interface EmbedJob {
  kind: 'embed';
  id: number;
  texts: string[];
  settled: boolean;
  resolve: (outcome: EmbedOutcome) => void;
  wedged: ReturnType<typeof setTimeout> | null;
}

type Job = QueryJob | EmbedJob;

const STOPPED: SearchChildState = { phase: 'loading', vectors: 0, texts: 0, textReady: false };

const notEmbedding = (error: string): EmbedOutcome => ({ ok: false, waiting: true, error });

function embedOutcome(message: EmbedResponse, expected: number): EmbedOutcome {
  if (!message.ok) {
    return { ok: false, waiting: message.loading === true, error: message.error ?? 'embed failed' };
  }
  const vectors = (message.vectors ?? []).map(vectorFromBase64);
  return vectors.length === expected
    ? { ok: true, vectors }
    : {
        ok: false,
        waiting: false,
        error: `the engine returned ${vectors.length} vectors for ${expected} texts`,
      };
}

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
  private readonly waiting: QueryJob[] = [];
  private readonly embedsWaiting: EmbedJob[] = [];

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
      const job: QueryJob = {
        kind: 'query',
        id: this.nextId++,
        query,
        k,
        settled: false,
        resolve,
        giveUp: setTimeout(() => this.giveUp(job), QUERY_TIMEOUT_MS),
        wedged: null,
      };
      this.waiting.push(job);
      this.pump();
    });
  }

  /**
   * Document vectors with the query model, in input order; see {@link EmbedOutcome}. Sent only
   * once the child has loaded its model and vectors: opening the engine is one blocking native
   * call that can include the model's first download, which no batch deadline may cut short.
   */
  embed(texts: readonly string[]): Promise<EmbedOutcome> {
    if (this.phase === 'failed') {
      const reason = this.childState.error ?? 'unknown error';
      return Promise.resolve(notEmbedding(`the search engine could not start: ${reason}`));
    }
    if (!this.worker) return Promise.resolve(notEmbedding('the search engine is not running'));
    if (this.phase !== 'ready' && this.phase !== 'empty') {
      return Promise.resolve(notEmbedding('the search engine is still loading'));
    }
    if (this.embedsWaiting.length >= MAX_EMBED_WAITING) {
      return Promise.resolve(notEmbedding('the search engine is busy embedding'));
    }
    return new Promise((resolve) => {
      this.embedsWaiting.push({
        kind: 'embed',
        id: this.nextId++,
        texts: [...texts],
        settled: false,
        resolve,
        wedged: null,
      });
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
    if (worker !== this.worker || !message) return;
    if (message.type === 'state') this.onState(worker, message.state);
    else if (message.type === 'embed') this.onEmbedReply(message);
    else this.onQueryReply(message);
  }

  private onState(worker: ChildProcessWorker, state: SearchChildState): void {
    this.childState = state;
    this.phase = state.phase;
    if (state.phase === 'failed') this.onDeath(worker, state.error ?? 'failed');
  }

  private onQueryReply(message: QueryResponse): void {
    const job = this.current;
    if (job?.kind !== 'query' || job.id !== message.id) return;
    this.current = null;
    if (job.wedged) clearTimeout(job.wedged);
    if (!message.ok) log.warn({ err: message.error }, 'in-process search query failed');
    this.settle(job, message.ok ? (message.hits ?? []) : null);
    this.pump();
  }

  private onEmbedReply(message: EmbedResponse): void {
    const job = this.current;
    if (job?.kind !== 'embed' || job.id !== message.id) return;
    this.current = null;
    this.settleEmbed(job, embedOutcome(message, job.texts.length));
    this.pump();
  }

  private onDeath(worker: ChildProcessWorker | null, reason: string): void {
    if (worker !== this.worker) return;
    worker?.terminate();
    this.worker = null;
    this.abandonAll(reason);
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
    const next = this.waiting.shift() ?? this.embedsWaiting.shift();
    if (!next) return;
    this.current = next;
    const limit = next.kind === 'query' ? QUERY_TIMEOUT_MS : EMBED_TIMEOUT_MS;
    next.wedged = setTimeout(() => this.wedge(next, limit), limit);
    if (next.kind === 'query') {
      this.worker.postMessage({ type: 'query', id: next.id, query: next.query, k: next.k });
      return;
    }
    this.worker.postMessage({ type: 'embed', id: next.id, texts: next.texts });
  }

  /** A request still running at its own deadline is a wedged native call. */
  private wedge(job: Job, limitMs: number): void {
    if (job !== this.current) return;
    this.onDeath(this.worker, `a ${job.kind} request did not answer within ${limitMs} ms`);
  }

  /** The caller falls back; a query already running keeps its place until it answers. */
  private giveUp(job: QueryJob): void {
    const queued = this.waiting.indexOf(job);
    if (queued >= 0) this.waiting.splice(queued, 1);
    this.settle(job, null);
  }

  private settle(job: QueryJob, hits: FusedSearchHit[] | null): void {
    clearTimeout(job.giveUp);
    if (job.settled) return;
    job.settled = true;
    job.resolve(hits);
  }

  private settleEmbed(job: EmbedJob, outcome: EmbedOutcome): void {
    if (job.wedged) clearTimeout(job.wedged);
    if (job.settled) return;
    job.settled = true;
    job.resolve(outcome);
  }

  /**
   * Settles everything outstanding. With a `death` reason, the batch that was running when the
   * child died or wedged fails — a document that kills the engine must spend its retries and
   * dead-letter, not come back every 30 s — while the batches behind it only wait.
   */
  private abandonAll(death: string | null = null): void {
    const running = this.current;
    if (running?.wedged) clearTimeout(running.wedged);
    const jobs = [
      ...(running ? [running] : []),
      ...this.waiting.splice(0),
      ...this.embedsWaiting.splice(0),
    ];
    this.current = null;
    for (const job of jobs) {
      if (job.kind === 'query') this.settle(job, null);
      else if (job === running && death !== null) {
        this.settleEmbed(job, {
          ok: false,
          waiting: false,
          error: `the search engine stopped while embedding this batch: ${death}`,
        });
      } else this.settleEmbed(job, notEmbedding('the search engine restarted'));
    }
  }
}

let pool: SearchChildPool | null = null;
let testSearch: InProcessSearch | null = null;
let remote: InProcessRanker | null = null;

/** The process-wide pool, created on first use with the config `search-child-config.ts` builds. */
export function searchChildPool(config: () => SearchChildConfig): SearchChildPool {
  pool ??= new SearchChildPool(config);
  return pool;
}

export function stopSearchChildPool(): void {
  pool?.stop();
}

/** The API's own pool, when this process runs one: what a worker's `embed` request reaches. */
export function localSearchChildPool(): SearchChildPool | null {
  return pool;
}

/** The engine the routes query: the test fake when one is installed, else the pool if created. */
export function inProcessSearch(): InProcessSearch | null {
  return testSearch ?? pool;
}

/**
 * What this process ranks with: the API's own child, or — in the worker tier, which has none —
 * the API's child reached over IPC (`remote-search.ts`, #4510).
 */
export function inProcessRanker(): InProcessRanker | null {
  return inProcessSearch() ?? remote;
}

/** Installs the worker tier's bridge to the API's child. */
export function setRemoteInProcessSearch(search: InProcessRanker | null): void {
  remote = search;
}

export function setInProcessSearchForTests(search: InProcessSearch | null): void {
  testSearch = search;
}

/** Installs the process-wide pool, so a test can start and stop one whose child is a fake. */
export function setSearchChildPoolForTests(installed: SearchChildPool | null): void {
  pool?.stop();
  pool = installed;
}
