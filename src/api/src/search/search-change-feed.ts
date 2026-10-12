/**
 * One stamp column of `asset_vectors` followed from a watermark: `embedded_at` for vectors the
 * `embed` stage rewrote, `text_changed_at` for assets whose `search_blob` changed (#4512).
 *
 * The watermark trails the newest stamp seen by {@link CHANGE_OVERLAP_MS}. A stamp is taken before
 * its transaction commits, so with a thousand concurrent stage handlers a row can land after a
 * newer-stamped one; the overlap re-reads that window and the `applied` map skips the rows already
 * taken.
 */

import type { ChangeReader, VectorChangeRow } from '../db/repos/asset-vectors.search.ts';

export const CHANGE_OVERLAP_MS = 60_000;
const CHANGE_BATCH = 5_000;

export function isoBefore(iso: string | number, ms: number): string {
  const at = typeof iso === 'number' ? iso : Date.parse(iso);
  return new Date(at - ms).toISOString();
}

export class ChangeFeed {
  private watermark: string;
  private readonly applied = new Map<string, string>();

  constructor(
    private readonly read: ChangeReader,
    private readonly model: string,
    since: string,
  ) {
    this.watermark = since;
  }

  /** Everything this feed stamped before this is applied. */
  get since(): string {
    return this.watermark;
  }

  /** Hands every id stamped since the watermark to `apply`, a page at a time. */
  async drain(
    apply: (ids: readonly string[]) => Promise<void>,
  ): Promise<{ touched: number; newest: string | null }> {
    let after: VectorChangeRow | null = null;
    let touched = 0;
    for (;;) {
      const page: VectorChangeRow[] = await this.read(
        this.model,
        this.watermark,
        after,
        CHANGE_BATCH,
      );
      if (page.length === 0) return { touched, newest: after?.changed_at ?? null };
      const fresh = page.filter((row) => this.applied.get(row.maple_id) !== row.changed_at);
      await apply(fresh.map((row) => row.maple_id));
      for (const row of fresh) this.applied.set(row.maple_id, row.changed_at);
      touched += fresh.length;
      after = page[page.length - 1]!;
    }
  }

  forget(id: string): void {
    this.applied.delete(id);
  }

  advance(newest: string | null): void {
    if (newest === null) return;
    const trailing = isoBefore(newest, CHANGE_OVERLAP_MS);
    if (trailing <= this.watermark) return;
    this.watermark = trailing;
    for (const [id, stamp] of this.applied) {
      if (stamp <= trailing) this.applied.delete(id);
    }
  }
}
