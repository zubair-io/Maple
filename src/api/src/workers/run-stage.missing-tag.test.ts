/**
 * Runner-side per-location `missing_since` tagging tests.
 *
 * Split out of `run-stage.test.ts` to keep that file under the file-size
 * budget. Covers the catch-path tag the missing-reaper consumes: an
 * original-file stage (`tagsMissingOnEnoent`) that fails with ENOENT stamps
 * `missing_since` on the PRIMARY `fileinfo` entry (first-detection wins), and
 * nothing else tags. DB-free — the in-memory collection mock understands the
 * `$elemMatch`/`$in`/`$type`/`$not` operators the claim query uses and applies
 * `arrayFilters` `$set`s the way the per-entry tag write needs.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Collection, UpdateResult } from 'mongodb';
import { _test, buildClaimQuery, defineStage, type ImageDoc } from './run-stage.ts';
import type { WorkerConfigDoc } from './worker-config.repo.ts';
import { setLibraryRootsForTests } from '../indexer/libraries.cache.ts';

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

/** Evaluate one field condition (a scalar equality or an operator object).
 * Supports the operator subset the claim query + per-entry tag write use. */
function matchVal(docVal: unknown, cond: unknown): boolean {
  if (cond !== null && typeof cond === 'object' && !Array.isArray(cond)) {
    for (const [op, opv] of Object.entries(cond as Record<string, unknown>)) {
      switch (op) {
        case '$lt':
          if (!(typeof docVal === 'number' && docVal < (opv as number))) return false;
          break;
        case '$ne':
          if (docVal === opv) return false;
          break;
        case '$nin':
          if ((opv as unknown[]).includes(docVal)) return false;
          break;
        case '$in':
          // `$in: [null]` matches null OR absent, mirroring Mongo.
          if (
            !(opv as unknown[]).some(
              (v) => v === docVal || (v === null && (docVal === null || docVal === undefined)),
            )
          )
            return false;
          break;
        case '$exists': {
          const expected = opv as boolean;
          if (expected === false && docVal !== undefined) return false;
          if (expected === true && docVal === undefined) return false;
          break;
        }
        case '$type':
          if (opv === 'string' && typeof docVal !== 'string') return false;
          break;
        case '$not':
          if (matchVal(docVal, opv)) return false;
          break;
        case '$elemMatch':
          if (!Array.isArray(docVal)) return false;
          if (!docVal.some((el) => matchesFilter(el, opv as Record<string, unknown>))) return false;
          break;
        default:
          // Fail closed: an operator the mock doesn't model would otherwise be
          // silently ignored, letting a query-shape change pass unnoticed.
          throw new Error(`mock matchVal: unsupported operator ${op}`);
      }
    }
    return true;
  }
  return docVal === cond;
}

function matchesFilter(doc: unknown, filter: Record<string, unknown>): boolean {
  for (const [key, val] of Object.entries(filter)) {
    if (key === '$or') {
      const arr = val as Record<string, unknown>[];
      if (!arr.some((sub) => matchesFilter(doc, sub))) return false;
      continue;
    }
    if (!matchVal(getNestedValue(doc as Record<string, unknown>, key), val)) return false;
  }
  return true;
}

/** Does array element `el` satisfy the arrayFilter for identifier `id`? The
 * filter keys are `id.field` (and possibly `$or` of the same), so strip the
 * `id.` prefix and reuse `matchesFilter` on the element. */
function arrayFilterMatches(
  el: unknown,
  id: string,
  af: Record<string, unknown> | undefined,
): boolean {
  if (!af) return true;
  const strip = (arm: Record<string, unknown>): Record<string, unknown> => {
    const o: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(arm)) {
      o[k.startsWith(`${id}.`) ? k.slice(id.length + 1) : k] = v;
    }
    return o;
  };
  const sub: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(af)) {
    if (k === '$or') sub['$or'] = (v as Record<string, unknown>[]).map(strip);
    else if (k.startsWith(`${id}.`)) sub[k.slice(id.length + 1)] = v;
  }
  return matchesFilter(el, sub);
}

/** Resolve one `$set` path to its target objects + final key WITHOUT writing.
 * Mongo evaluates arrayFilters against the PRE-update document for the whole
 * update, so writes must be collected first and applied afterwards — applying
 * one path can otherwise flip a filter (`missing_since $exists:false`) off
 * before a sibling path (`missing_reason`) is matched. */
function collectWrites(
  obj: Record<string, unknown>,
  parts: string[],
  value: unknown,
  arrayFilters: Record<string, unknown>[] | undefined,
  out: Array<{ target: Record<string, unknown>; key: string; value: unknown }>,
): void {
  const [head, ...rest] = parts;
  const m = /^\$\[(\w+)\]$/.exec(head!);
  if (m) {
    const id = m[1]!;
    const af = (arrayFilters ?? []).find((f) =>
      Object.keys(f).some((k) => k === id || k.startsWith(`${id}.`) || k === '$or'),
    );
    const arr = obj as unknown as unknown[];
    if (!Array.isArray(arr)) return;
    for (const el of arr) {
      if (arrayFilterMatches(el, id, af))
        collectWrites(el as Record<string, unknown>, rest, value, arrayFilters, out);
    }
    return;
  }
  if (rest.length === 0) {
    out.push({ target: obj, key: head!, value });
    return;
  }
  if (obj[head!] == null) obj[head!] = {};
  collectWrites(obj[head!] as Record<string, unknown>, rest, value, arrayFilters, out);
}

function applySet(
  doc: unknown,
  setDoc: Record<string, unknown>,
  arrayFilters?: Record<string, unknown>[],
): void {
  const writes: Array<{ target: Record<string, unknown>; key: string; value: unknown }> = [];
  for (const [path, value] of Object.entries(setDoc)) {
    collectWrites(doc as Record<string, unknown>, path.split('.'), value, arrayFilters, writes);
  }
  for (const w of writes) w.target[w.key] = w.value;
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
    async updateOne(
      filter: Record<string, unknown>,
      update: Record<string, unknown>,
      options?: { arrayFilters?: Record<string, unknown>[] },
    ) {
      const doc = store.find((d) => matchesFilter(d, filter));
      if (doc)
        applySet(doc, (update['$set'] ?? {}) as Record<string, unknown>, options?.arrayFilters);
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
      maxAttempts: 3,
      paused: false,
      pausedOnFirstBoot: false,
      last_seen_target_version: 0,
    },
    handler: async () => {
      throw Object.assign(new Error("ENOENT: no such file, stat '/gone.raw'"), {
        code: 'ENOENT',
      });
    },
  });
}

/** A doc with one live location, so the claim query picks it up and the
 * primary-entry resolution has something to tag. */
function liveDoc(filename = 'gone.raw'): ImageDoc {
  return {
    fileinfo: [{ library_id: 'lib0', path: '', filename, deleted_at: null }],
  } as unknown as ImageDoc;
}

/** The (single) fileinfo entry's per-location missing tag. */
function entryMissing(doc: ImageDoc): unknown {
  return (doc as unknown as { fileinfo?: Array<{ missing_since?: unknown }> }).fileinfo?.[0]
    ?.missing_since;
}

/** The (single) fileinfo entry's structured missing provenance. */
function entryReason(doc: ImageDoc): unknown {
  return (doc as unknown as { fileinfo?: Array<{ missing_reason?: unknown }> }).fileinfo?.[0]
    ?.missing_reason;
}

// The tag write is confirm-before-tag now (#2171): it resolves the primary
// entry against the registered library root, requires the root to be AVAILABLE
// (listable + non-empty — an unmounted mount is a present-but-empty dir), and
// re-stats the exact path, tagging only on a confirmed ENOENT. These tests
// register a real tmp dir as `lib0`'s root; `marker.txt` keeps it non-empty.
let libRoot: string;
beforeEach(() => {
  libRoot = mkdtempSync(join(tmpdir(), 'maple-runstage-root-'));
  writeFileSync(join(libRoot, 'marker.txt'), 'x');
  setLibraryRootsForTests(new Map([['lib0', libRoot]]));
});
afterEach(() => {
  setLibraryRootsForTests(null);
  rmSync(libRoot, { recursive: true, force: true });
});

describe('runOnce — per-location missing_since tagging', () => {
  it('tags the primary entry missing_since on an ENOENT failure when tagsMissingOnEnoent is set', async () => {
    const images = makeImagesMock([liveDoc()]);
    const configColl = makeConfigMock();
    const stage = originalFileStage();

    await _test.runOnce(stage, cfg, images, configColl);
    const doc = (await images.find({}).toArray())[0]!;
    expect(typeof entryMissing(doc)).toBe('string');
    // Structured provenance: which writer tagged, and from which stage (#2171).
    expect(entryReason(doc)).toBe('stage-enoent:exif');
    // Never the asset root — the tag is per-location now.
    expect((doc as unknown as { missing_since?: unknown }).missing_since).toBeUndefined();
    const firstTag = entryMissing(doc);

    // First-detection wins: a second ENOENT tick must NOT push the timestamp
    // forward (the reaper's per-entry age-gate depends on it being stable).
    // The tagged entry is now non-live, so the claim query no longer selects
    // the row — assert the tag is unchanged regardless.
    await _test.runOnce(stage, cfg, images, configColl);
    expect(entryMissing((await images.find({}).toArray())[0]!)).toBe(firstTag as string);
  });

  it('tag-only suppression: stamps the entry and touches NO stage state', async () => {
    const images = makeImagesMock([liveDoc()]);
    const configColl = makeConfigMock();
    const stage = originalFileStage();

    await _test.runOnce(stage, cfg, images, configColl);
    const doc = (await images.find({}).toArray())[0]! as unknown as {
      fileinfo?: Array<{ missing_since?: string }>;
      stages?: Record<string, { attempts?: number; version?: number; dead?: boolean }>;
    };
    // Tagged for the reaper, and the claim's provisional attempt (#897) is
    // rolled back: a missing original was never genuinely attempted, so the
    // stage is left unadvanced — no version, not dead, attempts 0. The
    // tagged entry parks the row out of the claim query; the reaper re-enables it.
    expect(typeof doc.fileinfo?.[0]?.missing_since).toBe('string');
    expect(doc.stages?.exif?.attempts ?? 0).toBe(0);
    expect(doc.stages?.exif?.version).toBeUndefined();
    expect(doc.stages?.exif?.dead ?? false).toBe(false);
  });

  it('buildClaimQuery requires a live location (and never references root missing_since)', () => {
    const q = buildClaimQuery('exif', 1, [], new Set()) as Record<string, unknown>;
    expect(q['fileinfo']).toEqual({
      $elemMatch: { deleted_at: { $in: [null] }, missing_since: { $in: [null] } },
    });
    expect(q['missing_since']).toBeUndefined();
  });

  it('does NOT tag when the file is actually present on disk (transient ENOENT)', async () => {
    // #2171: a handler-level ENOENT can be a race (file mid-move, stale
    // negative cache on a network share) rather than a real deletion. The
    // runner re-stats the primary path and refuses to tag a present file;
    // the attempt rollback leaves the row claimable for a clean retry.
    writeFileSync(join(libRoot, 'gone.raw'), 'x'); // present despite the handler's ENOENT
    const images = makeImagesMock([liveDoc()]);
    const configColl = makeConfigMock();
    const stage = originalFileStage();

    await _test.runOnce(stage, cfg, images, configColl);
    const doc = (await images.find({}).toArray())[0]! as unknown as {
      fileinfo?: Array<{ missing_since?: string }>;
      stages?: Record<string, { attempts?: number }>;
    };
    expect(doc.fileinfo?.[0]?.missing_since).toBeUndefined();
    expect(doc.stages?.exif?.attempts ?? 0).toBe(0); // rolled back — will retry
  });

  it('does NOT tag when the library root is unavailable (empty mountpoint)', async () => {
    // An unmounted bind/network mount is a present-but-EMPTY directory: every
    // child path ENOENTs. That is evidence the ROOT is gone, not the file.
    rmSync(join(libRoot, 'marker.txt'));
    const images = makeImagesMock([liveDoc()]);
    const configColl = makeConfigMock();
    const stage = originalFileStage();

    await _test.runOnce(stage, cfg, images, configColl);
    expect(entryMissing((await images.find({}).toArray())[0]!)).toBeUndefined();
  });

  it('does NOT tag when the library is not registered (no root to verify against)', async () => {
    setLibraryRootsForTests(new Map()); // lib0 unknown
    const images = makeImagesMock([liveDoc()]);
    const configColl = makeConfigMock();
    const stage = originalFileStage();

    await _test.runOnce(stage, cfg, images, configColl);
    expect(entryMissing((await images.find({}).toArray())[0]!)).toBeUndefined();
  });

  it('does NOT tag for a non-ENOENT failure', async () => {
    const images = makeImagesMock([liveDoc('bad.raw')]);
    const configColl = makeConfigMock();
    const stage = defineStage({
      ...originalFileStage(),
      handler: async () => {
        throw new Error('decode blew up'); // no ENOENT code
      },
    });

    await _test.runOnce(stage, cfg, images, configColl);
    expect(entryMissing((await images.find({}).toArray())[0]!)).toBeUndefined();
  });

  it('does NOT tag when tagsMissingOnEnoent is unset, even on ENOENT', async () => {
    const images = makeImagesMock([liveDoc()]);
    const configColl = makeConfigMock();
    // A stage that does not read the original file never opts in.
    const stage = originalFileStage('meili', false);

    await _test.runOnce(stage, cfg, images, configColl);
    expect(entryMissing((await images.find({}).toArray())[0]!)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// no-resolvable-location → just records the skip.
//
// The legacy orphan-tagging branch is gone: a row whose every fileinfo entry is
// non-live is now PARKED by the claim query (the live-entry `$elemMatch`), so a
// file-touching stage never sees it, and whatever made the row non-live (the
// watcher `removed` handler, the modified-content guard's orphan dual-flag, or
// the ENOENT catch above) already left a per-entry `missing_since` for the
// reaper. A `no-resolvable-location` skip on a still-claimable row (e.g. its
// library is transiently unregistered) just records the reason and resets
// attempts to 0 — it does NOT tag anything.
// ---------------------------------------------------------------------------

function skipNoLocationStage(name = 'exif', tags = true) {
  return defineStage({
    name,
    targetVersion: 1,
    dependsOn: [],
    tagsMissingOnEnoent: tags,
    defaults: {
      concurrency: 1,
      maxAttempts: 3,
      paused: false,
      pausedOnFirstBoot: false,
      last_seen_target_version: 0,
    },
    handler: async () => ({ skip: 'no-resolvable-location' as const }),
  });
}

describe('runOnce — no-resolvable-location skip', () => {
  it('records the skip without tagging when a stage cannot resolve a claimed row', async () => {
    const images = makeImagesMock([liveDoc('live.raw')]);
    const configColl = makeConfigMock();
    const stage = skipNoLocationStage();

    await _test.runOnce(stage, cfg, images, configColl);
    const doc = (await images.find({}).toArray())[0]! as unknown as {
      fileinfo?: Array<{ missing_since?: string }>;
      stages?: Record<string, { last_error?: string; version?: number }>;
    };
    expect(doc.fileinfo?.[0]?.missing_since).toBeUndefined();
    expect(doc.stages?.exif?.last_error).toBe('skip: no-resolvable-location');
    expect(doc.stages?.exif?.version).toBe(1);
  });

  it('does not claim a row whose only location is already missing (parked)', async () => {
    // A row with no live entry is excluded by the claim query, so the stage
    // never runs on it — the reaper owns it now.
    const parked = {
      fileinfo: [
        {
          library_id: 'lib0',
          path: '',
          filename: 'gone.raw',
          missing_since: '2026-05-01T00:00:00Z',
        },
      ],
    } as unknown as ImageDoc;
    const images = makeImagesMock([parked]);
    const configColl = makeConfigMock();
    const stage = skipNoLocationStage();

    await _test.runOnce(stage, cfg, images, configColl);
    const doc = (await images.find({}).toArray())[0]! as unknown as {
      stages?: Record<string, { last_error?: string; version?: number }>;
    };
    // Untouched — never claimed.
    expect(doc.stages?.exif).toBeUndefined();
  });
});
