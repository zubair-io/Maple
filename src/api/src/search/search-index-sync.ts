/**
 * Keeps the search child's engine in step with `asset_vectors`.
 *
 * 1. Boot: every vector is read in `maple_id` order into one preallocated buffer and handed to
 *    the engine in a single call; the keyword text is rendered for the same ids.
 * 2. Afterwards the child polls two stamps on `asset_vectors`, each from its own watermark
 *    ({@link ChangeFeed}). Rows whose `embedded_at` is newer are re-read and upserted, vector and
 *    text together, since the `embed` stage rewrites the row whenever the template it renders
 *    changes. Rows whose `text_changed_at` is newer had their `search_blob` rewritten with the
 *    template unchanged (a new vision tag), so only their text is re-read (#4512).
 * 3. When the engine holds a different number of vectors than the table, the full id list is
 *    compared and the difference applied — that is how a deleted asset leaves the index.
 */

import {
  allSearchVectorIds,
  countSearchVectors,
  SEARCH_VECTOR_DIMS,
  searchTextChangesSince,
  searchVectorChangesSince,
  searchVectorsAfter,
  searchVectorsFor,
  type StoredVectorRow,
} from '../db/repos/asset-vectors.search.ts';
import type { SearchEngine } from './search-engine-ffi.ts';
import { searchTextsFor } from './search-documents.ts';
import { ChangeFeed } from './search-change-feed.ts';

export type SearchEngineOps = Pick<
  SearchEngine,
  'loadVectors' | 'upsert' | 'delete' | 'clearText' | 'commit' | 'counts'
>;

export const RECONCILE_INTERVAL_MS = 60_000;

/**
 * How far each change feed has been applied: `textWatermark` follows `embedded_at`, and
 * `blobWatermark` follows `text_changed_at`. Persisted so a restart can catch up from them.
 */
export interface FollowerWatermarks {
  textWatermark: string;
  blobWatermark: string;
}
const ROW_BYTES = SEARCH_VECTOR_DIMS * 4;
const LOAD_BATCH = 2_000;
const TEXT_BATCH = 500;

/** A row's bytes as f32, copied so the view is aligned whatever offset SQLite handed back. */
function floats(bytes: Uint8Array): Float32Array {
  return new Float32Array(bytes.slice().buffer);
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  return Array.from({ length: Math.ceil(items.length / size) }, (_, index) =>
    items.slice(index * size, (index + 1) * size),
  );
}

async function* vectorPages(model: string): AsyncGenerator<StoredVectorRow[]> {
  for (let cursor: string | null = null; ; ) {
    const rows = await searchVectorsAfter(model, cursor, LOAD_BATCH);
    if (rows.length === 0) return;
    yield rows;
    cursor = rows[rows.length - 1]!.maple_id;
  }
}

/**
 * Loads every vector and returns the ids now held. One buffer sized from a count taken first
 * (335k rows is 1.4 GB, so collecting pages and concatenating would double it); rows written after
 * the count are upserted one by one instead of growing the buffer.
 */
export async function loadAllVectors(engine: SearchEngineOps, model: string): Promise<Set<string>> {
  const capacity = await countSearchVectors(model);
  const buffer = new Uint8Array(capacity * ROW_BYTES);
  const ids: string[] = [];
  const overflow: StoredVectorRow[] = [];
  for await (const rows of vectorPages(model)) {
    for (const row of rows) {
      if (ids.length < capacity) {
        buffer.set(row.vector, ids.length * ROW_BYTES);
        ids.push(row.maple_id);
      } else {
        overflow.push(row);
      }
    }
  }
  engine.loadVectors(buffer.subarray(0, ids.length * ROW_BYTES), ids);
  for (const row of overflow) engine.upsert(row.maple_id, floats(row.vector), null);
  return new Set([...ids, ...overflow.map((row) => row.maple_id)]);
}

/** Replaces the keyword text of every held id; searches see the old text until the commit. */
export async function rebuildText(engine: SearchEngineOps, ids: readonly string[]): Promise<void> {
  engine.clearText();
  for (const chunk of chunks(ids, TEXT_BATCH)) {
    const texts = await searchTextsFor(chunk);
    for (const [id, text] of texts) engine.upsert(id, null, text);
  }
  engine.commit();
}

export class VectorFollower {
  private readonly vectorFeed: ChangeFeed;
  private readonly textFeed: ChangeFeed;
  private lastReconcileAt = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly engine: SearchEngineOps,
    private readonly held: Set<string>,
    since: FollowerWatermarks,
    private readonly model: string,
    private readonly now: () => number = Date.now,
  ) {
    this.vectorFeed = new ChangeFeed(searchVectorChangesSince, model, since.textWatermark);
    this.textFeed = new ChangeFeed(searchTextChangesSince, model, since.blobWatermark);
  }

  /** Everything each feed stamped before its watermark is in the engine. */
  get watermarks(): FollowerWatermarks {
    return { textWatermark: this.vectorFeed.since, blobWatermark: this.textFeed.since };
  }

  get heldCount(): number {
    return this.held.size;
  }

  /** Applies whatever changed since the last poll; returns how many ids it touched. */
  async poll(): Promise<number> {
    const vectors = await this.vectorFeed.drain((ids) => this.upsert(ids));
    const texts = await this.textFeed.drain((ids) => this.upsertText(ids));
    const reconciled = await this.reconcileIfDrifted();
    const touched = vectors.touched + texts.touched + reconciled;
    if (touched > 0) this.engine.commit();
    this.vectorFeed.advance(vectors.newest);
    this.textFeed.advance(texts.newest);
    return touched;
  }

  private async upsert(ids: readonly string[]): Promise<void> {
    for (const chunk of chunks(ids, TEXT_BATCH)) {
      const [rows, texts] = await Promise.all([
        searchVectorsFor(this.model, chunk),
        searchTextsFor(chunk),
      ]);
      for (const row of rows) {
        this.engine.upsert(row.maple_id, floats(row.vector), texts.get(row.maple_id) ?? null);
        this.held.add(row.maple_id);
      }
    }
  }

  /** Text only, and only for held ids: one not held yet gets its text with its vector. */
  private async upsertText(ids: readonly string[]): Promise<void> {
    const held = ids.filter((id) => this.held.has(id));
    for (const chunk of chunks(held, TEXT_BATCH)) {
      for (const [id, text] of await searchTextsFor(chunk)) this.engine.upsert(id, null, text);
    }
  }

  private async reconcileIfDrifted(): Promise<number> {
    if (this.now() - this.lastReconcileAt < RECONCILE_INTERVAL_MS) return 0;
    if ((await countSearchVectors(this.model)) === this.held.size) return 0;
    this.lastReconcileAt = this.now();
    const stored = new Set(await allSearchVectorIds(this.model));
    const gone = [...this.held].filter((id) => !stored.has(id));
    const missing = [...stored].filter((id) => !this.held.has(id));
    for (const id of gone) {
      this.engine.delete(id);
      this.held.delete(id);
      this.vectorFeed.forget(id);
      this.textFeed.forget(id);
    }
    await this.upsert(missing);
    return gone.length + missing.length;
  }
}
