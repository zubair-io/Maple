import type { Database } from 'bun:sqlite';
import { encodeVector } from '../enrichment/ollama-embed-client.ts';
import type { SearchEngineOps } from './search-index-sync.ts';
import type { ChildProcessWorker } from '../runtime/child-process-worker.ts';
import { SearchChildPool, type InProcessSearch } from './search-pool.ts';
import type {
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
    status: () => ({
      phase: ids === null ? 'starting' : 'ready',
      vectors: ids?.length ?? 0,
      texts: ids?.length ?? 0,
      textReady: ids !== null,
      restarts: 0,
    }),
  };
}

/** A child process stand-in that records what the pool sends and replies on demand. */
export class FakeChild {
  sent: SearchChildRequest[] = [];
  terminated = false;
  private onMessage: (event: { data: unknown }) => void = () => {};
  private onError: (event: { message?: string }) => void = () => {};

  postMessage(message: unknown): void {
    this.sent.push(message as SearchChildRequest);
  }
  terminate(): void {
    this.terminated = true;
  }
  addEventListener(type: 'message' | 'error', cb: (event: never) => void): void {
    if (type === 'message') this.onMessage = cb as typeof this.onMessage;
    else this.onError = cb as typeof this.onError;
  }
  reply(message: SearchChildResponse): void {
    this.onMessage({ data: message });
  }
  crash(): void {
    this.onError({ message: 'search child died — signal=SIGSEGV' });
  }
  queries() {
    return this.sent.filter((message) => message.type === 'query');
  }
}

/** A pool whose children are {@link FakeChild}s, in spawn order. */
export function fakeChildPool(config: () => SearchChildConfig): {
  pool: SearchChildPool;
  children: FakeChild[];
} {
  const children: FakeChild[] = [];
  const pool = new SearchChildPool(config, () => {
    const child = new FakeChild();
    children.push(child);
    return child as unknown as ChildProcessWorker;
  });
  return { pool, children };
}
