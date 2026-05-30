/**
 * Runner-side `missing_since` tagging tests.
 *
 * Split out of `run-stage.test.ts` to keep that file under the file-size
 * budget. Covers the catch-path tag the missing-reaper consumes: an
 * original-file stage (`tagsMissingOnEnoent`) that fails with ENOENT gets the
 * asset stamped, first-detection wins, and nothing else tags. DB-free — uses
 * the same in-memory collection mock shape as `run-stage.test.ts`.
 */

import { describe, expect, it } from 'bun:test';
import type { Collection, UpdateResult } from 'mongodb';
import { _test, defineStage, type ImageDoc } from './run-stage.ts';
import type { WorkerConfigDoc } from './worker-config.repo.ts';

function makeConfigMock(): Collection<WorkerConfigDoc> {
  const store = new Map<string, WorkerConfigDoc>();
  return {
    async findOne(filter: Record<string, unknown>) {
      const name = filter['name'] as string | undefined;
      return name ? (store.get(name) ?? null) : null;
    },
    async updateOne(
      filter: Record<string, unknown>,
      update: Record<string, unknown>,
      opts?: { upsert?: boolean },
    ) {
      const name = filter['name'] as string;
      const setDoc = (update['$set'] ?? {}) as Partial<WorkerConfigDoc>;
      const existing = store.get(name);
      if (existing || opts?.upsert) {
        store.set(name, { ...(existing ?? {}), ...setDoc } as WorkerConfigDoc);
      }
      return { matchedCount: 1, modifiedCount: 1, acknowledged: true } as UpdateResult;
    },
  } as unknown as Collection<WorkerConfigDoc>;
}

function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  let cur: unknown = obj;
  for (const p of path.split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

function matchesFilter(doc: unknown, filter: Record<string, unknown>): boolean {
  for (const [key, val] of Object.entries(filter)) {
    if (key === '$or') {
      const arr = val as Record<string, unknown>[];
      if (!arr.some((sub) => matchesFilter(doc, sub))) return false;
      continue;
    }
    const docVal = getNestedValue(doc as Record<string, unknown>, key);
    if (val !== null && typeof val === 'object') {
      const op = val as Record<string, unknown>;
      if ('$lt' in op && docVal !== undefined) {
        if (!(typeof docVal === 'number' && docVal < (op['$lt'] as number))) return false;
      }
      if ('$ne' in op && docVal === op['$ne']) return false;
      if ('$nin' in op && (op['$nin'] as unknown[]).includes(docVal)) return false;
      if ('$exists' in op) {
        const expected = op['$exists'] as boolean;
        if (expected === false && docVal !== undefined) return false;
        if (expected === true && docVal === undefined) return false;
      }
    } else if (docVal !== val) {
      return false;
    }
  }
  return true;
}

function applySet(doc: unknown, setDoc: Record<string, unknown>): void {
  for (const [path, value] of Object.entries(setDoc)) {
    const parts = path.split('.');
    let cur = doc as Record<string, unknown>;
    for (let i = 0; i < parts.length - 1; i++) {
      if (cur[parts[i]!] == null) cur[parts[i]!] = {};
      cur = cur[parts[i]!] as Record<string, unknown>;
    }
    cur[parts[parts.length - 1]!] = value;
  }
}

function makeImagesMock(initial: ImageDoc[] = []): Collection<ImageDoc> {
  const store: ImageDoc[] = [...initial];
  return {
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
    async findOne(filter: Record<string, unknown>) {
      return store.find((d) => matchesFilter(d, filter)) ?? null;
    },
    async updateOne(filter: Record<string, unknown>, update: Record<string, unknown>) {
      const doc = store.find((d) => matchesFilter(d, filter));
      if (doc) applySet(doc, (update['$set'] ?? {}) as Record<string, unknown>);
      return {
        matchedCount: doc ? 1 : 0,
        modifiedCount: doc ? 1 : 0,
        acknowledged: true,
      } as UpdateResult;
    },
  } as unknown as Collection<ImageDoc>;
}

const cfg = {
  concurrency: 1,
  pollIntervalMs: 50,
  batchSize: 10,
  maxAttempts: 3,
  paused: false,
  last_seen_target_version: 1,
};

function originalFileStage(name = 'exif', tags = true) {
  return defineStage({
    name,
    targetVersion: 1,
    dependsOn: [],
    tagsMissingOnEnoent: tags,
    defaults: {
      concurrency: 1,
      pollIntervalMs: 50,
      batchSize: 10,
      maxAttempts: 3,
      paused: false,
      pausedOnFirstBoot: false,
      last_seen_target_version: 0,
    },
    handler: async () => {
      throw Object.assign(new Error("ENOENT: no such file, stat '/gone.raw'"), { code: 'ENOENT' });
    },
  });
}

describe('runOnce — missing_since tagging', () => {
  it('tags missing_since on an ENOENT failure when tagsMissingOnEnoent is set', async () => {
    const images = makeImagesMock([{ abs_path: '/gone.raw' } as unknown as ImageDoc]);
    const configColl = makeConfigMock();
    const stage = originalFileStage();

    await _test.runOnce(stage, cfg, images, configColl);
    const doc = (await images.find({}).toArray())[0]!;
    expect(typeof doc.missing_since).toBe('string');
    const firstTag = doc.missing_since;

    // First-detection wins: a second ENOENT tick must NOT push the timestamp
    // forward (the reaper's boot-time age-gate depends on it being stable).
    await _test.runOnce(stage, cfg, images, configColl);
    expect((await images.find({}).toArray())[0]!.missing_since).toBe(firstTag);
  });

  it('does NOT tag missing_since for a non-ENOENT failure', async () => {
    const images = makeImagesMock([{ abs_path: '/bad.raw' } as unknown as ImageDoc]);
    const configColl = makeConfigMock();
    const stage = defineStage({
      ...originalFileStage(),
      handler: async () => {
        throw new Error('decode blew up'); // no ENOENT code
      },
    });

    await _test.runOnce(stage, cfg, images, configColl);
    expect((await images.find({}).toArray())[0]!.missing_since).toBeUndefined();
  });

  it('does NOT tag missing_since when tagsMissingOnEnoent is unset, even on ENOENT', async () => {
    const images = makeImagesMock([{ abs_path: '/gone.raw' } as unknown as ImageDoc]);
    const configColl = makeConfigMock();
    // A stage that does not read the original file never opts in.
    const stage = originalFileStage('meili', false);

    await _test.runOnce(stage, cfg, images, configColl);
    expect((await images.find({}).toArray())[0]!.missing_since).toBeUndefined();
  });
});
