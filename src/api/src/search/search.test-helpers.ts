import type { Database } from 'bun:sqlite';
import { encodeVector } from '../enrichment/ollama-embed-client.ts';
import type { SearchEngineOps } from './search-index-sync.ts';
import type { ChildProcessWorker } from '../runtime/child-process-worker.ts';
import { SearchChildPool, type InProcessSearch, type SearchEngineStatus } from './search-pool.ts';
import type {
  QueryRequest,
  SearchChildConfig,
  SearchChildRequest,
  SearchChildResponse,
} from './search-protocol.ts';

const DIMS = 1024;

/** An engine that records vectors by their one non-zero axis and text with commit semantics. */
export class RecordingEngine implements SearchEngineOps {
  vectors = new Map<string, number>();
  texts = new Map<string, string>();
  staged = new Map<string, string | null>();
  commits = 0;
  clears = 0;

  loadVectors(bytes: Uint8Array, ids: readonly string[]): void {
    const view = new Float32Array(bytes.slice().buffer);
    this.vectors = new Map(ids.map((id, row) => [id, axisOf(view.subarray(row * DIMS))]));
  }
  upsert(id: string, vector: Float32Array | null, text: string | null): void {
    if (vector) this.vectors.set(id, axisOf(vector));
    if (text !== null) this.staged.set(id, text);
  }
  delete(id: string): void {
    this.vectors.delete(id);
    this.staged.set(id, null);
  }
  clearText(): void {
    this.clears++;
    for (const id of this.texts.keys()) this.staged.set(id, null);
  }
  commit(): void {
    for (const [id, text] of this.staged) {
      if (text === null) this.texts.delete(id);
      else this.texts.set(id, text);
    }
    this.staged.clear();
    this.commits++;
  }
  counts() {
    return { vectors: this.vectors.size, texts: this.texts.size };
  }
}

function axisOf(vector: Float32Array): number {
  return vector.slice(0, DIMS).findIndex((value) => value !== 0);
}

function basis(axis: number): Uint8Array {
  const vector = new Float32Array(DIMS);
  vector[axis] = 1;
  return encodeVector(vector);
}

export function storeVector(
  db: Database,
  mapleId: string,
  axis: number,
  embeddedAt: string,
  model = 'bge-m3',
): void {
  db.run(
    `INSERT INTO asset_vectors (maple_id, version, model, endpoint, dims, vector, embedded_at)
     VALUES (?, 8, ?, 'http://gpu', ?, ?, ?)
     ON CONFLICT (maple_id) DO UPDATE SET
       model = excluded.model, vector = excluded.vector, embedded_at = excluded.embedded_at`,
    [mapleId, model, DIMS, basis(axis), embeddedAt],
  );
}

const FAKE_DOWN: SearchEngineStatus = {
  phase: 'starting',
  vectors: 0,
  texts: 0,
  textReady: false,
  restarts: 0,
};

function readyCounts(count: number): Partial<SearchEngineStatus> {
  return { phase: 'ready', vectors: count, texts: count, textReady: true };
}

/** A ready in-process engine that answers `ids` in order, or a down one when `ids` is null. */
export function fakeInProcessSearch(ids: readonly string[] | null): InProcessSearch & {
  queries: Array<{ query: string; k: number }>;
} {
  const queries: Array<{ query: string; k: number }> = [];
  return {
    queries,
    async search(query, k) {
      queries.push({ query, k });
      return ids === null
        ? null
        : ids.map((id, index) => ({
            id,
            score: 1 / (61 + index),
            vectorRank: index + 1,
            textRank: null,
          }));
    },
    status: () => (ids === null ? FAKE_DOWN : { ...FAKE_DOWN, ...readyCounts(ids.length) }),
  };
}

/** A child process stand-in that records what the pool sends and replies on demand. */
export interface FakeChild {
  sent: SearchChildRequest[];
  terminated: boolean;
  reply(message: SearchChildResponse): void;
  crash(): void;
  queries(): QueryRequest[];
}

function fakeChild(): { fake: FakeChild; worker: ChildProcessWorker } {
  const listeners = {
    message: (_event: { data: unknown }) => {},
    error: (_event: { message?: string }) => {},
  };
  const fake: FakeChild = {
    sent: [],
    terminated: false,
    reply: (message) => listeners.message({ data: message }),
    crash: () => listeners.error({ message: 'search child died — signal=SIGSEGV' }),
    queries: () => fake.sent.filter((message): message is QueryRequest => message.type === 'query'),
  };
  const worker = {
    postMessage: (message: unknown) => fake.sent.push(message as SearchChildRequest),
    terminate: () => {
      fake.terminated = true;
    },
    addEventListener: (type: 'message' | 'error', cb: (event: never) => void) => {
      listeners[type] = cb as never;
    },
  };
  return { fake, worker: worker as unknown as ChildProcessWorker };
}

/** A pool whose children are {@link FakeChild}s, in spawn order. */
export function fakeChildPool(config: () => SearchChildConfig): {
  pool: SearchChildPool;
  children: FakeChild[];
} {
  const children: FakeChild[] = [];
  const pool = new SearchChildPool(config, () => {
    const { fake, worker } = fakeChild();
    children.push(fake);
    return worker;
  });
  return { pool, children };
}
