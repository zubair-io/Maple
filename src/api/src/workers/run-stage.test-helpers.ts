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

export function matchesFilter(doc: unknown, filter: Record<string, unknown>): boolean {
  for (const [key, val] of Object.entries(filter)) {
    if (key === '$or') {
      const arr = val as Record<string, unknown>[];
      if (!arr.some((subFilter) => matchesFilter(doc, subFilter))) return false;
      continue;
    }

    const docVal = getNestedValue(doc as Record<string, unknown>, key);
    if (val !== null && typeof val === 'object') {
      const op = val as Record<string, unknown>;
      if ('$lt' in op) {
        const limit = op['$lt'] as number;
        if (docVal === undefined) continue;
        if (!(typeof docVal === 'number' && docVal < limit)) return false;
      }
      if ('$gte' in op) {
        if (docVal === undefined) return false;
        if (!(typeof docVal === 'number' && docVal >= (op['$gte'] as number))) return false;
      }
      if ('$ne' in op && docVal === op['$ne']) return false;
      if ('$nin' in op) {
        const arr = op['$nin'] as unknown[];
        if (arr.includes(docVal)) return false;
      }
      if ('$exists' in op) {
        const expected = op['$exists'] as boolean;
        if (expected === false && docVal !== undefined) return false;
        if (expected === true && docVal === undefined) return false;
      }
      // `$gt` / `$type` / `$not` back the retry-backoff gate (#2729) and the
      // damaged park. Modelled here because this helper ignores operators it
      // doesn't implement rather than throwing: without them the backoff gate
      // was silently a no-op in every suite using this mock, so tests claimed
      // to cover a claim query they were not actually evaluating.
      //
      // An absent field must not satisfy `$gt`, so `$not: { $gt: now }` leaves
      // never-failed rows claimable — mirroring Mongo, and the whole reason
      // the gate is expressed as a negation.
      if ('$gt' in op) {
        if (docVal === undefined || docVal === null) return false;
        if (!(Number(docVal) > Number(op['$gt']))) return false;
      }
      if ('$type' in op) {
        if (op['$type'] === 'string' && typeof docVal !== 'string') return false;
      }
      if ('$not' in op) {
        if (matchesFilter({ v: docVal }, { v: op['$not'] })) return false;
      }
    } else {
      if (docVal !== val) return false;
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
