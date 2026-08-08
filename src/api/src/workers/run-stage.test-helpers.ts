// Shared hand-rolled Mongo mocks for the run-stage test suites.
//
// Extracted from run-stage.test.ts so that file (and the sibling
// run-stage.damaged.test.ts) stay under the file-size budget. These are
// dependency-free in-memory fakes for `Collection<WorkerConfigDoc>` and
// `Collection<ImageDoc>` that support just the operators the runner uses
// ($or / $lt / $gte / $ne / $nin / $exists, dotted paths).

import type { Collection, UpdateResult } from 'mongodb';
import type { ImageDoc } from './run-stage.ts';
import type { WorkerConfigDoc } from './worker-config.repo.ts';

export function makeConfigMock(): Collection<WorkerConfigDoc> {
  const store = new Map<string, WorkerConfigDoc>();
  return {
    async findOne(filter: Record<string, unknown>) {
      const name = filter['name'] as string | undefined;
      if (!name) return null;
      return store.get(name) ?? null;
    },
    async updateOne(
      filter: Record<string, unknown>,
      update: Record<string, unknown>,
      opts?: { upsert?: boolean },
    ) {
      const name = filter['name'] as string;
      const setDoc = (update['$set'] ?? {}) as Partial<WorkerConfigDoc>;
      if (opts?.upsert) {
        const existing = store.get(name);
        store.set(name, { ...(existing ?? {}), ...setDoc } as WorkerConfigDoc);
      } else {
        const existing = store.get(name);
        if (existing) store.set(name, { ...existing, ...setDoc });
      }
      return {
        matchedCount: 1,
        modifiedCount: 1,
        upsertedCount: 0,
        upsertedId: null,
        acknowledged: true,
      } as UpdateResult;
    },
  } as unknown as Collection<WorkerConfigDoc>;
}

export function makeImagesMock(initial: ImageDoc[] = []): Collection<ImageDoc> {
  const store: ImageDoc[] = [...initial];
  return {
    async updateMany(filter: Record<string, unknown>, update: Record<string, unknown>) {
      let modified = 0;
      for (const doc of store) {
        if (matchesFilter(doc, filter)) {
          applySet(doc, (update['$set'] ?? {}) as Record<string, unknown>);
          modified++;
        }
      }
      return {
        matchedCount: modified,
        modifiedCount: modified,
        upsertedCount: 0,
        upsertedId: null,
        acknowledged: true,
      } as UpdateResult;
    },
    find(filter: Record<string, unknown>) {
      let matched = store.filter((d) => matchesFilter(d, filter));
      return {
        limit(n: number) {
          matched = matched.slice(0, n);
          return this;
        },
        async toArray() {
          return [...matched];
        },
      };
    },
    async findOne(filter: Record<string, unknown>, _opts?: unknown) {
      return store.find((d) => matchesFilter(d, filter)) ?? null;
    },
    async insertOne(doc: ImageDoc) {
      store.push(doc);
      return {
        insertedId: (doc as unknown as { _id: unknown })._id,
        acknowledged: true,
      };
    },
    async insertMany(docs: ImageDoc[]) {
      store.push(...docs);
      return {
        insertedCount: docs.length,
        insertedIds: {},
        acknowledged: true,
      };
    },
    async updateOne(filter: Record<string, unknown>, update: Record<string, unknown>) {
      const doc = store.find((d) => matchesFilter(d, filter));
      if (doc) applySet(doc, (update['$set'] ?? {}) as Record<string, unknown>);
      return {
        matchedCount: doc ? 1 : 0,
        modifiedCount: doc ? 1 : 0,
        upsertedCount: 0,
        upsertedId: null,
        acknowledged: true,
      } as UpdateResult;
    },
    async countDocuments() {
      return store.length;
    },
  } as unknown as Collection<ImageDoc>;
}

/**
 * One operator → does `docVal` satisfy it?
 *
 * A table rather than a chain of `if ('$op' in op)` blocks: each entry is
 * independently readable, adding an operator is one line, and the complexity
 * stays flat as the set grows instead of accumulating in a single function.
 *
 * `$gt` / `$type` / `$not` back the retry-backoff gate (#2729) and the damaged
 * park. They matter because this mock IGNORES operators it doesn't implement
 * rather than throwing (unlike the fail-closed sibling in
 * `run-stage.missing-tag.test.ts`): before they were modelled, the backoff
 * gate was silently a no-op in every suite using this helper, so those tests
 * claimed to cover a claim query they were not actually evaluating.
 */
const OPERATORS: Record<string, (docVal: unknown, opv: unknown) => boolean> = {
  // Absent is permissive for `$lt` — mirrors the claim query's version gate,
  // where a doc with no `stages.<name>.version` must still be claimable.
  $lt: (d, v) => d === undefined || (typeof d === 'number' && d < (v as number)),
  $gte: (d, v) => typeof d === 'number' && d >= (v as number),
  $ne: (d, v) => d !== v,
  $nin: (d, v) => !(v as unknown[]).includes(d),
  $exists: (d, v) => (v as boolean) === (d !== undefined),
  // Absent must NOT satisfy `$gt`, so `$not: { $gt: now }` leaves never-failed
  // rows claimable — mirroring Mongo, and the whole reason the retry gate is
  // expressed as a negation rather than a comparison.
  $gt: (d, v) => d !== undefined && d !== null && Number(d) > Number(v),
  $type: (d, v) => v !== 'string' || typeof d === 'string',
  $not: (d, v) => !matchesFilter({ v: d }, { v }),
};

// Down to 10 cyclomatic / 24 lines after the operator table above; what still
// trips the gate is an ESTIMATED CRAP score, which fallow derives from export
// references when no coverage report is supplied. This helper is exercised by
// every run-stage suite.
// fallow-ignore-next-line complexity
export function matchesFilter(doc: unknown, filter: Record<string, unknown>): boolean {
  for (const [key, val] of Object.entries(filter)) {
    if (key === '$or') {
      const arr = val as Record<string, unknown>[];
      if (!arr.some((subFilter) => matchesFilter(doc, subFilter))) return false;
      continue;
    }

    const docVal = getNestedValue(doc as Record<string, unknown>, key);
    if (val === null || typeof val !== 'object') {
      if (docVal !== val) return false;
      continue;
    }

    for (const [op, opv] of Object.entries(val as Record<string, unknown>)) {
      const predicate = OPERATORS[op];
      // Unknown operators stay ignored, as they always were here. Tightening
      // that to fail-closed is worth doing, but it would surface unrelated
      // gaps across many suites at once — separate change.
      if (predicate && !predicate(docVal, opv)) return false;
    }
  }
  return true;
}

export function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split('.');
  let cur: unknown = obj;
  for (const p of parts) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

export function applySet(doc: unknown, setDoc: Record<string, unknown>): void {
  for (const [path, value] of Object.entries(setDoc)) {
    const parts = path.split('.');
    let cur = doc as Record<string, unknown>;
    for (let i = 0; i < parts.length - 1; i++) {
      if (cur[parts[i]] == null) cur[parts[i]] = {};
      cur = cur[parts[i]] as Record<string, unknown>;
    }
    cur[parts[parts.length - 1]] = value;
  }
}

/**
 * Simulate the per-asset retry backoff (#2729) having elapsed, so the next
 * `runOnce` tick can claim the row again.
 *
 * Before backoff existed, consecutive ticks re-claimed a failed doc
 * immediately and a test could just call `runOnce` N times in a row. That is
 * no longer how production behaves — a failed asset is gated until
 * `next_attempt_at` — so a test that still did it would be asserting a
 * sequence the runner can no longer produce.
 */
export async function elapseRetryBackoff(
  images: Collection<ImageDoc>,
  stageName: string,
): Promise<void> {
  await images.updateMany({}, { $set: { [`stages.${stageName}.next_attempt_at`]: null } });
}
