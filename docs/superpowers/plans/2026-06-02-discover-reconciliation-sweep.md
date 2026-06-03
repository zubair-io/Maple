# Discover Reconciliation Sweep — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the chokidar polling watcher (which holds an `fs.Stats` per file in heap — ~5.9 GiB over the 294k-file SMB library — and stat-walks the whole tree on the main JS thread, freezing the API event loop at `MAPLE_INDEXER_AUTOSTART=1`) with a resumable, DB-checkpointed reconciliation sweep that walks one directory at a time in a child process, keeping heap flat, and that is pausable/configurable on `/settings/workers`.

**Architecture:** A breadth-first sweep whose _frontier_ (the queue of directories still to visit) lives in Mongo, not heap. A child process pops one directory, `readdir`s a single level, reconciles that directory's files against `assets` by reusing `handleEvent` (`created`/`modified`/`removed`), enqueues subdirectories, and deletes the frontier row. Only one directory's entries are ever in memory. Deletions are detected by a **per-directory diff** (assets recorded under a dir vs. files found on disk) so no per-asset "last seen" write storm. The sweep is paced (one dir per configurable interval), registered as a non-stage worker (the `missing-reaper` precedent) so it gets pause/resume/config on the workers page. The supervisor spawns it as a child via the `ChildProcessWorker` transport from #884, gated by `MAPLE_INDEXER_AUTOSTART`.

**Tech Stack:** Bun + Elysia + MongoDB (`bun:ffi` unused here), `bun test` against a real Mongo (spin a throwaway `mongod` on :27077 — there is no in-memory Mongo), Angular 21 standalone signals for the settings control.

**Out of scope (tracked separately):** the import-worker default-priority residual; the `MAPLE_INDEXER_AUTOSTART` flag not gating the import runner. This plan only replaces discover.

---

## Verification baseline (run before Task 1)

The API CI gate is `bun test` only (`tsc --noEmit` is NOT clean on main — the bar is "no NEW tsc errors"). Integration tests need a real Mongo. Bring one up once for the whole plan:

```bash
mkdir -p /tmp/maple-plan-mongo && mongod --dbpath /tmp/maple-plan-mongo --port 27077 --bind_ip 127.0.0.1 &
# tests connect via MAPLE_MONGO_URI=mongodb://127.0.0.1:27077
```

Confirm the existing discover/worker tests are green first so regressions are attributable:

```bash
cd src/api && MAPLE_MONGO_URI=mongodb://127.0.0.1:27077 bun test src/workers/discover src/indexer/checkpoint.test.ts 2>&1 | tail -20
```

Expected: PASS (or skip if Mongo unreachable). Do NOT pipe long compiles/tests through `tail` when running via a dispatched agent watchdog — capture to a file and read it instead.

---

## File Structure

**Create:**

- `src/api/src/workers/discover/frontier.repo.ts` — the `discover_frontier` Mongo collection: enqueue/claim/complete a directory, seed a root, count remaining for a generation.
- `src/api/src/workers/discover/sweeper.ts` — pure-ish sweep core: `visitDirectory()` (readdir one level → reconcile files + enqueue subdirs + diff-delete), `advanceSweep()` (bump generation + reseed when frontier drains), and `SweeperLoop` (paced, pausable driver). No process/spawn concerns.
- `src/api/src/workers/discover/sweeper.child.ts` — child-process entry: connect to Mongo, run `SweeperLoop` until SIGTERM (mirrors `face-pool.child.ts` hardening + the existing discover `main()`).
- `src/api/src/workers/discover/discover-config.repo.ts` — read/write the `discover` row in `worker_config` (paused + `sweepDirIntervalMs`), mirroring `missing-reaper`'s config repo.
- Tests: `frontier.repo.test.ts`, `sweeper.test.ts`.

**Modify:**

- `src/api/src/db/schema.ts` — add `DiscoverFrontierDoc`; extend `CheckpointDoc` with `sweepGen`.
- `src/api/src/db/client.ts` — add `discoverFrontierCollection()` + indexes in `ensureIndexes()`.
- `src/api/src/workers/discover/index.ts` — `startDiscover` drives `SweeperLoop` instead of `new Watcher(...)`; keep the same `DiscoverHandle` shape and `main()`.
- `src/api/src/indexer/watcher.ts` — delete the chokidar `Watcher` (and drop the `chokidar` dep from `src/api/package.json`). Keep/move the `WatchEvent` type to `discover/types.ts` (it is the reconciliation contract reused by `handleEvent`).
- `src/api/src/index.ts` — under the `MAPLE_INDEXER_AUTOSTART` gate, spawn the sweeper child via `ChildProcessWorker` instead of calling `startDiscover()` in-process; stop it in `shutdown()`.
- `src/api/src/workers/registry.ts` — register `discover` as a controllable non-stage worker (the `missing-reaper` precedent) so `/api/workers/status` + pause/resume cover it.
- `src/web/projects/maple-common/src/lib/api/workers-api.service.ts` — add a typed `getDiscoverConfig()/patchDiscoverConfig()` pair (mirror the missing-reaper prune-window methods).
- `src/web/projects/maple/src/app/settings/workers/workers.component.{ts,html}` — add the discover cadence control next to the existing pause toggle (mirror the missing-reaper prune-window control).

---

## Phase 1 — Frontier collection (the in-DB queue)

### Task 1: `DiscoverFrontierDoc` schema + collection accessor

**Files:**

- Modify: `src/api/src/db/schema.ts`
- Modify: `src/api/src/db/client.ts`

- [ ] **Step 1: Add the doc type to `schema.ts`** (near the other indexer docs)

```ts
/**
 * One directory still to visit in an in-progress discover sweep. The frontier
 * lives in Mongo (not heap) so the walk's memory is O(one directory), not
 * O(tree). `(folder_id, dir_path, sweep_gen)` is unique so a re-seed can't
 * double-enqueue. `claimed_at` is a lease so a crashed sweeper's dir is retaken.
 */
export interface DiscoverFrontierDoc {
  folder_id: ObjectId;
  dir_path: string; // absolute
  sweep_gen: number;
  claimed_at: number | null; // ms epoch lease; null = free
  enqueued_at: number;
}
export type DiscoverFrontierWithId = WithId<DiscoverFrontierDoc>;
```

- [ ] **Step 2: Add the collection accessor + indexes in `client.ts`**

In `client.ts`, add next to `importFilesCollection`:

```ts
export async function discoverFrontierCollection(): Promise<Collection<DiscoverFrontierDoc>> {
  return (await getDb()).collection<DiscoverFrontierDoc>('discover_frontier');
}
```

In `ensureIndexes()`, add:

```ts
await db
  .collection('discover_frontier')
  .createIndex(
    { folder_id: 1, dir_path: 1, sweep_gen: 1 },
    { unique: true, name: 'discover_frontier_key' },
  );
// Claim query: free (or lease-expired) rows for the active generation, oldest first.
await db.collection('discover_frontier').createIndex(
  { folder_id: 1, sweep_gen: 1, claimed_at: 1, enqueued_at: 1 },
  {
    name: 'discover_frontier_claim',
  },
);
```

Add `DiscoverFrontierDoc` to the existing `import type { ... } from '../db/schema.ts'` block in `client.ts`.

- [ ] **Step 3: Commit**

```bash
git add src/api/src/db/schema.ts src/api/src/db/client.ts
git commit -m "feat(discover): add discover_frontier collection + indexes"
```

### Task 2: `frontier.repo.ts` — enqueue / claim / complete

**Files:**

- Create: `src/api/src/workers/discover/frontier.repo.ts`
- Test: `src/api/src/workers/discover/frontier.repo.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, beforeAll, beforeEach } from 'bun:test';
import { ObjectId } from 'mongodb';
import { getDb } from '../../db/client.ts';

let reachable = true;
beforeAll(async () => {
  try {
    await getDb();
  } catch {
    reachable = false;
  }
});
beforeEach(async () => {
  if (!reachable) return;
  await (await getDb()).collection('discover_frontier').deleteMany({});
});

describe('frontier.repo', () => {
  it('seeds a root, claims it exactly once, then completes it', async () => {
    if (!reachable) return;
    const repo = await import('./frontier.repo.ts');
    const folder = new ObjectId();
    await repo.seedRoot(folder, '/srv/photos/Library', 1);

    const a = await repo.claimNextDir(folder, 1, 60_000);
    const b = await repo.claimNextDir(folder, 1, 60_000);
    expect(a?.dir_path).toBe('/srv/photos/Library');
    expect(b).toBeNull(); // already claimed (lease held)

    await repo.enqueueDirs(folder, ['/srv/photos/Library/2024'], 1);
    expect(await repo.remainingForGen(folder, 1)).toBe(2); // root (claimed) + child

    await repo.completeDir(a!._id);
    expect(await repo.remainingForGen(folder, 1)).toBe(1);
  });

  it('re-claims a dir whose lease expired', async () => {
    if (!reachable) return;
    const repo = await import('./frontier.repo.ts');
    const folder = new ObjectId();
    await repo.seedRoot(folder, '/x', 1);
    await repo.claimNextDir(folder, 1, -1); // already-expired lease
    const again = await repo.claimNextDir(folder, 1, 60_000);
    expect(again?.dir_path).toBe('/x');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd src/api && MAPLE_MONGO_URI=mongodb://127.0.0.1:27077 bun test src/workers/discover/frontier.repo.test.ts`
Expected: FAIL — `Cannot find module './frontier.repo.ts'`.

- [ ] **Step 3: Implement `frontier.repo.ts`**

```ts
/**
 * The discover sweep frontier — the queue of directories still to visit, in
 * Mongo so the walk's memory is O(one directory). Claim is atomic
 * (findOneAndUpdate) so only one sweeper visits a given dir; a lease lets a
 * crashed sweeper's dir be retaken.
 */
import { ObjectId, type WithId } from 'mongodb';
import { discoverFrontierCollection } from '../../db/client.ts';
import type { DiscoverFrontierDoc } from '../../db/schema.ts';

export type FrontierDir = WithId<DiscoverFrontierDoc>;

/** Insert the root dir for a fresh generation (no-op if it already exists). */
export async function seedRoot(folderId: ObjectId, rootPath: string, gen: number): Promise<void> {
  await enqueueDirs(folderId, [rootPath], gen);
}

/** Insert child directories for the current generation, ignoring duplicates. */
export async function enqueueDirs(folderId: ObjectId, dirs: string[], gen: number): Promise<void> {
  if (dirs.length === 0) return;
  const coll = await discoverFrontierCollection();
  const now = Date.now();
  const docs: DiscoverFrontierDoc[] = dirs.map((d) => ({
    folder_id: folderId,
    dir_path: d,
    sweep_gen: gen,
    claimed_at: null,
    enqueued_at: now,
  }));
  // ordered:false so a duplicate-key on one dir doesn't drop the rest.
  await coll.insertMany(docs, { ordered: false }).catch((err: unknown) => {
    // E11000 duplicate key is expected on re-seed; rethrow anything else.
    const code = (err as { code?: number }).code;
    if (code !== 11000 && !(err as { writeErrors?: unknown[] }).writeErrors) throw err;
  });
}

/** Atomically claim the oldest free (or lease-expired) dir for `gen`. */
export async function claimNextDir(
  folderId: ObjectId,
  gen: number,
  leaseMs: number,
): Promise<FrontierDir | null> {
  const coll = await discoverFrontierCollection();
  const now = Date.now();
  const res = await coll.findOneAndUpdate(
    {
      folder_id: folderId,
      sweep_gen: gen,
      $or: [{ claimed_at: null }, { claimed_at: { $lt: now - leaseMs } }],
    },
    { $set: { claimed_at: now } },
    { sort: { enqueued_at: 1, _id: 1 }, returnDocument: 'after' },
  );
  return res as FrontierDir | null;
}

/** Remove a finished dir from the frontier. */
export async function completeDir(id: ObjectId): Promise<void> {
  const coll = await discoverFrontierCollection();
  await coll.deleteOne({ _id: id });
}

/** Rows left for a generation (claimed or not). 0 ⇒ sweep of that gen done. */
export async function remainingForGen(folderId: ObjectId, gen: number): Promise<number> {
  const coll = await discoverFrontierCollection();
  return coll.countDocuments({ folder_id: folderId, sweep_gen: gen });
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd src/api && MAPLE_MONGO_URI=mongodb://127.0.0.1:27077 bun test src/workers/discover/frontier.repo.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/api/src/workers/discover/frontier.repo.ts src/api/src/workers/discover/frontier.repo.test.ts
git commit -m "feat(discover): frontier repo — atomic dir claim with lease"
```

---

## Phase 2 — Sweep core (reconcile one directory)

### Task 3: `visitDirectory()` — readdir one level, reconcile, enqueue subdirs, diff-delete

**Files:**

- Create: `src/api/src/workers/discover/sweeper.ts`
- Test: `src/api/src/workers/discover/sweeper.test.ts`

Reconciliation reuses the existing per-event core: `handleEvent(event: WatchEvent, folderId: ObjectId, libraryRoot: string)` where `WatchEvent.kind ∈ {'created','modified','removed','renamed'}` (see `handle-event.ts`). `created`/`modified` upsert the asset with the stage skeleton; `removed` soft-deletes. We therefore do NOT touch `assets` directly — we compute _what changed in this directory_ and emit the same events the watcher used to.

Deletion is a **per-directory diff**: list the non-deleted assets whose `fileinfo` entry sits directly in this dir (`{ library_id: folderId, path: <relDir> }`), compare their filenames to what's on disk, and emit `removed` for the gap. This is why there is no per-asset "last seen" write.

- [ ] **Step 1: Write the failing test** (uses a real temp dir + real Mongo; injects a fake `handleEvent` to assert the emitted events)

```ts
import { describe, it, expect, beforeAll, beforeEach } from 'bun:test';
import { ObjectId } from 'mongodb';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getDb, assetsCollection } from '../../db/client.ts';
import type { WatchEvent } from './types.ts';

let reachable = true;
beforeAll(async () => {
  try {
    await getDb();
  } catch {
    reachable = false;
  }
});
beforeEach(async () => {
  if (!reachable) return;
  await (await getDb()).collection('discover_frontier').deleteMany({});
  await (await assetsCollection()).deleteMany({});
});

describe('visitDirectory', () => {
  it('enqueues subdirs, emits created for new images, removed for vanished assets', async () => {
    if (!reachable) return;
    const { visitDirectory } = await import('./sweeper.ts');
    const frontier = await import('./frontier.repo.ts');

    const root = mkdtempSync(join(tmpdir(), 'maple-sweep-'));
    mkdirSync(join(root, 'sub'));
    writeFileSync(join(root, 'a.dng'), 'x'); // new on disk, not recorded → created
    writeFileSync(join(root, 'c.dng'), 'x'); // on disk AND recorded → skipped (no event)
    writeFileSync(join(root, 'note.txt'), 'ignored'); // non-image: skipped

    const folderId = new ObjectId();
    await (
      await assetsCollection()
    ).insertMany([
      // recorded but NOT on disk → removed
      {
        maple_id: 'gone1',
        fileinfo: [{ library_id: folderId, path: '', filename: 'b.dng' }],
        deleted_at: null,
      },
      // recorded AND on disk, unchanged → must emit NOTHING (no write storm)
      {
        maple_id: 'keep1',
        fileinfo: [{ library_id: folderId, path: '', filename: 'c.dng' }],
        deleted_at: null,
      },
    ] as never);

    const events: WatchEvent[] = [];
    await frontier.seedRoot(folderId, root, 1);
    const dir = await frontier.claimNextDir(folderId, 1, 60_000);

    await visitDirectory(dir!, root, {
      handleEvent: async (e) => {
        events.push(e);
      },
      folderId,
    });

    // subdir enqueued for the same generation
    expect(await frontier.remainingForGen(folderId, 1)).toBeGreaterThanOrEqual(1);
    const kinds = events.map((e) => `${e.kind}:${e.absPath.split('/').pop()}`);
    expect(kinds).toContain('created:a.dng');
    expect(kinds).toContain('removed:b.dng');
    expect(kinds.find((k) => k.includes('c.dng'))).toBeUndefined(); // unchanged → no write
    expect(kinds.find((k) => k.includes('note.txt'))).toBeUndefined();

    rmSync(root, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd src/api && MAPLE_MONGO_URI=mongodb://127.0.0.1:27077 bun test src/workers/discover/sweeper.test.ts`
Expected: FAIL — `Cannot find module './sweeper.ts'`.

- [ ] **Step 3: Implement `visitDirectory()` in `sweeper.ts`**

```ts
/**
 * Discover reconciliation sweep — the chokidar replacement. Walks one directory
 * per call: enqueues subdirs onto the frontier, emits created/modified for new
 * or changed images via the injected `handleEvent`, and emits removed for
 * assets recorded in this dir whose file is gone (per-directory diff — no
 * whole-tree state, no per-asset "seen" write).
 */
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { ObjectId } from 'mongodb';
import { assetsCollection } from '../../db/client.ts';
import { SUPPORTED_EXTS } from './types.ts';
import type { WatchEvent } from './types.ts';
import * as frontier from './frontier.repo.ts';
import type { FrontierDir } from './frontier.repo.ts';

export interface ReconcileDeps {
  handleEvent: (event: WatchEvent, folderId: ObjectId, libraryRoot: string) => Promise<void>;
  folderId: ObjectId;
}

function isSupported(name: string): boolean {
  return SUPPORTED_EXTS.has(path.extname(name).toLowerCase());
}

/** Relative directory path of `absDir` under `root`, '' for the root itself. */
function relDir(root: string, absDir: string): string {
  const rel = path.relative(root, absDir);
  return rel === '' ? '' : rel;
}

export async function visitDirectory(
  dir: FrontierDir,
  root: string,
  deps: ReconcileDeps,
): Promise<void> {
  const { folderId } = deps;
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(dir.dir_path, { withFileTypes: true });
  } catch {
    // Vanished/unreadable dir: drop it from the frontier and move on.
    await frontier.completeDir(dir._id);
    return;
  }

  const subdirs: string[] = [];
  const filesOnDisk = new Map<string, string>(); // filename -> absPath (images only)

  for (const ent of entries) {
    const abs = path.join(dir.dir_path, ent.name);
    if (ent.isDirectory()) {
      subdirs.push(abs);
      continue;
    }
    if (!ent.isFile() || !isSupported(ent.name)) continue;
    filesOnDisk.set(ent.name, abs);
  }

  // ONE indexed read per dir: the non-deleted assets recorded directly in it.
  // Drives BOTH "what's new" and "what's gone" — so writes happen only on real
  // changes, never a per-file upsert storm.
  const rel = relDir(root, dir.dir_path);
  const coll = await assetsCollection();
  const recorded = (await coll
    .find(
      { deleted_at: null, fileinfo: { $elemMatch: { library_id: folderId, path: rel } } },
      { projection: { 'fileinfo.$': 1 } },
    )
    .toArray()) as Array<{ fileinfo: Array<{ filename: string }> }>;
  const recordedNames = new Set<string>();
  for (const a of recorded) {
    const fn = a.fileinfo?.[0]?.filename;
    if (fn) recordedNames.add(fn);
  }

  // New files only → created (handleEvent upserts the stage skeleton). Files
  // already recorded are SKIPPED — no write.
  for (const [name, abs] of filesOnDisk) {
    if (recordedNames.has(name)) continue;
    await deps.handleEvent({ kind: 'created', absPath: abs }, folderId, root);
  }

  // Recorded files no longer on disk → removed (soft-delete via handleEvent).
  for (const a of recorded) {
    const fn = a.fileinfo?.[0]?.filename;
    if (fn && !filesOnDisk.has(fn)) {
      await deps.handleEvent(
        { kind: 'removed', absPath: path.join(dir.dir_path, fn) },
        folderId,
        root,
      );
    }
  }

  await frontier.enqueueDirs(folderId, subdirs, dir.sweep_gen);
  await frontier.completeDir(dir._id);
}
```

> **Modified-in-place (same path, new bytes) is intentionally NOT detected by the sweep** — that would need a stored `mtime`/`size` per asset to compare, and out-of-band edits to library originals are rare (new files arrive via the import worker's direct `handleEvent`). If wanted later, store `mtime` on the asset and emit `'modified'` when `st.mtimeMs` advances. Keeping the sweep existence-only is what makes it write-light: **one read per directory, writes only for genuine adds/deletes.**

````

- [ ] **Step 4: Run to verify it passes**

Run: `cd src/api && MAPLE_MONGO_URI=mongodb://127.0.0.1:27077 bun test src/workers/discover/sweeper.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/api/src/workers/discover/sweeper.ts src/api/src/workers/discover/sweeper.test.ts
git commit -m "feat(discover): visitDirectory — one-level reconcile + per-dir delete diff"
````

### Task 4: `advanceSweep()` — bump generation + reseed when the frontier drains

**Files:**

- Modify: `src/api/src/workers/discover/sweeper.ts`
- Modify: `src/api/src/db/schema.ts` (extend `CheckpointDoc` with `sweepGen`)
- Test: `src/api/src/workers/discover/sweeper.test.ts` (add a case)

- [ ] **Step 1: Add `sweepGen` to `CheckpointDoc`** in `schema.ts` (or in `indexer/checkpoint.ts` where `CheckpointDoc` is defined — it lives there). Add field:

```ts
  /** Active discover sweep generation for this folder. */
  sweepGen?: number;
```

- [ ] **Step 2: Write the failing test** (append to `sweeper.test.ts`)

```ts
it('advanceSweep bumps generation and reseeds the root when the frontier is empty', async () => {
  if (!reachable) return;
  const { advanceSweep } = await import('./sweeper.ts');
  const frontier = await import('./frontier.repo.ts');
  const folderId = new ObjectId();

  // Frontier empty for gen 1 ⇒ advance to gen 2 and reseed the root.
  const next = await advanceSweep(folderId, '/srv/photos/Library', 1);
  expect(next).toBe(2);
  expect(await frontier.remainingForGen(folderId, 2)).toBe(1);
});
```

- [ ] **Step 3: Implement `advanceSweep()`** in `sweeper.ts`

```ts
import { readCheckpoint, writeCheckpoint } from '../../indexer/checkpoint.ts';

/**
 * If the current generation's frontier is drained, start the next generation:
 * record the completed walk on the checkpoint and reseed the root dir. Returns
 * the generation to sweep next (unchanged if work remains).
 */
export async function advanceSweep(
  folderId: ObjectId,
  rootPath: string,
  gen: number,
): Promise<number> {
  if ((await frontier.remainingForGen(folderId, gen)) > 0) return gen;
  const nextGen = gen + 1;
  const fid = folderId.toHexString();
  const existing = await readCheckpoint(fid);
  await writeCheckpoint({
    folderId: fid,
    path: rootPath,
    lastWalkedAt: Date.now(),
    inflightIds: existing?.inflightIds ?? [],
    sweepGen: nextGen,
    updatedAt: Date.now(),
  });
  await frontier.seedRoot(folderId, rootPath, nextGen);
  return nextGen;
}
```

- [ ] **Step 4: Run to verify both sweeper tests pass**

Run: `cd src/api && MAPLE_MONGO_URI=mongodb://127.0.0.1:27077 bun test src/workers/discover/sweeper.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/api/src/workers/discover/sweeper.ts src/api/src/indexer/checkpoint.ts src/api/src/workers/discover/sweeper.test.ts
git commit -m "feat(discover): advanceSweep — generational reseed via checkpoint"
```

### Task 5: `SweeperLoop` — paced, pausable driver

**Files:**

- Modify: `src/api/src/workers/discover/sweeper.ts`
- Test: `src/api/src/workers/discover/sweeper.test.ts` (add a case with injected sleep + config)

- [ ] **Step 1: Write the failing test**

```ts
it('SweeperLoop visits dirs paced by interval and halts when paused', async () => {
  if (!reachable) return;
  const { SweeperLoop } = await import('./sweeper.ts');
  const frontier = await import('./frontier.repo.ts');
  const root = mkdtempSync(join(tmpdir(), 'maple-loop-'));
  mkdirSync(join(root, 'a'));
  mkdirSync(join(root, 'b'));
  const folderId = new ObjectId();
  await frontier.seedRoot(folderId, root, 1);

  let paused = false;
  const visited: string[] = [];
  const loop = new SweeperLoop({
    folderId,
    root,
    deps: { folderId, handleEvent: async () => {} },
    loadConfig: async () => ({ paused, sweepDirIntervalMs: 0 }),
    sleep: async () => {},
    onVisit: (p) => {
      visited.push(p);
      if (visited.length === 3) paused = true;
    },
  });
  await loop.runUntilIdleOrPaused(); // test-only bound
  expect(visited.length).toBeGreaterThanOrEqual(3);
  rmSync(root, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd src/api && MAPLE_MONGO_URI=mongodb://127.0.0.1:27077 bun test src/workers/discover/sweeper.test.ts`
Expected: FAIL — `SweeperLoop is not a constructor`.

- [ ] **Step 3: Implement `SweeperLoop`** in `sweeper.ts`

```ts
const LEASE_MS = 5 * 60 * 1000;

export interface SweepConfig {
  paused: boolean;
  sweepDirIntervalMs: number;
}

export interface SweeperLoopOpts {
  folderId: ObjectId;
  root: string;
  deps: ReconcileDeps;
  loadConfig: () => Promise<SweepConfig>;
  sleep?: (ms: number) => Promise<void>;
  onVisit?: (dirPath: string) => void;
}

export class SweeperLoop {
  private shuttingDown = false;
  private gen = 1;
  private readonly o: SweeperLoopOpts;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(o: SweeperLoopOpts) {
    this.o = o;
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  stop(): void {
    this.shuttingDown = true;
  }

  /** One claim→visit→pace cycle. Returns false when idle (nothing to do). */
  private async tick(cfg: SweepConfig): Promise<boolean> {
    const dir = await frontier.claimNextDir(this.o.folderId, this.gen, LEASE_MS);
    if (!dir) {
      this.gen = await advanceSweep(this.o.folderId, this.o.root, this.gen);
      return false;
    }
    this.o.onVisit?.(dir.dir_path);
    await visitDirectory(dir, this.o.root, this.o.deps);
    await this.sleep(cfg.sweepDirIntervalMs);
    return true;
  }

  /** Production loop: run until stop(); idle ⇒ sleep one interval and retry. */
  async run(): Promise<void> {
    while (!this.shuttingDown) {
      const cfg = await this.o.loadConfig();
      if (cfg.paused) {
        await this.sleep(Math.max(1000, cfg.sweepDirIntervalMs));
        continue;
      }
      const did = await this.tick(cfg);
      if (!did) await this.sleep(Math.max(1000, cfg.sweepDirIntervalMs));
    }
  }

  /** Test-only: drain until idle or a config flips paused. */
  async runUntilIdleOrPaused(): Promise<void> {
    for (;;) {
      const cfg = await this.o.loadConfig();
      if (cfg.paused) return;
      if (!(await this.tick(cfg))) return;
    }
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd src/api && MAPLE_MONGO_URI=mongodb://127.0.0.1:27077 bun test src/workers/discover/sweeper.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/api/src/workers/discover/sweeper.ts src/api/src/workers/discover/sweeper.test.ts
git commit -m "feat(discover): SweeperLoop — paced, pausable driver"
```

---

## Phase 3 — Config, child process, and supervisor wiring

### Task 6: `discover-config.repo.ts` (mirror missing-reaper's config repo)

**Files:**

- Create: `src/api/src/workers/discover/discover-config.repo.ts`
- Test: `src/api/src/workers/discover/discover-config.repo.test.ts`

**Read first:** `src/api/src/workers/missing-reaper-config.repo.ts` (the prune-window repo — `loadPruneWindowHours`) and `src/api/src/workers/worker-config.repo.ts` (the `worker_config` collection, keyed by `name`). Mirror that shape exactly: a `discover` row with `{ paused: boolean, sweepDirIntervalMs: number }`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, beforeAll, beforeEach } from 'bun:test';
import { getDb } from '../../db/client.ts';
let reachable = true;
beforeAll(async () => {
  try {
    await getDb();
  } catch {
    reachable = false;
  }
});
beforeEach(async () => {
  if (reachable) await (await getDb()).collection('worker_config').deleteMany({ name: 'discover' });
});

describe('discover-config.repo', () => {
  it('returns defaults when unset, persists patches', async () => {
    if (!reachable) return;
    const repo = await import('./discover-config.repo.ts');
    expect(await repo.loadDiscoverConfig()).toEqual({ paused: false, sweepDirIntervalMs: 250 });
    await repo.patchDiscoverConfig({ sweepDirIntervalMs: 1000 });
    expect((await repo.loadDiscoverConfig()).sweepDirIntervalMs).toBe(1000);
  });
});
```

- [ ] **Step 2: Run to verify it fails.** Run: `cd src/api && MAPLE_MONGO_URI=mongodb://127.0.0.1:27077 bun test src/workers/discover/discover-config.repo.test.ts` — Expected: FAIL (module missing).

- [ ] **Step 3: Implement** (defaults: not paused, 250 ms/dir — a backstop cadence, ~4 dirs/s; imports index files directly so this need not be fast)

```ts
/**
 * `discover` worker config in the shared `worker_config` collection (the same
 * collection stages + missing-reaper use), keyed by name. Operator-tunable on
 * /settings/workers — NOT an env var (repo convention).
 */
// The `worker_config` collection is shared with the stages (keyed by `name`).
// There is no exported accessor — open it directly, exactly as the PATCH route
// does (`routes-main.ts`: `const coll = (await getDb()).collection('worker_config')`).
// `WorkerConfigRepo.load()` only projects the stage fields (concurrency/
// maxAttempts/paused/last_seen_target_version), so discover reads its own
// `{paused, sweepDirIntervalMs}` here rather than reusing it.
import { getDb } from '../../db/client.ts';

export interface DiscoverConfig {
  paused: boolean;
  sweepDirIntervalMs: number;
}
const DEFAULTS: DiscoverConfig = { paused: false, sweepDirIntervalMs: 250 };
const NAME = 'discover';

interface DiscoverConfigDoc {
  name: string;
  paused?: boolean;
  sweepDirIntervalMs?: number;
}

export async function loadDiscoverConfig(): Promise<DiscoverConfig> {
  const coll = (await getDb()).collection<DiscoverConfigDoc>('worker_config');
  const doc = await coll.findOne({ name: NAME });
  return {
    paused: doc?.paused ?? DEFAULTS.paused,
    sweepDirIntervalMs: doc?.sweepDirIntervalMs ?? DEFAULTS.sweepDirIntervalMs,
  };
}

export async function patchDiscoverConfig(patch: Partial<DiscoverConfig>): Promise<void> {
  const coll = (await getDb()).collection<DiscoverConfigDoc>('worker_config');
  await coll.updateOne({ name: NAME }, { $set: { name: NAME, ...patch } }, { upsert: true });
}
```

- [ ] **Step 4: Run to verify it passes.** Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/api/src/workers/discover/discover-config.repo.ts src/api/src/workers/discover/discover-config.repo.test.ts src/api/src/workers/worker-config.repo.ts
git commit -m "feat(discover): discover worker_config (paused + sweepDirIntervalMs)"
```

### Task 7: Rewire `startDiscover` to drive `SweeperLoop`; delete chokidar

**Files:**

- Modify: `src/api/src/workers/discover/index.ts`
- Modify: `src/api/src/workers/discover/types.ts` (move `WatchEvent` here from `watcher.ts`)
- Delete: `src/api/src/indexer/watcher.ts` (and its test); remove `chokidar` from `src/api/package.json`

- [ ] **Step 1: Move the `WatchEvent` type** out of `watcher.ts` into `discover/types.ts` (it is the reconciliation contract; `handle-event.ts` and `sweeper.ts` import it). Keep the shape identical:

```ts
export interface WatchEvent {
  kind: 'created' | 'modified' | 'removed' | 'renamed';
  absPath: string;
  fromPath?: string;
}
```

Update the import in `handle-event.ts` from `../../indexer/watcher.ts` to `./types.ts`.

- [ ] **Step 2: Rewrite `startDiscover`** in `index.ts` to run one `SweeperLoop` per root instead of `new Watcher(...)`. The per-event folder resolution stays (longest-prefix `resolveFolder`); pass a `handleEvent` bound to the resolved folder.

```ts
import { SweeperLoop } from './sweeper.ts';
import { loadDiscoverConfig } from './discover-config.repo.ts';
import { seedRoot } from './frontier.repo.ts';

export async function startDiscover(opts: DiscoverOptions): Promise<DiscoverHandle> {
  const foldersColl = await foldersCollection();
  const folderDocs = (await foldersColl.find({}, { projection: { path: 1 } }).toArray()) as Array<{
    _id: ObjectId;
    path: string;
  }>;

  const loops: SweeperLoop[] = [];
  for (const root of opts.roots) {
    const folder = resolveFolder(root, folderDocs) ?? resolveFolder(root + '/', folderDocs);
    if (!folder) {
      log.warn({ root }, 'no registered folder matched root — skipping');
      continue;
    }
    await seedRoot(folder.id, root, 1);
    const loop = new SweeperLoop({
      folderId: folder.id,
      root,
      deps: { folderId: folder.id, handleEvent },
      loadConfig: loadDiscoverConfig,
    });
    loops.push(loop);
    void loop
      .run()
      .catch((err) =>
        log.error({ root, err: err instanceof Error ? err.message : err }, 'sweeper loop crashed'),
      );
  }

  return {
    stop: async () => {
      for (const l of loops) l.stop();
    },
  };
}
```

> `resolveFolder` currently maps a _file_ path to its folder; a root path equals a folder path, so call it with `root` (and the `+ '/'` fallback) — confirm it returns the folder whose `path === root`.

- [ ] **Step 3: Delete chokidar.** `git rm src/api/src/indexer/watcher.ts src/api/src/indexer/watcher.test.ts` (if a test exists). Remove `"chokidar": "..."` from `src/api/package.json` dependencies. Run `bun install` in `src/api` to update the lockfile.

- [ ] **Step 4: Verify nothing else imports the deleted module**

Run: `cd src/api && rg -n "indexer/watcher|from 'chokidar'|from \"chokidar\"" src --glob '!**/*.test.ts'`
Expected: no matches (only `discover/types.ts` now owns `WatchEvent`).

- [ ] **Step 5: Run the discover test suite**

Run: `cd src/api && MAPLE_MONGO_URI=mongodb://127.0.0.1:27077 bun test src/workers/discover 2>&1 | tail -30`
Expected: PASS (existing handle-event/skeleton tests + the new sweeper/frontier tests). Fix any test that imported `WatchEvent` from the old path.

- [ ] **Step 6: Commit**

```bash
git add -A src/api/src/workers/discover src/api/src/indexer src/api/package.json src/api/bun.lock
git commit -m "feat(discover): drive sweep from startDiscover; remove chokidar watcher"
```

### Task 8: Child-process entry + supervisor spawn under the autostart gate

**Files:**

- Create: `src/api/src/workers/discover/sweeper.child.ts`
- Modify: `src/api/src/index.ts`

**Read first:** `src/api/src/enrichment/face-pool.child.ts` and `src/api/src/runtime/child-process-worker.ts` (the #884 transport: `ChildProcessWorker`, `childScriptPath`, `installChildHardening`, `DEFAULT_NATIVE_CHILD_NICE`). The discover child has no native crash risk, so it does not need crash-isolation — but running it as a niced child keeps its polling/stat CPU off the API event loop, which is the whole point.

- [ ] **Step 1: Implement `sweeper.child.ts`**

```ts
/**
 * Discover sweep child process. Runs the reconciliation SweeperLoop off the API
 * event loop (the freeze fix). Roots arrive as argv. Self-nices + self-exits if
 * orphaned via installChildHardening. Connects to Mongo independently.
 */
import { installChildHardening } from '../../runtime/child-process-worker.ts';
import { getDb, ensureIndexes, closeDb } from '../../db/client.ts';
import { startDiscover } from './index.ts';
import { child as childLogger } from '../../log.ts';

installChildHardening('discover');
const log = childLogger('discover-child');

async function main(): Promise<void> {
  const roots = process.argv.slice(2);
  if (roots.length === 0) {
    process.stderr.write('discover child: no roots\n');
    process.exit(1);
  }
  await getDb().then(() => ensureIndexes());
  const handle = await startDiscover({ roots });
  log.info({ roots }, 'discover sweep started');
  const shutdown = async () => {
    await handle.stop();
    await closeDb();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());
}
main().catch((e) => {
  process.stderr.write(`[discover-child] fatal: ${e instanceof Error ? e.message : e}\n`);
  process.exit(1);
});
```

- [ ] **Step 2: Spawn it from the supervisor** in `src/api/src/index.ts`, inside the `MAPLE_INDEXER_AUTOSTART !== '0'` branch, replacing the in-process `startDiscover` call. Use `ChildProcessWorker` so it is niced and orphan-guarded:

```ts
import {
  ChildProcessWorker,
  childScriptPath,
  DEFAULT_NATIVE_CHILD_NICE,
} from './runtime/child-process-worker.ts';

// inside the autostart else-branch, where _discoverHandle was set:
const discoverRoots = folders.map((f) => f.path).filter(Boolean);
if (discoverRoots.length > 0) {
  _discoverChild = new ChildProcessWorker(
    childScriptPath(import.meta.url, './workers/discover/sweeper.child.ts'),
    { nice: DEFAULT_NATIVE_CHILD_NICE, label: 'discover', argv: discoverRoots },
  );
}
```

> `ChildProcessWorker` currently spawns `[process.execPath, scriptPath]` with no extra argv (see #884). Add an optional `argv?: string[]` to `ChildProcessWorkerOptions` and append it to the `Bun.spawn([process.execPath, scriptPath, ...argv])` array. The discover child reads roots from `process.argv.slice(2)`. This is a 2-line change to `runtime/child-process-worker.ts`; keep the existing FFI/face callers (no argv) working.

- [ ] **Step 3: Stop it in `shutdown()`** — replace `_discoverHandle.stop()` with `_discoverChild?.terminate()`. Update the `_discoverHandle` declaration to `let _discoverChild: ChildProcessWorker | null = null;`.

- [ ] **Step 4: Build-import smoke check** (the app runs from source; just confirm it imports + boots cleanly)

Run: `cd src/api && MAPLE_INDEXER_AUTOSTART=0 MAPLE_MONGO_URI=mongodb://127.0.0.1:27077 timeout-free: bun -e "await import('./src/index.ts')" 2>&1 | tail -5`
(There is no `timeout` on macOS; if running locally just start `bun src/index.ts`, curl `/api/health`, Ctrl-C.)
Expected: boots, `/api/health` returns 200; with `=0` no discover child spawns.

- [ ] **Step 5: Commit**

```bash
git add src/api/src/workers/discover/sweeper.child.ts src/api/src/index.ts src/api/src/runtime/child-process-worker.ts
git commit -m "feat(discover): run sweep in a niced child process under the autostart gate"
```

### Task 9: Register `discover` as a controllable worker (pause/resume/status)

**Files:**

- Create: `src/api/src/workers/discover/register.ts`
- Modify: `src/api/src/workers/routes-main.ts` (add `sweepDirIntervalMs` to the config validator)
- Modify: `src/api/src/index.ts` (register at boot, unregister on shutdown)

The registry (`stageRegistry`, `registry.ts`) is a **main-process singleton** with `register(name, entry)` where `entry` is `{ targetVersion, dependsOn, getInFlight, getThroughput, getPaused, reloadConfig, pause, resume }` (see the interface at `registry.ts:25`). The sweeper runs in the **child**, so the entry's `pause()`/`resume()` only write `worker_config.discover.paused`; the child's `SweeperLoop` reads `loadDiscoverConfig()` every tick and picks it up within one interval. This mirrors `missing-reaper.ts:532` (`stageRegistry.register(MISSING_REAPER_NAME, { getPaused: () => paused, pause: async () => …patch…, … })`).

- [ ] **Step 1: Implement `register.ts`**

```ts
/** Register `discover` as a controllable worker so /api/workers/status + the
 * generic pause/resume/config routes cover it. The sweeper itself runs in a
 * child; these callbacks only touch worker_config (the child polls it). */
import { stageRegistry } from '../registry.ts';
import { loadDiscoverConfig, patchDiscoverConfig } from './discover-config.repo.ts';

export const DISCOVER_NAME = 'discover';
let cachedPaused = false;

export function registerDiscoverWorker(): void {
  stageRegistry.register(DISCOVER_NAME, {
    targetVersion: 0,
    dependsOn: [],
    getInFlight: () => 0,
    getThroughput: () => 0,
    getPaused: () => cachedPaused,
    reloadConfig: async () => {
      cachedPaused = (await loadDiscoverConfig()).paused;
    },
    pause: async () => {
      await patchDiscoverConfig({ paused: true });
      cachedPaused = true;
    },
    resume: async () => {
      await patchDiscoverConfig({ paused: false });
      cachedPaused = false;
    },
  });
  void loadDiscoverConfig().then((c) => {
    cachedPaused = c.paused;
  });
}

export function unregisterDiscoverWorker(): void {
  stageRegistry.unregister(DISCOVER_NAME);
}
```

- [ ] **Step 2: Allow `sweepDirIntervalMs` through the generic PATCH validator.** In `routes-main.ts`, the `.patch('/:name/config', …)` body `t.Object({ … })` (~line 410) — add one line so the cadence write is bounds-checked (the body is `additionalProperties:true`, so it would pass through unvalidated otherwise):

```ts
            sweepDirIntervalMs: t.Optional(t.Integer({ minimum: 0, maximum: 60_000 })),
```

The handler already 404s unless `stageRegistry.has(params.name)` — true once `registerDiscoverWorker()` ran — then `WorkerConfigRepo.patch` writes the field and `notifyConfigChanged('discover')` fires the entry's `reloadConfig` (refreshing `cachedPaused`).

- [ ] **Step 3: Call register/unregister in `index.ts`.** In the `MAPLE_INDEXER_AUTOSTART !== '0'` branch (right where the discover child is spawned, Task 8), add `registerDiscoverWorker()`. In `shutdown()`, add `unregisterDiscoverWorker()`.

- [ ] **Step 4: Integration test** — register, then drive the generic routes. New file `src/api/src/workers/discover/register.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'bun:test';
import { stageRegistry } from '../registry.ts';
import { registerDiscoverWorker, unregisterDiscoverWorker, DISCOVER_NAME } from './register.ts';

afterEach(() => unregisterDiscoverWorker());

describe('registerDiscoverWorker', () => {
  it('appears in statuses() and pause() flips paused', async () => {
    registerDiscoverWorker();
    expect(DISCOVER_NAME in stageRegistry.statuses()).toBe(true);
    await stageRegistry.pause(DISCOVER_NAME); // writes worker_config + cachedPaused
    expect(stageRegistry.statuses()[DISCOVER_NAME].status).toBe('paused');
  });
});
```

- [ ] **Step 5: Run** `cd src/api && MAPLE_MONGO_URI=mongodb://127.0.0.1:27077 bun test src/workers/discover/register.test.ts` — Expected: PASS.

- [ ] **Step 6: Commit** `git commit -am "feat(discover): register discover for pause/resume/config on /api/workers"`

---

## Phase 4 — Workers page control

### Task 10: Web — discover cadence + pause control on `/settings/workers`

**Files:**

- Modify: `src/web/projects/maple-common/src/lib/api/workers-api.service.ts`
- Modify: `src/web/projects/maple/src/app/settings/workers/workers.component.ts`
- Modify: `src/web/projects/maple/src/app/settings/workers/workers.component.html`
- Modify: `src/web/projects/maple/src/app/settings/workers/workers.component.spec.ts`

The web service already has everything: `WorkersApiService.pause(name)` (`workers-api.service.ts:182`), `resume(name)` (:186), `patchConfig(name, patch)` → `PATCH /workers/:name/config` (:197), `getStatus()` → `GET /workers/status` (:158, one row per worker incl. `config`), and the missing-reaper `getPruneWindow()` (:210) as the read-a-dedicated-config precedent. The component already calls `this.api.patchConfig(stage.name, patch)` (`workers.component.ts:434`). **The pause toggle needs no new web code** — `discover` shows up in `getStatus()` once Task 9 registers it, so the existing per-worker pause button renders automatically.

- [ ] **Step 1 (TDD, Angular):** In `workers.component.spec.ts`, add an `http.expectOne((r) => r.method === 'PATCH' && r.url === '/api/workers/discover/config')` expectation when the cadence input commits (mirror the existing `patchConfig` spec). Run `cd src/web && bun x ng test maple --watch=false --include='**/workers.component.spec.ts'` — Expected: FAIL.
- [ ] **Step 2:** Widen `patchConfig`'s patch parameter type in `workers-api.service.ts` to include `sweepDirIntervalMs?: number` (the runtime PATCH already accepts it; this is just the TS type). Add a `getDiscoverConfig()` → `this.http.get<{ paused: boolean; sweepDirIntervalMs: number }>('${this.base}/workers/discover/config')` mirroring `getPruneWindow` at :210, and a matching `GET /api/workers/discover/config` route in `routes-main.ts` backed by `loadDiscoverConfig()`.
- [ ] **Step 3:** In `workers.component.ts`, load `getDiscoverConfig()` into a `discoverSweepMs = signal<number>(250)` on init; add `setSweepInterval(ms: number) { this.api.patchConfig('discover', { sweepDirIntervalMs: ms }).subscribe(); }`. In `workers.component.html`, render a labelled number input ("Library scan: 1 directory every N ms") in the `discover` row next to its pause toggle (the same `@for` row that renders every worker from `getStatus()`).
- [ ] **Step 4:** Run the spec — Expected: PASS. Then `cd src/web && bun run format && bun run lint`.
- [ ] **Step 5:** Commit `git commit -am "feat(web): discover sweep cadence control on /settings/workers"`

---

## Phase 5 — Verify the fix end-to-end

### Task 11: Confirm heap stays flat (the actual bug)

- [ ] **Step 1:** Local run against a COPY of prod data (never point the sweeper at the prod Mongo directly — it writes asset/stage state). `mongodump` from `192.168.0.244` → `mongorestore` to the throwaway `mongod` on :27077; mount the SMB library at the path the DB references (`/srv/photos/Library` → symlink to `/Volumes/Photos/Library`).
- [ ] **Step 2:** Start the API from source with `MAPLE_INDEXER_AUTOSTART=1 MAPLE_MONGO_URI=mongodb://127.0.0.1:27077`. Sample `process.memoryUsage().rss` of the **main** process and the discover child every 5 s for 2 min.
- [ ] **Step 3:** Assert: main-process RSS stays flat (≈ the `=0` baseline, ~0.5–1.4 GiB) and `/api/health` stays < 50 ms throughout (no 8 s timeouts). The discover child's RSS stays bounded (O(one directory), NOT the old ~5.9 GiB chokidar cache).
- [ ] **Step 4:** Open a PR. `Closes #888`. Body: the diagnosis (chokidar `usePolling` since `d491c56c0` held the whole SMB tree — 1,204,968 files — in heap on the main thread) + before/after RSS + health-latency numbers.

---

## Self-Review notes

- **Spec coverage:** off-main-thread ✔ (Task 8 child) · no whole-tree-in-memory ✔ (Task 1–3 frontier-in-Mongo + one-level readdir) · DB-tracked location ✔ (frontier + checkpoint `sweepGen`) · 1-dir-at-a-time ✔ (`visitDirectory`) · per-dir delete diff (no write storm) ✔ (Task 3) · pause + configure on workers page ✔ (Tasks 9–10) · replaces chokidar ✔ (Task 7).
- **Integration symbols (verified against source during planning, real line numbers in the tasks):** `worker_config` write = `(await getDb()).collection('worker_config')` + `WorkerConfigRepo.patch` (`routes-main.ts` PATCH `/:name/config`); registry = `stageRegistry.register('discover', {getPaused,pause,resume,reloadConfig,…})` per the `StageRegistryEntry` interface (`registry.ts:25`) mirroring `missing-reaper.ts:532`; web = existing `WorkersApiService.patchConfig/pause/resume/getStatus` + `getPruneWindow` precedent (`workers-api.service.ts`). No invented symbols.
- **One thing to eyeball at Task 7:** `resolveFolder()` was written to map a _file_ path to its folder by longest-prefix; a root path equals a registered folder's `path`, so calling it with `root` (and the `root + '/'` fallback) should return that folder — confirm on the actual data before relying on it.
- **Renames residual** (`handleEvent` kind `'renamed'`): the sweep never emits `'renamed'` — a moved file is a `removed` in its old dir + a `created` in its new dir across the sweep. That is correct (dedup by `maple_id` re-attaches it); no rename handling needed in the sweeper.
