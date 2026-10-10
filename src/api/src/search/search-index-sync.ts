/**
 * Keeps the search child's engine in step with `asset_vectors`.
 *
 * 1. Boot: every vector is read in `maple_id` order into one preallocated buffer and handed to
 *    the engine in a single call; the keyword text is rendered for the same ids.
 * 2. Afterwards the child polls: rows whose `embedded_at` is newer than a watermark are re-read and
 *    upserted (vector and text together, since the `embed` stage rewrites the row whenever the text
 *    it renders changes).
 * 3. When the engine holds a different number of vectors than the table, the full id list is
 *    compared and the difference applied — that is how a deleted asset leaves the index.
 *
 * The watermark trails the newest stamp seen by {@link CHANGE_OVERLAP_MS}. `embedded_at` is taken
 * when the stage handler finishes, before its transaction commits, so with a thousand concurrent
 * handlers a row can land after a newer-stamped one; the overlap re-reads that window and the
 * `applied` map skips the rows already taken.
 */

import {
  allSearchVectorIds,
  countSearchVectors,
  SEARCH_VECTOR_DIMS,
  searchVectorChangesSince,
  searchVectorsAfter,
  searchVectorsFor,
  type StoredVectorRow,
  type VectorChangeRow,
} from '../db/repos/asset-vectors.search.ts';
import type { SearchEngine } from './search-engine-ffi.ts';
import { searchTextsFor } from './search-documents.ts';

export type SearchEngineOps = Pick<
  SearchEngine,
  'loadVectors' | 'upsert' | 'delete' | 'clearText' | 'commit' | 'counts'
>;

export const CHANGE_OVERLAP_MS = 60_000;
export const RECONCILE_INTERVAL_MS = 60_000;
const ROW_BYTES = SEARCH_VECTOR_DIMS * 4;
const LOAD_BATCH = 2_000;
const CHANGE_BATCH = 5_000;
const TEXT_BATCH = 500;

export function isoBefore(iso: string | number, ms: number): string {
  const at = typeof iso === 'number' ? iso : Date.parse(iso);
  return new Date(at - ms).toISOString();
}

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
  private watermark: string;
  private readonly applied = new Map<string, string>();
  private lastReconcileAt = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly engine: SearchEngineOps,
    private readonly held: Set<string>,
    since: string,
    private readonly model: string,
    private readonly now: () => number = Date.now,
  ) {
    this.watermark = since;
  }

  /** Everything older than this is in the engine; persisted so a restart can catch up from it. */
  get textWatermark(): string {
    return this.watermark;
  }

  get heldCount(): number {
    return this.held.size;
  }

  /** Applies whatever changed since the last poll; returns how many ids it touched. */
  async poll(): Promise<number> {
    const { touched, newest } = await this.applyChanges();
    const reconciled = await this.reconcileIfDrifted();
    if (touched + reconciled > 0) this.engine.commit();
    this.advance(newest);
    return touched + reconciled;
  }

  private async applyChanges(): Promise<{ touched: number; newest: string | null }> {
    let after: VectorChangeRow | null = null;
    let touched = 0;
    for (;;) {
      const page: VectorChangeRow[] = await searchVectorChangesSince(
        this.model,
        this.watermark,
        after,
        CHANGE_BATCH,
      );
      if (page.length === 0) return { touched, newest: after?.embedded_at ?? null };
      const fresh = page.filter((row) => this.applied.get(row.maple_id) !== row.embedded_at);
      await this.upsert(fresh.map((row) => row.maple_id));
      for (const row of fresh) this.applied.set(row.maple_id, row.embedded_at);
      touched += fresh.length;
      after = page[page.length - 1]!;
    }
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
      this.applied.delete(id);
    }
    await this.upsert(missing);
    return gone.length + missing.length;
  }

  private advance(newest: string | null): void {
    if (newest === null) return;
    const trailing = isoBefore(newest, CHANGE_OVERLAP_MS);
    if (trailing <= this.watermark) return;
    this.watermark = trailing;
    for (const [id, stamp] of this.applied) {
      if (stamp <= trailing) this.applied.delete(id);
    }
  }
}
