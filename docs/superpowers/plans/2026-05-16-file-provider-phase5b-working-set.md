# Maple File Provider — Phase 5b (Working Set + Push Change Feed) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Phase 1 manual Refresh button with automatic, push-driven invalidation. The server records every asset mutation in a monotonic cursor, exposes it via both polling (`GET /api/changes`) and Server-Sent Events (`GET /api/changes/subscribe`), and the File Provider extension subscribes on init. A real `WorkingSetEnumerator` keeps the OS's most-relevant subset (XMPs + favourites + last 30 days + active folder, cap 20k) and feeds it deltas as they arrive.

**Architecture:**
1. Server: new `asset_changes` collection + `server_state` counter doc. Every mutation site (XMP write/delete, asset delete/restore, indexer enrichment writes) inserts a change row with a monotonically-allocated cursor. A new `/api/changes` route exposes both polling and SSE views, plus an in-process ring buffer for low-latency fan-out to SSE subscribers.
2. Server: new `GET /api/assets` list endpoint with three filters (`has_xmp`, `rating_gte`, `captured_after`) so the extension can seed its working set.
3. Extension: `WorkingSetEnumerator` with a typed working-set table (XMP / favorite / recent / active entries) and bounded eviction. A long-lived `ChangeFeedClient` (URLSession streaming task) parses SSE events and signals enumerators on each delta.
4. Extension: the existing `RootEnumerator` and `FolderEnumerator` keep working; they no longer carry the burden of being the primary refresh path.

**Mongo transaction note:** the codebase does not use Mongo transactions today. Change-row inserts are **best-effort post-write operations** — if the asset write succeeds and the change-row insert fails, the system stays consistent because (a) the server's filesystem state is the source of truth, and (b) clients with stale cursors that ask for changes after the gap get HTTP 409 and fall back to full re-enumeration. The plan calls this out explicitly so future maintainers don't hunt for `withTransaction` patterns that aren't here.

**Tech Stack:** Bun, Elysia 1.1 (built-in `sse` helper for SSE responses), MongoDB driver, Swift 5.10, FileProvider framework, `URLSession.bytes(for:)` for SSE stream consumption.

## Out of scope (deferred)

- WebSocket as an alternative transport — SSE is sufficient (spec explicit).
- Persistent change log across server restarts — the ring buffer is in-memory; restarts cause clients to hit the 409 path and full-resync. This is intentional per the spec's "server is source of truth, losing events can't corrupt state" principle.
- Settings UI for selective sync. The `WorkingSetEnumerator` lists what the OS asked us to materialize; user-driven selective sync is Phase 6+.
- Prefetch heuristics riding the change feed — Phase 6+.

---

## File structure

**New (server):**
- `src/api/src/db/changes.repo.ts` — atomic cursor allocator + `asset_changes` reads/writes
- `src/api/src/routes/changes.ts` — `GET /api/changes` (polling) + `GET /api/changes/subscribe` (SSE)
- `src/api/src/runtime/change-bus.ts` — in-process `EventEmitter`-based publisher + ring buffer (last 10k events)
- `src/api/src/routes/assets-list.ts` — new `GET /api/assets` list endpoint with `has_xmp` / `rating_gte` / `captured_after` filters

**Modified (server):**
- `src/api/src/db/schema.ts` — add `AssetChangeDoc`, `ServerStateDoc` interfaces
- `src/api/src/db/client.ts` — add `assetChangesCollection`, `serverStateCollection`, indexes on `cursor`
- `src/api/src/routes/assets.ts` — emit a change after `PUT /:id/xmp`, `DELETE /:id/xmp`, the manual-override PUTs
- `src/api/src/routes/folders.ts` — emit a change after folder upload, rescan, and the deleteMany cascade
- `src/api/src/index.ts` — mount `changesRoutes` and `assetsListRoutes`
- `src/api/src/workers/stages/*.ts` — emit a change after every asset enrichment write (face, exif, thumb, ocr, hash, meili — best-effort, helper function in `change-bus.ts`)

**New (extension / MapleCore):**
- `src/apple/Packages/MapleCore/Sources/MapleCore/FileProvider/AssetChange.swift` — DTO for change events
- `src/apple/Packages/MapleCore/Sources/MapleCore/FileProvider/RemoteCatalog+Changes.swift` — `listChanges(since:limit:)` + `listAssets(filters:)`
- `src/apple/Packages/MapleCore/Sources/MapleCore/FileProvider/WorkingSet.swift` — pure in-memory working-set table with bounded eviction
- `src/apple/Packages/MapleCore/Sources/MapleCore/FileProvider/ChangeCursorStore.swift` — persisted last-seen cursor (App Group `UserDefaults`)
- `src/apple/MapleFileProvider/ChangeFeedClient.swift` — long-lived SSE client (URLSession bytes streaming, reconnect with backoff)
- `src/apple/MapleFileProvider/WorkingSetEnumerator.swift` — `NSFileProviderEnumerator` for the working-set container

**Modified (extension):**
- `src/apple/MapleFileProvider/FileProviderExtension.swift` — start/stop `ChangeFeedClient`, hand out `WorkingSetEnumerator` for `.workingSet`

**Tests (server):**
- `src/api/src/db/changes.repo.test.ts` — atomic cursor allocator, monotonic guarantees, ring-buffer behaviour
- `src/api/src/routes/changes.poll.test.ts` — `GET /api/changes?since=N` happy/empty/too-old paths
- `src/api/src/routes/changes.sse.test.ts` — connect → publish 3 → receive 3 (in order)
- `src/api/src/routes/changes.stale-cursor.test.ts` — `since=` below the ring buffer window returns 409 with `current` cursor
- `src/api/src/routes/assets-list.test.ts` — list endpoint filter combinations
- `src/api/src/routes/assets.changes.integration.test.ts` — PUT XMP emits a change

**Tests (extension / MapleCore):**
- `src/apple/Packages/MapleCore/Tests/MapleCoreTests/WorkingSetTests.swift` — eviction discipline (XMP/favorite never dropped, recent oldest-first)
- `src/apple/Packages/MapleCore/Tests/MapleCoreTests/ChangeCursorStoreTests.swift` — load/save/reset
- `src/apple/Packages/MapleCore/Tests/MapleCoreTests/RemoteCatalogChangesTests.swift` — `listChanges`, `listAssets`

---

## Identifier scheme & sync anchors

The working-set enumerator returns items whose identifiers are already
the existing `asset/<id>` and `sidecar/<assetID>[:conflict]` forms — the
OS uses the embedded parent identifier to attach them to the right
container. No new identifier types are introduced.

Sync anchors stop being "0" (the Phase 1 placeholder). The anchor for
every enumerator is now the latest server cursor we've seen, encoded as
ASCII bytes of the decimal cursor value (`"42"`, `"43"`, …). The OS
hands the anchor back on the next `enumerateChanges` call so we know
where to resume.

---

## Section A — Server change cursor + bus

### Task A1: Schema additions

**Files:**
- Modify: `src/api/src/db/schema.ts`
- Modify: `src/api/src/db/client.ts`

- [ ] **Step 1: Add the schema interfaces**

In `schema.ts`, after the existing exports:

```typescript
// ---------------------------------------------------------------------------
// Asset change feed (Phase 5b — File Provider push channel)
// ---------------------------------------------------------------------------

export type AssetChangeKind = "create" | "update" | "delete" | "restore";

export interface AssetChangeDoc {
  /** Monotonically increasing per insert. Allocated via the
   * server_state.next_cursor counter (see ServerStateDoc). */
  cursor: number;
  asset_id: ObjectId | null;
  folder_id: ObjectId | null;
  kind: AssetChangeKind;
  /** Absolute filesystem path of the affected asset. Null for changes
   * that don't have a single canonical path (e.g. a folder rescan). */
  abs_path: string | null;
  /** Insertion timestamp — informational. The cursor is the source of
   * truth for ordering. */
  at: Date;
}

export type AssetChangeWithId = WithId<AssetChangeDoc>;

/**
 * A small key/value collection for server-wide counters. Today the only
 * key in use is `_id: "asset_changes_cursor"`, holding the next cursor
 * value to allocate.
 */
export interface ServerStateDoc {
  _id: string;
  /** For the asset_changes counter row: the most recently allocated
   * cursor. The next allocation atomically `$inc`'s this and returns
   * the new value. */
  seq?: number;
}

export type ServerStateWithId = WithId<ServerStateDoc>;
```

- [ ] **Step 2: Add the collection accessors**

In `client.ts`, add (mirror the existing `assetsCollection` pattern):

```typescript
import type { AssetChangeDoc, ServerStateDoc } from "./schema.ts";

export async function assetChangesCollection(): Promise<Collection<AssetChangeDoc>> {
  const db = await getDb();
  return db.collection<AssetChangeDoc>("asset_changes");
}

export async function serverStateCollection(): Promise<Collection<ServerStateDoc>> {
  const db = await getDb();
  return db.collection<ServerStateDoc>("server_state");
}
```

And inside `ensureIndexes`, add:

```typescript
const changes = db.collection("asset_changes");
await changes.createIndex({ cursor: 1 }, { unique: true });
await changes.createIndex({ asset_id: 1 });
await changes.createIndex({ folder_id: 1, cursor: 1 });
```

- [ ] **Step 3: Verify the API still starts and tests still pass**

```bash
cd src/api && bun test --bail 2>&1 | tail -20
```

If `bun test` reports "MongoDB unreachable" → all tests skip; that's fine on a sandbox.

- [ ] **Step 4: Commit**

```bash
git add src/api/src/db/schema.ts src/api/src/db/client.ts
git commit -m "feat(api): add asset_changes + server_state schema for FP change feed"
```

---

### Task A2: `changes.repo.ts` — cursor allocator + writes

**Files:**
- Create: `src/api/src/db/changes.repo.ts`
- Create: `src/api/src/db/changes.repo.test.ts`

The cursor allocator must guarantee monotonicity across concurrent writers. Pattern: `findOneAndUpdate({_id: "asset_changes_cursor"}, {$inc: {seq: 1}}, {upsert: true, returnDocument: "after"})`. Mongo's `$inc` is atomic at the document level; concurrent allocators get distinct values with no gaps.

The change row is inserted carrying the allocated cursor. If the insert fails (network, duplicate-key on a retry), we log and move on — the system tolerates lost events because clients can poll the catch-up route or re-enumerate.

- [ ] **Step 1: Write the failing test**

`src/api/src/db/changes.repo.test.ts`:

```typescript
/**
 * Cursor allocator + change-row writer tests. Requires a running
 * MongoDB; skip gracefully if unreachable.
 */

import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { MongoClient, ObjectId, type Db } from "mongodb";
import {
  allocateCursor,
  recordAssetChange,
  listChangesSince,
} from "./changes.repo.ts";

const MONGO_URI = process.env.MAPLE_MONGO_URI ?? "mongodb://localhost:27017";
const TEST_DB = `maple_changes_repo_test_${process.pid}`;

let client: MongoClient | null = null;
let db: Db | null = null;

async function tryConnect(): Promise<MongoClient | null> {
  const c = new MongoClient(MONGO_URI, {
    serverSelectionTimeoutMS: 1_500,
    connectTimeoutMS: 1_500,
  });
  try {
    await c.connect();
    await c.db("admin").command({ ping: 1 });
    return c;
  } catch {
    try { await c.close(); } catch {}
    return null;
  }
}

beforeEach(async () => {
  client = await tryConnect();
  if (!client) return;
  process.env.MAPLE_MONGO_URI = MONGO_URI;
  process.env.MAPLE_MONGO_DB = TEST_DB;
  db = client.db(TEST_DB);
  await db.dropDatabase();
});

afterAll(async () => {
  if (db) await db.dropDatabase();
  if (client) await client.close();
});

describe("changes.repo", () => {
  it.skipIf(!client)("allocateCursor returns monotonically increasing values", async () => {
    if (!db) return;
    const a = await allocateCursor(db);
    const b = await allocateCursor(db);
    const c = await allocateCursor(db);
    expect(b).toBe(a + 1);
    expect(c).toBe(b + 1);
  });

  it.skipIf(!client)("recordAssetChange inserts row with allocated cursor", async () => {
    if (!db) return;
    const assetId = new ObjectId();
    const folderId = new ObjectId();
    const cursor = await recordAssetChange(db, {
      kind: "update",
      asset_id: assetId,
      folder_id: folderId,
      abs_path: "/srv/photos/a.dng",
    });
    const rows = await db.collection("asset_changes").find({}).toArray();
    expect(rows.length).toBe(1);
    expect(rows[0].cursor).toBe(cursor);
    expect(rows[0].kind).toBe("update");
  });

  it.skipIf(!client)("listChangesSince returns rows in cursor order", async () => {
    if (!db) return;
    for (let i = 0; i < 5; i++) {
      await recordAssetChange(db, {
        kind: "create",
        asset_id: new ObjectId(),
        folder_id: new ObjectId(),
        abs_path: `/srv/photos/${i}.dng`,
      });
    }
    const rows = await listChangesSince(db, { since: 0, limit: 100 });
    expect(rows.length).toBe(5);
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i].cursor).toBeGreaterThan(rows[i - 1].cursor);
    }
  });

  it.skipIf(!client)("listChangesSince respects the since cursor", async () => {
    if (!db) return;
    for (let i = 0; i < 5; i++) {
      await recordAssetChange(db, {
        kind: "create", asset_id: new ObjectId(), folder_id: new ObjectId(),
        abs_path: `/srv/photos/${i}.dng`,
      });
    }
    const all = await listChangesSince(db, { since: 0, limit: 100 });
    const mid = all[2].cursor;
    const tail = await listChangesSince(db, { since: mid, limit: 100 });
    expect(tail.length).toBe(2);
    expect(tail[0].cursor).toBeGreaterThan(mid);
  });

  it.skipIf(!client)("listChangesSince respects the limit", async () => {
    if (!db) return;
    for (let i = 0; i < 10; i++) {
      await recordAssetChange(db, {
        kind: "create", asset_id: new ObjectId(), folder_id: new ObjectId(),
        abs_path: `/srv/photos/${i}.dng`,
      });
    }
    const page = await listChangesSince(db, { since: 0, limit: 3 });
    expect(page.length).toBe(3);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd src/api && bun test src/db/changes.repo.test.ts 2>&1 | tail -10
```

Expected: module-not-found for `./changes.repo.ts`.

- [ ] **Step 3: Implement the repo**

`src/api/src/db/changes.repo.ts`:

```typescript
/**
 * Cursor allocation + change-row writes for the asset change feed
 * (Phase 5b — File Provider push channel).
 *
 * The cursor is allocated via $inc on a single `server_state` doc; Mongo
 * guarantees per-doc atomicity so concurrent writers never collide.
 *
 * Change-row writes are best-effort: if the insert fails after the
 * cursor was allocated, the cursor gap is harmless. Clients tolerate
 * gaps via the cursor-too-old 409 path which triggers full re-enumeration.
 */

import type { Db, ObjectId } from "mongodb";
import { assetChangesCollection, serverStateCollection } from "./client.ts";
import type { AssetChangeDoc, AssetChangeKind, AssetChangeWithId } from "./schema.ts";
import { child as childLogger } from "../log.ts";

const log = childLogger("changes-repo");

const CURSOR_DOC_ID = "asset_changes_cursor";

export async function allocateCursor(dbOverride?: Db): Promise<number> {
  const coll = dbOverride
    ? dbOverride.collection("server_state")
    : await serverStateCollection();
  const res = await coll.findOneAndUpdate(
    { _id: CURSOR_DOC_ID },
    { $inc: { seq: 1 } },
    { upsert: true, returnDocument: "after" }
  );
  // findOneAndUpdate returns the updated doc; `seq` is always present after
  // the first $inc (Mongo creates it set to the increment value on upsert).
  const seq = (res as unknown as { seq?: number } | null)?.seq;
  if (typeof seq !== "number") {
    throw new Error("allocateCursor: server_state doc missing seq after $inc");
  }
  return seq;
}

export interface RecordChangeInput {
  kind: AssetChangeKind;
  asset_id: ObjectId | null;
  folder_id: ObjectId | null;
  abs_path: string | null;
}

/**
 * Allocate a cursor, write the change row, return the cursor. Best-effort:
 * if the insert throws, the cursor allocation is wasted (gap in the
 * sequence). Callers should NOT block their primary write on this — the
 * recommended pattern is to call this AFTER a successful asset mutation
 * and let exceptions bubble only for logging.
 */
export async function recordAssetChange(
  dbOverride: Db | undefined,
  input: RecordChangeInput
): Promise<number> {
  const cursor = await allocateCursor(dbOverride);
  const coll = dbOverride
    ? dbOverride.collection("asset_changes")
    : await assetChangesCollection();
  const doc: AssetChangeDoc = {
    cursor,
    asset_id: input.asset_id,
    folder_id: input.folder_id,
    kind: input.kind,
    abs_path: input.abs_path,
    at: new Date(),
  };
  try {
    await coll.insertOne(doc);
  } catch (err) {
    log.error({ err, cursor }, "recordAssetChange: insert failed");
    throw err;
  }
  return cursor;
}

export interface ListChangesQuery {
  since: number;
  limit: number;
}

export async function listChangesSince(
  dbOverride: Db | undefined,
  q: ListChangesQuery
): Promise<AssetChangeWithId[]> {
  const coll = dbOverride
    ? dbOverride.collection<AssetChangeDoc>("asset_changes")
    : await assetChangesCollection();
  const cursor = coll
    .find({ cursor: { $gt: q.since } })
    .sort({ cursor: 1 })
    .limit(Math.min(Math.max(q.limit, 1), 1000));
  return await cursor.toArray() as AssetChangeWithId[];
}

/** Returns the highest cursor currently in the collection, or 0 if empty. */
export async function highestCursor(dbOverride?: Db): Promise<number> {
  const coll = dbOverride
    ? dbOverride.collection<AssetChangeDoc>("asset_changes")
    : await assetChangesCollection();
  const top = await coll.find({}).sort({ cursor: -1 }).limit(1).next();
  return top?.cursor ?? 0;
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd src/api && bun test src/db/changes.repo.test.ts 2>&1 | tail -10
```

- [ ] **Step 5: Commit**

```bash
git add src/api/src/db/changes.repo.ts src/api/src/db/changes.repo.test.ts
git commit -m "feat(api): cursor allocator + asset change repo"
```

---

### Task A3: In-process change bus + ring buffer

The SSE route fans out events to subscribers as they arrive. We also keep a ring buffer of the last 10,000 events so a reconnecting client can request `since=<their-cursor>` and the server can replay from memory without a Mongo round-trip per reconnect.

**Files:**
- Create: `src/api/src/runtime/change-bus.ts`
- Create: `src/api/src/runtime/change-bus.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/api/src/runtime/change-bus.test.ts
import { describe, expect, it } from "bun:test";
import { ObjectId } from "mongodb";
import { ChangeBus } from "./change-bus.ts";
import type { AssetChangeWithId } from "../db/schema.ts";

function evt(cursor: number): AssetChangeWithId {
  return {
    _id: new ObjectId(),
    cursor,
    asset_id: new ObjectId(),
    folder_id: new ObjectId(),
    kind: "update",
    abs_path: `/srv/photos/${cursor}.dng`,
    at: new Date(),
  } as AssetChangeWithId;
}

describe("ChangeBus", () => {
  it("buffers events up to capacity (oldest dropped first)", () => {
    const bus = new ChangeBus({ capacity: 3 });
    bus.publish(evt(1));
    bus.publish(evt(2));
    bus.publish(evt(3));
    bus.publish(evt(4));
    const all = bus.snapshot();
    expect(all.map(e => e.cursor)).toEqual([2, 3, 4]);
  });

  it("replays events strictly greater than the requested cursor", () => {
    const bus = new ChangeBus({ capacity: 10 });
    for (let i = 1; i <= 5; i++) bus.publish(evt(i));
    expect(bus.replay({ since: 2 }).map(e => e.cursor)).toEqual([3, 4, 5]);
    expect(bus.replay({ since: 0 }).map(e => e.cursor)).toEqual([1, 2, 3, 4, 5]);
    expect(bus.replay({ since: 5 }).map(e => e.cursor)).toEqual([]);
  });

  it("isCursorReplayable returns false when below the buffer floor", () => {
    const bus = new ChangeBus({ capacity: 3 });
    for (let i = 1; i <= 5; i++) bus.publish(evt(i));  // buffer now holds [3,4,5]
    expect(bus.isCursorReplayable(2)).toBe(false);
    expect(bus.isCursorReplayable(3)).toBe(true);
    expect(bus.isCursorReplayable(5)).toBe(true);
    expect(bus.isCursorReplayable(99)).toBe(true);  // future cursor is fine
  });

  it("notifies subscribers in publish order", () => {
    const bus = new ChangeBus({ capacity: 10 });
    const received: number[] = [];
    const unsub = bus.subscribe((e) => received.push(e.cursor));
    bus.publish(evt(1));
    bus.publish(evt(2));
    bus.publish(evt(3));
    unsub();
    bus.publish(evt(4));  // should not be received post-unsub
    expect(received).toEqual([1, 2, 3]);
  });

  it("isCursorReplayable returns true when buffer is empty", () => {
    const bus = new ChangeBus({ capacity: 10 });
    expect(bus.isCursorReplayable(0)).toBe(true);
    expect(bus.isCursorReplayable(99)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd src/api && bun test src/runtime/change-bus.test.ts 2>&1 | tail -10
```

- [ ] **Step 3: Implement the bus**

```typescript
// src/api/src/runtime/change-bus.ts
import { EventEmitter } from "node:events";
import type { AssetChangeWithId } from "../db/schema.ts";

export interface ChangeBusOptions {
  capacity: number;
}

export class ChangeBus {
  private readonly capacity: number;
  /** Ring buffer of recent events, oldest first. */
  private readonly buf: AssetChangeWithId[] = [];
  private readonly emitter = new EventEmitter();

  constructor(opts: ChangeBusOptions) {
    this.capacity = Math.max(1, opts.capacity);
    // Allow many subscribers — every SSE connection adds one.
    this.emitter.setMaxListeners(0);
  }

  publish(event: AssetChangeWithId): void {
    this.buf.push(event);
    if (this.buf.length > this.capacity) this.buf.shift();
    this.emitter.emit("change", event);
  }

  /** Snapshot of the current buffer in cursor order. */
  snapshot(): AssetChangeWithId[] {
    return this.buf.slice();
  }

  replay(query: { since: number }): AssetChangeWithId[] {
    return this.buf.filter((e) => e.cursor > query.since);
  }

  /** True when `since` is within the buffer's reach (i.e. we can serve a
   *  replay without going to Mongo). An empty buffer is considered
   *  always-replayable (no events to miss). */
  isCursorReplayable(since: number): boolean {
    if (this.buf.length === 0) return true;
    const floor = this.buf[0].cursor;
    return since + 1 >= floor || since >= floor;
  }

  subscribe(listener: (event: AssetChangeWithId) => void): () => void {
    this.emitter.on("change", listener);
    return () => { this.emitter.off("change", listener); };
  }
}

/** Process-wide singleton — created once on first access. */
let _instance: ChangeBus | null = null;
export function getChangeBus(): ChangeBus {
  if (!_instance) _instance = new ChangeBus({ capacity: 10_000 });
  return _instance;
}

/** Test helper. Do not call in production. */
export function __resetChangeBusForTests(): void {
  _instance = null;
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd src/api && bun test src/runtime/change-bus.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/api/src/runtime/change-bus.ts src/api/src/runtime/change-bus.test.ts
git commit -m "feat(api): in-process change bus + ring buffer for SSE fan-out"
```

---

### Task A4: `recordAssetChange` helper that publishes to the bus

A thin wrapper combining `recordAssetChange` + bus publish, so route handlers have a single call site.

**Files:**
- Modify: `src/api/src/db/changes.repo.ts`

- [ ] **Step 1: Add the wrapper**

Append to `changes.repo.ts`:

```typescript
import { getChangeBus } from "../runtime/change-bus.ts";

/**
 * High-level helper: record the change in Mongo AND publish to the
 * in-process bus so connected SSE clients see it immediately. The
 * caller swallows errors (logs only) — change-row failures must not
 * fail the primary write.
 */
export async function recordAndPublishAssetChange(
  input: RecordChangeInput
): Promise<void> {
  try {
    const cursor = await recordAssetChange(undefined, input);
    const coll = await assetChangesCollection();
    const inserted = await coll.findOne({ cursor });
    if (inserted) {
      getChangeBus().publish(inserted as AssetChangeWithId);
    }
  } catch (err) {
    log.warn({ err, kind: input.kind, abs_path: input.abs_path },
             "recordAndPublishAssetChange failed (best-effort, ignoring)");
  }
}
```

Add the import of `assetChangesCollection` at the top of the file (it's already used).

Add a one-line export of `AssetChangeWithId` at the top so the bus publish type-checks (it's already exported from `schema.ts`; re-import is fine).

- [ ] **Step 2: Commit**

```bash
git add src/api/src/db/changes.repo.ts
git commit -m "feat(api): recordAndPublishAssetChange wraps DB write + bus publish"
```

---

### Task A5: `/api/changes` polling route

**Files:**
- Create: `src/api/src/routes/changes.ts`
- Create: `src/api/src/routes/changes.poll.test.ts`
- Modify: `src/api/src/index.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/api/src/routes/changes.poll.test.ts
import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { Elysia } from "elysia";
import { MongoClient, ObjectId, type Db } from "mongodb";
import { changesRoutes } from "./changes.ts";
import { recordAssetChange } from "../db/changes.repo.ts";

const MONGO_URI = process.env.MAPLE_MONGO_URI ?? "mongodb://localhost:27017";
const TEST_DB = `maple_changes_route_test_${process.pid}`;

let client: MongoClient | null = null;
let db: Db | null = null;
let app: Elysia | null = null;

async function tryConnect(): Promise<MongoClient | null> {
  const c = new MongoClient(MONGO_URI, {
    serverSelectionTimeoutMS: 1_500, connectTimeoutMS: 1_500,
  });
  try {
    await c.connect();
    await c.db("admin").command({ ping: 1 });
    return c;
  } catch { try { await c.close(); } catch {} return null; }
}

beforeEach(async () => {
  client = await tryConnect();
  if (!client) return;
  process.env.MAPLE_MONGO_URI = MONGO_URI;
  process.env.MAPLE_MONGO_DB = TEST_DB;
  db = client.db(TEST_DB);
  await db.dropDatabase();
  app = new Elysia().use(changesRoutes);
});

afterAll(async () => {
  if (db) await db.dropDatabase();
  if (client) await client.close();
});

describe("GET /api/changes", () => {
  it.skipIf(!client)("returns rows with cursor > since", async () => {
    if (!db || !app) return;
    for (let i = 0; i < 3; i++) {
      await recordAssetChange(db, {
        kind: "create", asset_id: new ObjectId(),
        folder_id: new ObjectId(), abs_path: `/p/${i}.dng`,
      });
    }
    const res = await app.handle(new Request("http://x/api/changes?since=0"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.changes.length).toBe(3);
    expect(body.next_cursor).toBeGreaterThan(0);
  });

  it.skipIf(!client)("returns empty list with no next_cursor when no changes", async () => {
    if (!app) return;
    const res = await app.handle(new Request("http://x/api/changes?since=0"));
    const body = await res.json();
    expect(body.changes).toEqual([]);
    expect(body.next_cursor).toBeUndefined();
  });

  it.skipIf(!client)("respects limit parameter", async () => {
    if (!db || !app) return;
    for (let i = 0; i < 10; i++) {
      await recordAssetChange(db, {
        kind: "create", asset_id: new ObjectId(),
        folder_id: new ObjectId(), abs_path: `/p/${i}.dng`,
      });
    }
    const res = await app.handle(new Request("http://x/api/changes?since=0&limit=3"));
    const body = await res.json();
    expect(body.changes.length).toBe(3);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd src/api && bun test src/routes/changes.poll.test.ts 2>&1 | tail -10
```

- [ ] **Step 3: Implement the polling part of the route**

`src/api/src/routes/changes.ts`:

```typescript
/**
 * /api/changes — asset change feed for the File Provider extension.
 *
 *   GET /api/changes?since=<cursor>&limit=<N>
 *     Polling form. Returns up to N (default 100, max 1000) change rows
 *     where cursor > since.
 *
 *   GET /api/changes/subscribe?since=<cursor>
 *     SSE form (added in task A6). Streams events as they arrive,
 *     prefixed by a replay of buffered events > since.
 */

import { Elysia, t } from "elysia";
import { listChangesSince } from "../db/changes.repo.ts";

export const changesRoutes = new Elysia({ prefix: "/api/changes" })
  .get(
    "/",
    async ({ query, set }) => {
      const since = Number.parseInt(query.since ?? "0", 10);
      const limit = Math.min(
        Math.max(Number.parseInt(query.limit ?? "100", 10), 1),
        1000
      );
      if (!Number.isFinite(since) || since < 0) {
        set.status = 400;
        return { error: "since must be a non-negative integer" };
      }
      const rows = await listChangesSince(undefined, { since, limit });
      const payload = rows.map(r => ({
        cursor: r.cursor,
        asset_id: r.asset_id?.toHexString() ?? null,
        folder_id: r.folder_id?.toHexString() ?? null,
        kind: r.kind,
        abs_path: r.abs_path,
        at: r.at.toISOString(),
      }));
      const next_cursor = rows.length > 0
        ? rows[rows.length - 1].cursor
        : undefined;
      return { changes: payload, next_cursor };
    },
    {
      query: t.Object({
        since: t.Optional(t.String()),
        limit: t.Optional(t.String()),
      }),
    }
  );
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd src/api && bun test src/routes/changes.poll.test.ts
```

- [ ] **Step 5: Mount the route in `index.ts`**

In `src/api/src/index.ts`, add the import alongside the other route imports:

```typescript
import { changesRoutes } from "./routes/changes.ts";
```

And in the `app.use(...)` chain (look for where `eventsRoutes` is mounted), add:

```typescript
.use(changesRoutes)
```

Mount it behind `requireAuth` if the surrounding routes do (the FP extension carries auth tokens; the change feed must not be publicly readable).

- [ ] **Step 6: Commit**

```bash
git add src/api/src/routes/changes.ts src/api/src/routes/changes.poll.test.ts src/api/src/index.ts
git commit -m "feat(api): GET /api/changes polling route"
```

---

### Task A6: `/api/changes/subscribe` SSE route

Elysia 1.1 exposes a `sse` helper (`elysia/utils`) that wraps async generators. We use it to stream events. The generator yields buffered events (replay) first, then waits on bus events.

Stale-cursor detection: if `since` is below the ring buffer's floor and the buffer is not empty, return 409 with `{error: "cursor too old", current: <highest>}`. The client knows to fall back to a full re-enumeration.

Keepalive: SSE proxies / load balancers drop idle connections. We yield `:keepalive` comments every 15s.

**Files:**
- Modify: `src/api/src/routes/changes.ts`
- Create: `src/api/src/routes/changes.sse.test.ts`
- Create: `src/api/src/routes/changes.stale-cursor.test.ts`

- [ ] **Step 1: Add the stale-cursor test first (simpler)**

```typescript
// src/api/src/routes/changes.stale-cursor.test.ts
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { Elysia } from "elysia";
import { ObjectId } from "mongodb";
import { changesRoutes } from "./changes.ts";
import { getChangeBus, __resetChangeBusForTests } from "../runtime/change-bus.ts";
import type { AssetChangeWithId } from "../db/schema.ts";

function evt(cursor: number): AssetChangeWithId {
  return {
    _id: new ObjectId(), cursor,
    asset_id: new ObjectId(), folder_id: new ObjectId(),
    kind: "update", abs_path: `/p/${cursor}.dng`, at: new Date(),
  } as AssetChangeWithId;
}

beforeEach(() => { __resetChangeBusForTests(); });
afterEach(() => { __resetChangeBusForTests(); });

describe("GET /api/changes/subscribe (stale cursor)", () => {
  it("returns 409 when since is below buffer floor", async () => {
    // Drive the bus past the requested since.
    const bus = getChangeBus();
    for (let i = 100; i < 110; i++) bus.publish(evt(i));
    const app = new Elysia().use(changesRoutes);
    const res = await app.handle(
      new Request("http://x/api/changes/subscribe?since=1")
    );
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toMatch(/too old/i);
    expect(body.current).toBeGreaterThanOrEqual(109);
  });
});
```

For the SSE happy-path test, we read from the response body's `ReadableStream`:

```typescript
// src/api/src/routes/changes.sse.test.ts
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { Elysia } from "elysia";
import { ObjectId } from "mongodb";
import { changesRoutes } from "./changes.ts";
import { getChangeBus, __resetChangeBusForTests } from "../runtime/change-bus.ts";
import type { AssetChangeWithId } from "../db/schema.ts";

function evt(cursor: number): AssetChangeWithId {
  return {
    _id: new ObjectId(), cursor,
    asset_id: new ObjectId(), folder_id: new ObjectId(),
    kind: "update", abs_path: `/p/${cursor}.dng`, at: new Date(),
  } as AssetChangeWithId;
}

beforeEach(() => { __resetChangeBusForTests(); });
afterEach(() => { __resetChangeBusForTests(); });

async function readWhile(reader: ReadableStreamDefaultReader<Uint8Array>,
                         deadlineMs: number): Promise<string> {
  let out = "";
  const decoder = new TextDecoder();
  const start = Date.now();
  while (Date.now() - start < deadlineMs) {
    const { value, done } = await Promise.race([
      reader.read(),
      new Promise<ReadableStreamReadResult<Uint8Array>>(
        (resolve) => setTimeout(() => resolve({ value: undefined, done: false }),
                                deadlineMs - (Date.now() - start))
      ),
    ]);
    if (done) break;
    if (value) out += decoder.decode(value, { stream: true });
  }
  return out;
}

describe("GET /api/changes/subscribe (SSE)", () => {
  it("replays buffered events on connect", async () => {
    const bus = getChangeBus();
    bus.publish(evt(1));
    bus.publish(evt(2));
    bus.publish(evt(3));
    const app = new Elysia().use(changesRoutes);
    const res = await app.handle(
      new Request("http://x/api/changes/subscribe?since=0")
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/event-stream/);
    const reader = res.body!.getReader();
    const text = await readWhile(reader, 200);
    expect(text).toContain('"cursor":1');
    expect(text).toContain('"cursor":2');
    expect(text).toContain('"cursor":3');
    try { reader.cancel(); } catch {}
  });

  it("streams events published after connect", async () => {
    const bus = getChangeBus();
    const app = new Elysia().use(changesRoutes);
    const res = await app.handle(
      new Request("http://x/api/changes/subscribe?since=0")
    );
    const reader = res.body!.getReader();
    // Defer a publish so we read it from the live channel.
    setTimeout(() => bus.publish(evt(42)), 30);
    const text = await readWhile(reader, 300);
    expect(text).toContain('"cursor":42');
    try { reader.cancel(); } catch {}
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd src/api && bun test src/routes/changes.stale-cursor.test.ts src/routes/changes.sse.test.ts 2>&1 | tail -20
```

Expected: 404 because `/subscribe` doesn't exist yet.

- [ ] **Step 3: Implement the SSE subroute**

Add to `changes.ts`:

```typescript
import { sse } from "elysia/utils";
import { getChangeBus } from "../runtime/change-bus.ts";
import type { AssetChangeWithId } from "../db/schema.ts";

function asPayload(r: AssetChangeWithId): {
  cursor: number;
  asset_id: string | null;
  folder_id: string | null;
  kind: string;
  abs_path: string | null;
  at: string;
} {
  return {
    cursor: r.cursor,
    asset_id: r.asset_id?.toHexString() ?? null,
    folder_id: r.folder_id?.toHexString() ?? null,
    kind: r.kind,
    abs_path: r.abs_path,
    at: r.at.toISOString(),
  };
}
```

…and chain a new handler onto the existing `changesRoutes`:

```typescript
.get(
  "/subscribe",
  async function* ({ query, set, request }) {
    const since = Number.parseInt(query.since ?? "0", 10);
    if (!Number.isFinite(since) || since < 0) {
      set.status = 400;
      return { error: "since must be a non-negative integer" };
    }
    const bus = getChangeBus();
    if (!bus.isCursorReplayable(since)) {
      set.status = 409;
      const current = bus.snapshot().at(-1)?.cursor ?? 0;
      return { error: "cursor too old", current };
    }

    set.headers["Content-Type"] = "text/event-stream";
    set.headers["Cache-Control"] = "no-cache, no-transform";
    set.headers["Connection"] = "keep-alive";
    set.headers["X-Accel-Buffering"] = "no";

    // 1. Replay anything already in the buffer.
    for (const ev of bus.replay({ since })) {
      yield sse({ event: "change", data: asPayload(ev), id: String(ev.cursor) });
    }

    // 2. Live subscription with keepalive.
    const queue: AssetChangeWithId[] = [];
    let waiter: ((v: void) => void) | null = null;
    const unsub = bus.subscribe((ev) => {
      queue.push(ev);
      if (waiter) { waiter(); waiter = null; }
    });

    const abort = new Promise<"abort">(resolve => {
      request.signal.addEventListener("abort", () => resolve("abort"), { once: true });
    });

    try {
      while (!request.signal.aborted) {
        if (queue.length === 0) {
          // Race a 15s keepalive against the next event / abort.
          const result = await Promise.race([
            new Promise<"event">(r => { waiter = () => r("event"); }),
            new Promise<"keepalive">(r => setTimeout(() => r("keepalive"), 15_000)),
            abort,
          ]);
          if (result === "abort") break;
          if (result === "keepalive") {
            yield sse(": keepalive\n");
            continue;
          }
        }
        const ev = queue.shift()!;
        yield sse({ event: "change", data: asPayload(ev), id: String(ev.cursor) });
      }
    } finally {
      unsub();
    }
  },
  {
    query: t.Object({
      since: t.Optional(t.String()),
    }),
  }
);
```

Notes for the implementer:
- The `sse` helper returns an object Elysia recognises as a single SSE frame. Strings are wrapped as `data:` lines; objects with `event` / `data` / `id` are serialized per the SSE spec.
- The keepalive yield uses a raw `: keepalive\n` comment line because that's the SSE spec's idle-keep-alive form.
- `request.signal` aborts when the client disconnects; we use it to break the loop and unsubscribe.

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd src/api && bun test src/routes/changes.stale-cursor.test.ts src/routes/changes.sse.test.ts
```

If the SSE helper API differs from what's described (Elysia 1.x had some movement on this surface), consult `node_modules/elysia/dist/utils.d.ts` for the actual signature. The function exists; its exact return shape may need to be adapted. If `sse` does not accept the `{event, data, id}` shape directly, manually format the frame:

```typescript
function frame(event: string, data: unknown, id: string): string {
  return `id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}
yield frame("change", asPayload(ev), String(ev.cursor));
```

…and skip the `sse()` wrapper.

- [ ] **Step 5: Commit**

```bash
git add src/api/src/routes/changes.ts \
        src/api/src/routes/changes.sse.test.ts \
        src/api/src/routes/changes.stale-cursor.test.ts
git commit -m "feat(api): SSE subscription + stale-cursor 409 for changes feed"
```

---

### Task A7: Emit change events from write sites

Every place that mutates an asset or sidecar gets a `recordAndPublishAssetChange` call. We don't try to be exhaustive — this is best-effort signalling. If a stage worker forgets to call it, the next poll-based reconciliation picks it up.

**Sites to update:**
1. `src/api/src/routes/assets.ts` — `PUT /:id/xmp` (success), `DELETE /:id/xmp` (success), `PUT /:id/place`, `PUT /:id/description`, `PUT /:id/ocr` (every successful return)
2. `src/api/src/routes/folders.ts` — folder upload completion, the cascade-delete in rescan
3. `src/api/src/workers/stages/{exif,face,thumb,hash,ocr,meili}.ts` — after each per-asset write
4. `src/api/src/enrichment/dead-letter.repo.ts` — when an enrichment write succeeds (the helpers wrap `assets.updateOne`; emit after)

For each site, the pattern is:

```typescript
import { recordAndPublishAssetChange } from "../db/changes.repo.ts";

// … after the asset mutation succeeds …
await recordAndPublishAssetChange({
  kind: "update",   // or "create" / "delete" / "restore"
  asset_id: doc._id,
  folder_id: doc.folder_id,
  abs_path: doc.abs_path,
}).catch(() => { /* best-effort */ });
```

The `.catch(() => {})` ensures a change-publish failure can never bubble past a successful write. The wrapper already swallows errors internally, but defence-in-depth — calling code shouldn't have to know.

- [ ] **Step 1: Write an integration test asserting `PUT /:id/xmp` emits a change**

`src/api/src/routes/assets.changes.integration.test.ts`:

```typescript
import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { Elysia } from "elysia";
import { MongoClient, ObjectId, type Db } from "mongodb";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assetsRoutes } from "./assets.ts";
import { listChangesSince } from "../db/changes.repo.ts";

const MONGO_URI = process.env.MAPLE_MONGO_URI ?? "mongodb://localhost:27017";
const TEST_DB = `maple_assets_changes_test_${process.pid}`;

let client: MongoClient | null = null;
let db: Db | null = null;
let tmp: string | null = null;

async function tryConnect(): Promise<MongoClient | null> {
  const c = new MongoClient(MONGO_URI, {
    serverSelectionTimeoutMS: 1_500, connectTimeoutMS: 1_500,
  });
  try { await c.connect(); await c.db("admin").command({ ping: 1 }); return c; }
  catch { try { await c.close(); } catch {} return null; }
}

beforeEach(async () => {
  client = await tryConnect();
  if (!client) return;
  process.env.MAPLE_MONGO_URI = MONGO_URI;
  process.env.MAPLE_MONGO_DB = TEST_DB;
  db = client.db(TEST_DB);
  await db.dropDatabase();
  tmp = await mkdtemp(join(tmpdir(), "maple-changes-"));
  process.env.MAPLE_ROOTS = tmp;
});

afterAll(async () => {
  if (db) await db.dropDatabase();
  if (client) await client.close();
  if (tmp) await rm(tmp, { recursive: true, force: true });
});

describe("assets routes — change emission", () => {
  it.skipIf(!client)("PUT /api/assets/:id/xmp emits a change row", async () => {
    if (!db || !tmp) return;
    const folderId = new ObjectId();
    const rawPath = join(tmp, "a.dng");
    await writeFile(rawPath, Buffer.alloc(8));
    const assetId = new ObjectId();
    await db.collection("assets").insertOne({
      _id: assetId, folder_id: folderId, filename: "a.dng",
      abs_path: rawPath, size: 8, mtime: Date.now(), rating: 0, flag: 0,
      color_label: "", indexed_at: new Date().toISOString(),
    } as never);

    const app = new Elysia().use(assetsRoutes);
    const res = await app.handle(new Request(
      `http://x/api/assets/${assetId.toHexString()}/xmp`,
      { method: "PUT",
        headers: { "Content-Type": "text/plain" },
        body: "<x:xmpmeta />" }
    ));
    expect(res.status).toBe(204);

    const changes = await listChangesSince(db, { since: 0, limit: 10 });
    expect(changes.length).toBeGreaterThanOrEqual(1);
    expect(changes.at(-1)?.asset_id?.toHexString()).toBe(assetId.toHexString());
    expect(changes.at(-1)?.kind).toBe("update");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd src/api && bun test src/routes/assets.changes.integration.test.ts 2>&1 | tail -10
```

- [ ] **Step 3: Wire the emit into `PUT /:id/xmp`**

In `src/api/src/routes/assets.ts`, in the XMP PUT handler, after the success path (the line that sets `set.status = 204` for the non-conflict case), insert:

```typescript
await recordAndPublishAssetChange({
  kind: "update",
  asset_id: id,
  folder_id: doc.folder_id,
  abs_path: doc.abs_path,
}).catch(() => {});
```

Add the import at the top of the file:

```typescript
import { recordAndPublishAssetChange } from "../db/changes.repo.ts";
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd src/api && bun test src/routes/assets.changes.integration.test.ts
```

- [ ] **Step 5: Wire emits for `DELETE /:id/xmp` and the manual-override PUTs**

Same pattern — after each successful 204/200 path:

```typescript
await recordAndPublishAssetChange({
  kind: "update",        // "delete" for the XMP DELETE
  asset_id: id,
  folder_id: doc.folder_id,
  abs_path: doc.abs_path,
}).catch(() => {});
```

For the XMP DELETE specifically, use `kind: "update"` if the canonical sidecar is being removed but the asset stays (it's still an update to the asset's sidecar state). Use `kind: "delete"` only when the asset itself is being removed.

- [ ] **Step 6: Wire emits in `folders.ts`**

- After folder upload completion (success path), emit with `kind: "create"` and the new asset id / path.
- After the rescan's cascade delete, emit `kind: "delete"` per removed asset. (Iterate the result of `deleteMany`; this is a small `for` loop.)

- [ ] **Step 7: Wire emits in stage workers**

For each of `src/api/src/workers/stages/{exif,face,thumb,hash,ocr,meili}.ts`, find the per-asset write site (look for `assets.updateOne({_id: ...}, ...)`) and append the emit:

```typescript
await recordAndPublishAssetChange({
  kind: "update",
  asset_id: row._id,
  folder_id: row.folder_id,
  abs_path: row.abs_path,
}).catch(() => {});
```

If a stage processes many rows in a batch, emit one per row — the change feed is the right granularity.

- [ ] **Step 8: Verify the broader test suite still passes**

```bash
cd src/api && bun test 2>&1 | tail -20
```

- [ ] **Step 9: Commit**

```bash
git add src/api/src/routes/assets.ts src/api/src/routes/folders.ts \
        src/api/src/workers/stages/*.ts \
        src/api/src/routes/assets.changes.integration.test.ts
git commit -m "feat(api): emit asset_changes from XMP writes, deletes, and worker stages"
```

---

## Section B — Server: `GET /api/assets` list endpoint

The working-set enumerator seeds itself by calling three filtered list queries. There's no list endpoint today; we add a minimal one with exactly the three filters the spec calls out.

### Task B1: Implement list endpoint with `has_xmp`, `rating_gte`, `captured_after` filters

**Files:**
- Create: `src/api/src/routes/assets-list.ts`
- Create: `src/api/src/routes/assets-list.test.ts`
- Modify: `src/api/src/index.ts`

The "has_xmp" filter is a touch tricky — the existence of an XMP sidecar isn't tracked in the asset doc; it's a filesystem state. Two options:

a) Compute lazily per row: `stat(abs_path + ".xmp")` and filter to rows where it exists. Expensive at 100k+ rows.

b) Track it on the asset doc as `has_xmp: boolean`, populated on first XMP write/delete by the same path that calls `writeXmpWithPrecondition`. Cheap to filter but a schema addition.

Choose **(b)** — it pays off immediately for the working-set query and stays cheap thereafter.

- [ ] **Step 1: Add `has_xmp` to the asset doc on write/delete**

In `src/api/src/routes/assets.ts`, in `PUT /:id/xmp` success path, after `recordAndPublishAssetChange`, add:

```typescript
await (await assetsCollection()).updateOne(
  { _id: id },
  { $set: { has_xmp: true } }
);
```

And in the `DELETE /:id/xmp` success path:

```typescript
await (await assetsCollection()).updateOne(
  { _id: id },
  { $set: { has_xmp: false } }
);
```

Also add `has_xmp?: boolean` to `AssetDoc` in `schema.ts` (optional because legacy rows lack it).

- [ ] **Step 2: Write the failing test for the list endpoint**

```typescript
// src/api/src/routes/assets-list.test.ts
import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { Elysia } from "elysia";
import { MongoClient, ObjectId, type Db } from "mongodb";
import { assetsListRoutes } from "./assets-list.ts";

const MONGO_URI = process.env.MAPLE_MONGO_URI ?? "mongodb://localhost:27017";
const TEST_DB = `maple_assets_list_test_${process.pid}`;

let client: MongoClient | null = null;
let db: Db | null = null;

async function tryConnect(): Promise<MongoClient | null> {
  const c = new MongoClient(MONGO_URI, {
    serverSelectionTimeoutMS: 1_500, connectTimeoutMS: 1_500,
  });
  try { await c.connect(); await c.db("admin").command({ ping: 1 }); return c; }
  catch { try { await c.close(); } catch {} return null; }
}

beforeEach(async () => {
  client = await tryConnect();
  if (!client) return;
  process.env.MAPLE_MONGO_URI = MONGO_URI;
  process.env.MAPLE_MONGO_DB = TEST_DB;
  db = client.db(TEST_DB);
  await db.dropDatabase();
});

afterAll(async () => {
  if (db) await db.dropDatabase();
  if (client) await client.close();
});

describe("GET /api/assets", () => {
  async function seed(): Promise<void> {
    if (!db) return;
    const folder = new ObjectId();
    const now = new Date("2026-05-10T00:00:00Z");
    const old = new Date("2025-01-01T00:00:00Z");
    await db.collection("assets").insertMany([
      { folder_id: folder, filename: "a.dng", abs_path: "/p/a.dng",
        size: 1, mtime: 1, rating: 5, flag: 0, color_label: "",
        has_xmp: true, indexed_at: "now",
        exif: { captured_at: now.toISOString() } },
      { folder_id: folder, filename: "b.dng", abs_path: "/p/b.dng",
        size: 1, mtime: 1, rating: 0, flag: 0, color_label: "",
        has_xmp: false, indexed_at: "now",
        exif: { captured_at: old.toISOString() } },
      { folder_id: folder, filename: "c.dng", abs_path: "/p/c.dng",
        size: 1, mtime: 1, rating: 3, flag: 0, color_label: "",
        has_xmp: true, indexed_at: "now",
        exif: { captured_at: now.toISOString() } },
    ] as never);
  }

  it.skipIf(!client)("filters by has_xmp=1", async () => {
    if (!db) return;
    await seed();
    const app = new Elysia().use(assetsListRoutes);
    const res = await app.handle(new Request("http://x/api/assets?has_xmp=1"));
    const body = await res.json();
    expect(body.assets.map((a: { filename: string }) => a.filename).sort())
      .toEqual(["a.dng", "c.dng"]);
  });

  it.skipIf(!client)("filters by rating_gte=1", async () => {
    if (!db) return;
    await seed();
    const app = new Elysia().use(assetsListRoutes);
    const res = await app.handle(new Request("http://x/api/assets?rating_gte=1"));
    const body = await res.json();
    expect(body.assets.length).toBe(2);
  });

  it.skipIf(!client)("filters by captured_after=ISO", async () => {
    if (!db) return;
    await seed();
    const app = new Elysia().use(assetsListRoutes);
    const after = new Date("2026-01-01T00:00:00Z").toISOString();
    const res = await app.handle(new Request(
      `http://x/api/assets?captured_after=${encodeURIComponent(after)}`
    ));
    const body = await res.json();
    expect(body.assets.length).toBe(2);
  });

  it.skipIf(!client)("returns 400 for invalid captured_after", async () => {
    if (!db) return;
    const app = new Elysia().use(assetsListRoutes);
    const res = await app.handle(
      new Request("http://x/api/assets?captured_after=notadate")
    );
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 3: Implement the route**

```typescript
// src/api/src/routes/assets-list.ts
/**
 * GET /api/assets — minimal list endpoint used by the File Provider
 * working-set enumerator to seed its tracked subset.
 *
 * Supported filters (combine with AND):
 *   has_xmp=1            — only assets whose XMP sidecar exists
 *   rating_gte=N         — rating >= N
 *   captured_after=ISO   — exif.captured_at > ISO
 *   limit=N (default 1000, max 20000)
 */

import { Elysia, t } from "elysia";
import { assetsCollection } from "../db/client.ts";
import type { Filter } from "mongodb";
import type { AssetDoc } from "../db/schema.ts";

export const assetsListRoutes = new Elysia({ prefix: "/api/assets" }).get(
  "/",
  async ({ query, set }) => {
    const filter: Filter<AssetDoc> = {};
    if (query.has_xmp === "1") filter.has_xmp = true;
    if (query.rating_gte) {
      const v = Number.parseInt(query.rating_gte, 10);
      if (Number.isFinite(v)) filter.rating = { $gte: v };
    }
    if (query.captured_after) {
      const d = new Date(query.captured_after);
      if (isNaN(d.getTime())) {
        set.status = 400;
        return { error: "captured_after must be an ISO 8601 date" };
      }
      (filter as Filter<AssetDoc>)["exif.captured_at"] = { $gt: d.toISOString() } as never;
    }
    const limit = Math.min(
      Math.max(Number.parseInt(query.limit ?? "1000", 10), 1),
      20000
    );
    const coll = await assetsCollection();
    const rows = await coll.find(filter).limit(limit).toArray();
    return {
      assets: rows.map((r) => ({
        id: r._id.toHexString(),
        folder_id: r.folder_id.toHexString(),
        filename: r.filename,
        abs_path: r.abs_path,
        mtime: r.mtime,
        rating: r.rating,
        has_xmp: r.has_xmp ?? false,
      })),
    };
  },
  {
    query: t.Object({
      has_xmp: t.Optional(t.String()),
      rating_gte: t.Optional(t.String()),
      captured_after: t.Optional(t.String()),
      limit: t.Optional(t.String()),
    }),
  }
);
```

- [ ] **Step 4: Mount in `index.ts`**

```typescript
import { assetsListRoutes } from "./routes/assets-list.ts";
// ...
.use(assetsListRoutes)
```

Mount BEFORE `assetsRoutes` so the bare `GET /` doesn't get shadowed by the `:id` route. (Elysia matches routes in registration order.)

- [ ] **Step 5: Run tests to verify they pass**

```bash
cd src/api && bun test src/routes/assets-list.test.ts
```

- [ ] **Step 6: Commit**

```bash
git add src/api/src/routes/assets-list.ts src/api/src/routes/assets-list.test.ts \
        src/api/src/db/schema.ts src/api/src/routes/assets.ts src/api/src/index.ts
git commit -m "feat(api): GET /api/assets list endpoint + has_xmp tracking"
```

---

## Section C — Extension: working set + change client

### Task C1: `AssetChange` DTO + `RemoteCatalog+Changes` extension

**Files:**
- Create: `src/apple/Packages/MapleCore/Sources/MapleCore/FileProvider/AssetChange.swift`
- Create: `src/apple/Packages/MapleCore/Sources/MapleCore/FileProvider/RemoteCatalog+Changes.swift`
- Create: `src/apple/Packages/MapleCore/Tests/MapleCoreTests/RemoteCatalogChangesTests.swift`

- [ ] **Step 1: Write the DTO**

```swift
// src/apple/Packages/MapleCore/Sources/MapleCore/FileProvider/AssetChange.swift
import Foundation

public enum AssetChangeKind: String, Codable, Sendable, Equatable {
    case create, update, delete, restore
}

public struct AssetChange: Codable, Sendable, Equatable {
    public let cursor: Int64
    public let assetID: String?
    public let folderID: String?
    public let kind: AssetChangeKind
    public let absPath: String?
    public let at: Date

    private enum CodingKeys: String, CodingKey {
        case cursor, kind, at
        case assetID = "asset_id"
        case folderID = "folder_id"
        case absPath = "abs_path"
    }
}

public struct ChangesPage: Codable, Sendable, Equatable {
    public let changes: [AssetChange]
    public let nextCursor: Int64?
    private enum CodingKeys: String, CodingKey {
        case changes
        case nextCursor = "next_cursor"
    }
}

public struct AssetListEntry: Codable, Sendable, Equatable {
    public let id: String
    public let folderID: String
    public let filename: String
    public let absPath: String
    public let mtime: Int64
    public let rating: Int
    public let hasXMP: Bool

    private enum CodingKeys: String, CodingKey {
        case id, filename, mtime, rating
        case folderID = "folder_id"
        case absPath = "abs_path"
        case hasXMP = "has_xmp"
    }
}

public struct AssetListResponse: Codable, Sendable, Equatable {
    public let assets: [AssetListEntry]
}
```

- [ ] **Step 2: Add the catalog methods**

```swift
// src/apple/Packages/MapleCore/Sources/MapleCore/FileProvider/RemoteCatalog+Changes.swift
import Foundation

public struct StaleCursorError: Error, Sendable, Equatable {
    public let current: Int64
}

extension RemoteCatalog {
    public func listChanges(since: Int64, limit: Int = 100) async throws -> ChangesPage {
        var comps = URLComponents(
            url: server.appending(path: "/api/changes"),
            resolvingAgainstBaseURL: false
        )!
        comps.queryItems = [
            .init(name: "since", value: String(since)),
            .init(name: "limit", value: String(limit)),
        ]
        let req = URLRequest(url: comps.url!)
        let (data, resp) = try await http.data(for: req)
        let code = (resp as? HTTPURLResponse)?.statusCode ?? -1
        if code == 409 {
            struct Body: Decodable { let current: Int64 }
            let body = try JSONDecoder().decode(Body.self, from: data)
            throw StaleCursorError(current: body.current)
        }
        try Self.check2xx(resp)
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return try decoder.decode(ChangesPage.self, from: data)
    }

    public func listAssets(
        hasXMP: Bool? = nil,
        ratingGTE: Int? = nil,
        capturedAfter: Date? = nil,
        limit: Int = 1000
    ) async throws -> AssetListResponse {
        var comps = URLComponents(
            url: server.appending(path: "/api/assets"),
            resolvingAgainstBaseURL: false
        )!
        var items: [URLQueryItem] = []
        if hasXMP == true { items.append(.init(name: "has_xmp", value: "1")) }
        if let r = ratingGTE { items.append(.init(name: "rating_gte", value: String(r))) }
        if let d = capturedAfter {
            let iso = ISO8601DateFormatter()
            iso.formatOptions = [.withInternetDateTime]
            items.append(.init(name: "captured_after", value: iso.string(from: d)))
        }
        items.append(.init(name: "limit", value: String(limit)))
        comps.queryItems = items
        let req = URLRequest(url: comps.url!)
        let (data, resp) = try await http.data(for: req)
        try Self.check2xx(resp)
        return try JSONDecoder().decode(AssetListResponse.self, from: data)
    }
}
```

Note: `RemoteCatalog`'s `check2xx` and `server` are currently private. Either bump them to `internal` (preferred — they're called from this extension within the module) or duplicate `check2xx` here.

To make this work, in `RemoteCatalog.swift`:

```swift
internal static func check2xx(_ resp: URLResponse) throws {
    let code = (resp as? HTTPURLResponse)?.statusCode ?? -1
    guard (200..<300).contains(code) else { throw URLError(.badServerResponse) }
}
```

(Changing `private` to `internal`.) Same for `server` — change to `internal let server: URL`.

- [ ] **Step 3: Write the failing test**

```swift
// src/apple/Packages/MapleCore/Tests/MapleCoreTests/RemoteCatalogChangesTests.swift
import XCTest
@testable import MapleCore

final class RemoteCatalogChangesTests: XCTestCase {
    func testListChangesHappyPath() async throws {
        let session = MockURLProtocol.makeSession()
        MockURLProtocol.handler = { req in
            XCTAssertEqual(req.url?.path, "/api/changes")
            XCTAssertTrue(req.url!.query!.contains("since=42"))
            let body = #"""
            {"changes": [
              {"cursor": 43, "asset_id": "650a", "folder_id": "650b",
               "kind": "update", "abs_path": "/p/a.dng", "at": "2026-05-16T00:00:00Z"}
            ], "next_cursor": 43}
            """#
            return (HTTPURLResponse(url: req.url!, statusCode: 200,
                                    httpVersion: nil, headerFields: nil)!,
                    body.data(using: .utf8)!)
        }
        let server = URL(string: "https://example.test")!
        let http = AuthenticatedHTTPClient(
            server: server, urlSession: session,
            tokensProvider: { AuthTokens(access: "t", refresh: "r") },
            onTokensRefreshed: { _ in }, onSignOut: { }
        )
        let cat = RemoteCatalog(http: http, server: server)
        let page = try await cat.listChanges(since: 42)
        XCTAssertEqual(page.changes.count, 1)
        XCTAssertEqual(page.nextCursor, 43)
        XCTAssertEqual(page.changes[0].kind, .update)
    }

    func testListChangesStaleCursorThrowsStaleCursorError() async {
        let session = MockURLProtocol.makeSession()
        MockURLProtocol.handler = { req in
            return (HTTPURLResponse(url: req.url!, statusCode: 409,
                                    httpVersion: nil, headerFields: nil)!,
                    #"{"error": "cursor too old", "current": 999}"#.data(using: .utf8)!)
        }
        let server = URL(string: "https://example.test")!
        let http = AuthenticatedHTTPClient(
            server: server, urlSession: session,
            tokensProvider: { AuthTokens(access: "t", refresh: "r") },
            onTokensRefreshed: { _ in }, onSignOut: { }
        )
        let cat = RemoteCatalog(http: http, server: server)
        do {
            _ = try await cat.listChanges(since: 1)
            XCTFail("expected StaleCursorError")
        } catch let e as StaleCursorError {
            XCTAssertEqual(e.current, 999)
        } catch {
            XCTFail("wrong error type: \(error)")
        }
    }

    func testListAssetsBuildsQuery() async throws {
        let session = MockURLProtocol.makeSession()
        MockURLProtocol.handler = { req in
            let q = req.url!.query ?? ""
            XCTAssertTrue(q.contains("has_xmp=1"))
            XCTAssertTrue(q.contains("rating_gte=1"))
            XCTAssertTrue(q.contains("captured_after="))
            return (HTTPURLResponse(url: req.url!, statusCode: 200,
                                    httpVersion: nil, headerFields: nil)!,
                    #"{"assets": []}"#.data(using: .utf8)!)
        }
        let server = URL(string: "https://example.test")!
        let http = AuthenticatedHTTPClient(
            server: server, urlSession: session,
            tokensProvider: { AuthTokens(access: "t", refresh: "r") },
            onTokensRefreshed: { _ in }, onSignOut: { }
        )
        let cat = RemoteCatalog(http: http, server: server)
        let res = try await cat.listAssets(hasXMP: true, ratingGTE: 1,
                                            capturedAfter: Date())
        XCTAssertEqual(res.assets.count, 0)
    }
}
```

- [ ] **Step 4: Run tests**

```bash
cd src/apple/Packages/MapleCore && swift test --filter RemoteCatalogChangesTests
```

- [ ] **Step 5: Commit**

```bash
git add src/apple/Packages/MapleCore/Sources/MapleCore/FileProvider/AssetChange.swift \
        src/apple/Packages/MapleCore/Sources/MapleCore/FileProvider/RemoteCatalog+Changes.swift \
        src/apple/Packages/MapleCore/Sources/MapleCore/FileProvider/RemoteCatalog.swift \
        src/apple/Packages/MapleCore/Tests/MapleCoreTests/RemoteCatalogChangesTests.swift
git commit -m "feat(fileprovider): AssetChange DTO + RemoteCatalog listChanges/listAssets"
```

---

### Task C2: `ChangeCursorStore` — persisted last-seen cursor

The extension needs to remember its last-seen cursor across restarts so reconnects don't replay the entire feed (or worse, miss events).

**Files:**
- Create: `src/apple/Packages/MapleCore/Sources/MapleCore/FileProvider/ChangeCursorStore.swift`
- Create: `src/apple/Packages/MapleCore/Tests/MapleCoreTests/ChangeCursorStoreTests.swift`

- [ ] **Step 1: Write the failing test**

```swift
import XCTest
@testable import MapleCore

final class ChangeCursorStoreTests: XCTestCase {
    private func freshDefaults() -> UserDefaults {
        let suite = "test-\(UUID().uuidString)"
        return UserDefaults(suiteName: suite)!
    }

    func testInitiallyZero() {
        let store = ChangeCursorStore(defaults: freshDefaults())
        XCTAssertEqual(store.load(domain: "d"), 0)
    }

    func testSaveAndLoad() {
        let d = freshDefaults()
        let s1 = ChangeCursorStore(defaults: d)
        s1.save(123, domain: "d")
        let s2 = ChangeCursorStore(defaults: d)
        XCTAssertEqual(s2.load(domain: "d"), 123)
    }

    func testPerDomainIsolation() {
        let store = ChangeCursorStore(defaults: freshDefaults())
        store.save(10, domain: "a")
        store.save(20, domain: "b")
        XCTAssertEqual(store.load(domain: "a"), 10)
        XCTAssertEqual(store.load(domain: "b"), 20)
    }

    func testReset() {
        let store = ChangeCursorStore(defaults: freshDefaults())
        store.save(5, domain: "d")
        store.reset(domain: "d")
        XCTAssertEqual(store.load(domain: "d"), 0)
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd src/apple/Packages/MapleCore && swift test --filter ChangeCursorStoreTests
```

- [ ] **Step 3: Implement the store**

```swift
// src/apple/Packages/MapleCore/Sources/MapleCore/FileProvider/ChangeCursorStore.swift
import Foundation

public final class ChangeCursorStore: @unchecked Sendable {
    private let defaults: UserDefaults
    private let prefix = "fileprovider.cursor."

    public init(defaults: UserDefaults? = nil) {
        if let d = defaults {
            self.defaults = d
        } else {
            self.defaults = UserDefaults(suiteName: FileProviderConfig.appGroupSuiteName)
                ?? .standard
        }
    }

    public func load(domain: String) -> Int64 {
        let v = defaults.object(forKey: prefix + domain) as? Int64
        return v ?? 0
    }

    public func save(_ cursor: Int64, domain: String) {
        defaults.set(cursor, forKey: prefix + domain)
    }

    public func reset(domain: String) {
        defaults.removeObject(forKey: prefix + domain)
    }
}
```

- [ ] **Step 4: Run tests**

```bash
cd src/apple/Packages/MapleCore && swift test --filter ChangeCursorStoreTests
```

- [ ] **Step 5: Commit**

```bash
git add src/apple/Packages/MapleCore/Sources/MapleCore/FileProvider/ChangeCursorStore.swift \
        src/apple/Packages/MapleCore/Tests/MapleCoreTests/ChangeCursorStoreTests.swift
git commit -m "feat(fileprovider): persisted ChangeCursorStore in App Group defaults"
```

---

### Task C3: `WorkingSet` — pure in-memory table with bounded eviction

**Files:**
- Create: `src/apple/Packages/MapleCore/Sources/MapleCore/FileProvider/WorkingSet.swift`
- Create: `src/apple/Packages/MapleCore/Tests/MapleCoreTests/WorkingSetTests.swift`

The data structure: a dictionary keyed by `NSFileProviderItemIdentifier`-equivalent string, with each value carrying a `kind` (xmp / favorite / recent / active) and a `lastTouched: Date`. Eviction policy:
- Cap: 20,000 entries.
- Never evict: `.xmp`, `.favorite`.
- Evict (when over cap): `.recent` first (sorted by `lastTouched` ascending), then `.active`.
- A re-`touch` updates `lastTouched` and may upgrade the kind (e.g. `.recent → .favorite` if the user stars an asset).

- [ ] **Step 1: Write the failing test**

```swift
import XCTest
@testable import MapleCore

final class WorkingSetTests: XCTestCase {
    func testInsertAndEnumerate() {
        let ws = WorkingSet(capacity: 100)
        ws.upsert(identifier: "asset/1", kind: .recent, lastTouched: Date())
        ws.upsert(identifier: "asset/2", kind: .favorite, lastTouched: Date())
        let ids = ws.allIdentifiers().sorted()
        XCTAssertEqual(ids, ["asset/1", "asset/2"])
    }

    func testCapNeverDropsXMPsOrFavorites() {
        let ws = WorkingSet(capacity: 3)
        let now = Date()
        ws.upsert(identifier: "xmp/1", kind: .xmp,
                  lastTouched: now.addingTimeInterval(-100))
        ws.upsert(identifier: "fav/1", kind: .favorite,
                  lastTouched: now.addingTimeInterval(-100))
        // Cap = 3, so these recent entries push us over.
        ws.upsert(identifier: "recent/old", kind: .recent,
                  lastTouched: now.addingTimeInterval(-50))
        ws.upsert(identifier: "recent/mid", kind: .recent,
                  lastTouched: now.addingTimeInterval(-25))
        ws.upsert(identifier: "recent/new", kind: .recent, lastTouched: now)
        let ids = Set(ws.allIdentifiers())
        XCTAssertTrue(ids.contains("xmp/1"))
        XCTAssertTrue(ids.contains("fav/1"))
        // Oldest recent should be evicted, newer recents retained up to cap.
        XCTAssertFalse(ids.contains("recent/old"))
        XCTAssertTrue(ids.contains("recent/new"))
    }

    func testTouchUpdatesLastTouched() {
        let ws = WorkingSet(capacity: 10)
        let t0 = Date(timeIntervalSinceReferenceDate: 1000)
        let t1 = Date(timeIntervalSinceReferenceDate: 2000)
        ws.upsert(identifier: "asset/1", kind: .recent, lastTouched: t0)
        ws.upsert(identifier: "asset/1", kind: .recent, lastTouched: t1)
        XCTAssertEqual(ws.entry(for: "asset/1")?.lastTouched, t1)
    }

    func testUpsertCanUpgradeKindButNotDowngradeFromXMP() {
        let ws = WorkingSet(capacity: 10)
        ws.upsert(identifier: "x", kind: .xmp, lastTouched: Date())
        ws.upsert(identifier: "x", kind: .recent, lastTouched: Date())
        // Once tracked as XMP, must stay XMP (eviction-immune).
        XCTAssertEqual(ws.entry(for: "x")?.kind, .xmp)

        ws.upsert(identifier: "y", kind: .recent, lastTouched: Date())
        ws.upsert(identifier: "y", kind: .favorite, lastTouched: Date())
        // Upgrade recent → favorite OK.
        XCTAssertEqual(ws.entry(for: "y")?.kind, .favorite)

        ws.upsert(identifier: "z", kind: .favorite, lastTouched: Date())
        ws.upsert(identifier: "z", kind: .recent, lastTouched: Date())
        // No downgrade favorite → recent.
        XCTAssertEqual(ws.entry(for: "z")?.kind, .favorite)
    }

    func testRemoveDeletes() {
        let ws = WorkingSet(capacity: 10)
        ws.upsert(identifier: "a", kind: .recent, lastTouched: Date())
        ws.remove(identifier: "a")
        XCTAssertNil(ws.entry(for: "a"))
    }

    func testEvictsActiveOnlyAfterRecentExhausted() {
        let ws = WorkingSet(capacity: 2)
        let now = Date()
        // First fill with active entries (they're evictable too, but lower
        // priority than recent).
        ws.upsert(identifier: "active/1", kind: .active,
                  lastTouched: now.addingTimeInterval(-100))
        ws.upsert(identifier: "active/2", kind: .active,
                  lastTouched: now.addingTimeInterval(-50))
        // Now add a recent — should not push active out (recent is
        // lower-priority for retention).
        ws.upsert(identifier: "recent/1", kind: .recent, lastTouched: now)
        let ids = Set(ws.allIdentifiers())
        XCTAssertTrue(ids.contains("active/1"))
        XCTAssertTrue(ids.contains("active/2"))
        XCTAssertFalse(ids.contains("recent/1"))
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd src/apple/Packages/MapleCore && swift test --filter WorkingSetTests
```

- [ ] **Step 3: Implement `WorkingSet`**

```swift
// src/apple/Packages/MapleCore/Sources/MapleCore/FileProvider/WorkingSet.swift
import Foundation

public enum WorkingSetKind: Int, Comparable, Sendable {
    /// Never evicted. Sidecars are central to the editing story.
    case xmp = 3
    /// Never evicted. User-flagged content.
    case favorite = 2
    /// Evicted last among evictables. The OS asked for these.
    case active = 1
    /// Evicted first. Recency heuristic.
    case recent = 0

    public static func < (lhs: WorkingSetKind, rhs: WorkingSetKind) -> Bool {
        lhs.rawValue < rhs.rawValue
    }
}

public struct WorkingSetEntry: Sendable, Equatable {
    public var kind: WorkingSetKind
    public var lastTouched: Date
}

/// In-memory working set for the File Provider extension. Not thread-safe
/// on its own — wrap externally if accessed from multiple actors. The
/// long-lived owner is `WorkingSetEnumerator`, which calls methods on
/// the main extension's queue.
public final class WorkingSet: @unchecked Sendable {
    public let capacity: Int
    private var entries: [String: WorkingSetEntry] = [:]

    public init(capacity: Int = 20_000) {
        self.capacity = capacity
    }

    public func upsert(identifier: String, kind: WorkingSetKind, lastTouched: Date) {
        if let existing = entries[identifier] {
            // Kind can only move up (towards eviction-immune); never down.
            let newKind = max(existing.kind, kind)
            entries[identifier] = WorkingSetEntry(kind: newKind, lastTouched: lastTouched)
        } else {
            entries[identifier] = WorkingSetEntry(kind: kind, lastTouched: lastTouched)
        }
        if entries.count > capacity {
            evictUntilUnderCap()
        }
    }

    public func remove(identifier: String) {
        entries.removeValue(forKey: identifier)
    }

    public func entry(for identifier: String) -> WorkingSetEntry? {
        entries[identifier]
    }

    public func allIdentifiers() -> [String] {
        Array(entries.keys)
    }

    public func count() -> Int { entries.count }

    // MARK: - Eviction

    private func evictUntilUnderCap() {
        // Iterate by ascending priority: recent first, then active.
        let evictableKinds: [WorkingSetKind] = [.recent, .active]
        for kind in evictableKinds {
            if entries.count <= capacity { return }
            let candidates = entries
                .filter { $0.value.kind == kind }
                .sorted { $0.value.lastTouched < $1.value.lastTouched }
            for (id, _) in candidates {
                if entries.count <= capacity { return }
                entries.removeValue(forKey: id)
            }
        }
        // If still over cap, .xmp and .favorite are eviction-immune; tough
        // luck for the cap. Should never happen in practice given the
        // 20k ceiling vs ~5k XMPs and 200 favorites in the spec.
    }
}
```

- [ ] **Step 4: Run tests**

```bash
cd src/apple/Packages/MapleCore && swift test --filter WorkingSetTests
```

- [ ] **Step 5: Commit**

```bash
git add src/apple/Packages/MapleCore/Sources/MapleCore/FileProvider/WorkingSet.swift \
        src/apple/Packages/MapleCore/Tests/MapleCoreTests/WorkingSetTests.swift
git commit -m "feat(fileprovider): bounded WorkingSet table with kind-aware eviction"
```

---

### Task C4: `WorkingSetEnumerator`

**Files:**
- Create: `src/apple/MapleFileProvider/WorkingSetEnumerator.swift`
- Modify: `src/apple/MapleFileProvider/FileProviderExtension.swift`

The enumerator backs the `.workingSet` container. Phase 1's `EmptyEnumerator` returned no items; this returns the contents of the working set (rebuilding it on first call from the three list queries).

For each entry, it produces an `NSFileProviderItem` matching whatever asset/sidecar that identifier refers to. We don't have a per-asset metadata endpoint, so for now the enumerator constructs lightweight placeholders: `MapleItem(asset:)` is reachable when we have a full `ImageChild`, but the working set only has `AssetListEntry` rows. Two options:

(a) Add a `MapleItem(workingSetEntry:)` initializer that synthesizes from `AssetListEntry`. Simpler.

(b) Extend `RemoteCatalog` with a per-asset metadata endpoint that returns a full `ImageChild`. Heavier.

Choose **(a)**.

- [ ] **Step 1: Add a `MapleItem(workingSetEntry:)` initializer**

In `src/apple/MapleFileProvider/MapleItem.swift`, look for the existing `init(image:parentIdentifier:)` to mirror its shape. Add (next to it):

```swift
init?(workingSetEntry e: AssetListEntry) {
    // Reuse the asset-by-id identifier form so the OS routes back to
    // the correct fetchContents path.
    self.itemIdentifier = NSFileProviderItemIdentifier(
        FileProviderIdentifier.asset(e.id).rawValue
    )
    // The working-set container is the parent for surfaced items
    // (the OS reattaches them to their real container when it sees
    // a folder enumeration).
    self.parentItemIdentifier = .workingSet
    self.filename = e.filename
    self.contentType = UTType(filenameExtension:
        (e.filename as NSString).pathExtension) ?? .data
    self.size = nil
    self.documentSize = nil
    self.contentVersion = String(e.mtime).data(using: .utf8) ?? Data()
    self.metadataVersion = Data()
    self.capabilities = [.allowsReading, .allowsContentEnumerating]
}
```

Adjust the initializer to whatever `MapleItem`'s real shape is — these are illustrative property names that match the existing class. Read `MapleItem.swift` before writing this to keep the property mapping faithful.

- [ ] **Step 2: Write the enumerator**

```swift
// src/apple/MapleFileProvider/WorkingSetEnumerator.swift
import FileProvider
import MapleCore
import OSLog

final class WorkingSetEnumerator: NSObject, NSFileProviderEnumerator {
    private let catalog: RemoteCatalog
    private let workingSet: WorkingSet
    private let cursorStore: ChangeCursorStore
    private let domainID: String
    private let listCache: WorkingSetListCache
    private let log = Logger(subsystem: "app.justmaple.aperture.fileprovider",
                             category: "workingset")

    init(catalog: RemoteCatalog,
         workingSet: WorkingSet,
         cursorStore: ChangeCursorStore,
         domainID: String,
         listCache: WorkingSetListCache) {
        self.catalog = catalog
        self.workingSet = workingSet
        self.cursorStore = cursorStore
        self.domainID = domainID
        self.listCache = listCache
    }

    func invalidate() {}

    func enumerateItems(for observer: NSFileProviderEnumerationObserver,
                        startingAt page: NSFileProviderPage) {
        Task {
            do {
                let entries = try await listCache.entries()
                // Seed working set with all entries (kind classification
                // happens at upsert based on the entry source).
                let now = Date()
                for e in entries {
                    let kind = Self.kindFor(e)
                    workingSet.upsert(identifier:
                        FileProviderIdentifier.asset(e.id).rawValue,
                        kind: kind, lastTouched: now)
                }
                let items = entries.compactMap { MapleItem(workingSetEntry: $0) }
                observer.didEnumerate(items)
                observer.finishEnumerating(upTo: nil)
            } catch {
                log.error("workingSet enumerate failed: \(error.localizedDescription, privacy: .public)")
                observer.finishEnumeratingWithError(error)
            }
        }
    }

    func enumerateChanges(for observer: NSFileProviderChangeObserver,
                          from anchor: NSFileProviderSyncAnchor) {
        let since = Self.parseAnchor(anchor)
        Task {
            do {
                let page = try await catalog.listChanges(since: since, limit: 500)
                var updates: [NSFileProviderItem] = []
                var deletes: [NSFileProviderItemIdentifier] = []
                for ch in page.changes {
                    guard let assetID = ch.assetID else { continue }
                    let ident = NSFileProviderItemIdentifier(
                        FileProviderIdentifier.asset(assetID).rawValue
                    )
                    if ch.kind == .delete {
                        deletes.append(ident)
                        workingSet.remove(identifier: ident.rawValue)
                    } else {
                        // We don't have full metadata for the changed item
                        // without a per-asset GET. Signal that the item
                        // exists by handing back a stub MapleItem whose
                        // contentVersion is the new cursor; the OS will
                        // ask `item(for:)` to get the rest.
                        if let stub = MapleItem(stubAssetID: assetID,
                                                cursor: ch.cursor) {
                            updates.append(stub)
                        }
                    }
                }
                observer.didUpdate(updates)
                observer.didDeleteItems(withIdentifiers: deletes)
                let newAnchor = page.nextCursor.map { Self.anchor($0) } ?? anchor
                if let next = page.nextCursor {
                    cursorStore.save(next, domain: domainID)
                }
                observer.finishEnumeratingChanges(upTo: newAnchor, moreComing: false)
            } catch let e as StaleCursorError {
                log.notice("stale cursor (server current=\(e.current)); requesting full re-enumeration")
                // Per NSFileProviderError docs, throwing
                // `syncAnchorExpired` tells the OS to drop its cached
                // delta state and re-enumerate from scratch.
                observer.finishEnumeratingWithError(
                    NSError(domain: NSFileProviderErrorDomain,
                            code: NSFileProviderError.syncAnchorExpired.rawValue)
                )
            } catch {
                log.error("enumerateChanges failed: \(error.localizedDescription, privacy: .public)")
                observer.finishEnumeratingWithError(error)
            }
        }
    }

    func currentSyncAnchor(completionHandler: @escaping (NSFileProviderSyncAnchor?) -> Void) {
        let cursor = cursorStore.load(domain: domainID)
        completionHandler(Self.anchor(cursor))
    }

    private static func kindFor(_ e: AssetListEntry) -> WorkingSetKind {
        if e.rating >= 1 { return .favorite }
        if e.hasXMP { return .xmp }
        return .recent
    }

    private static func anchor(_ cursor: Int64) -> NSFileProviderSyncAnchor {
        NSFileProviderSyncAnchor(String(cursor).data(using: .utf8)!)
    }

    private static func parseAnchor(_ anchor: NSFileProviderSyncAnchor) -> Int64 {
        guard let s = String(data: anchor.rawValue, encoding: .utf8),
              let v = Int64(s) else { return 0 }
        return v
    }
}

/// Caches the three list queries (favorites + recent + xmp) for the
/// lifetime of the extension process. The change feed is the keep-fresh
/// path; this cache just exists so repeated `.workingSet` enumerations
/// don't refetch from scratch on every call.
actor WorkingSetListCache {
    private let catalog: RemoteCatalog
    private var cached: [AssetListEntry]?

    init(catalog: RemoteCatalog) { self.catalog = catalog }

    func entries() async throws -> [AssetListEntry] {
        if let c = cached { return c }
        // Pull all three filters and merge by id.
        async let favs = catalog.listAssets(ratingGTE: 1, limit: 20_000)
        async let xmps = catalog.listAssets(hasXMP: true, limit: 20_000)
        let thirtyDaysAgo = Date().addingTimeInterval(-30 * 86_400)
        async let recents = catalog.listAssets(capturedAfter: thirtyDaysAgo, limit: 20_000)
        let (a, b, c) = try await (favs.assets, xmps.assets, recents.assets)
        var byId: [String: AssetListEntry] = [:]
        for e in a + b + c { byId[e.id] = e }
        let merged = Array(byId.values)
        cached = merged
        return merged
    }

    func invalidate() { cached = nil }
}
```

`MapleItem(stubAssetID:cursor:)` is a new init that returns a minimal item whose contentVersion is the changed cursor — the OS hands it to `item(for:)` to retrieve the full version. Add it in `MapleItem.swift`:

```swift
init?(stubAssetID assetID: String, cursor: Int64) {
    self.itemIdentifier = NSFileProviderItemIdentifier(
        FileProviderIdentifier.asset(assetID).rawValue
    )
    self.parentItemIdentifier = .workingSet
    self.filename = "(stub)"
    self.contentType = .data
    self.size = nil
    self.documentSize = nil
    self.contentVersion = String(cursor).data(using: .utf8) ?? Data()
    self.metadataVersion = Data()
    self.capabilities = [.allowsReading]
}
```

(Again, adjust the property names to match `MapleItem`'s real shape — these are illustrative.)

- [ ] **Step 3: Wire `WorkingSetEnumerator` into `FileProviderExtension`**

In `FileProviderExtension.swift`:
- Add stored properties:
  ```swift
  private let workingSet: WorkingSet
  private let cursorStore: ChangeCursorStore
  private let workingSetListCache: WorkingSetListCache?
  ```
- Construct them in `init` next to `metaStore`:
  ```swift
  self.workingSet = WorkingSet(capacity: 20_000)
  self.cursorStore = ChangeCursorStore()
  self.workingSetListCache = catalog.map { WorkingSetListCache(catalog: $0) }
  ```
- In `enumerator(for:request:)`, replace the working-set branch:
  ```swift
  if containerItemIdentifier == .workingSet {
      guard let catalog = self.catalog, let listCache = workingSetListCache else {
          return EmptyEnumerator()
      }
      return WorkingSetEnumerator(catalog: catalog,
                                  workingSet: workingSet,
                                  cursorStore: cursorStore,
                                  domainID: domain.identifier.rawValue,
                                  listCache: listCache)
  }
  if containerItemIdentifier == .trashContainer {
      return EmptyEnumerator()
  }
  ```

- [ ] **Step 4: Verify the project builds**

```bash
cd src/apple && xcodebuild -project Maple.xcodeproj -scheme Maple -destination 'platform=macOS' -quiet build
```

- [ ] **Step 5: Commit**

```bash
git add src/apple/MapleFileProvider/WorkingSetEnumerator.swift \
        src/apple/MapleFileProvider/FileProviderExtension.swift \
        src/apple/MapleFileProvider/MapleItem.swift
git commit -m "feat(fileprovider): WorkingSetEnumerator backed by three-filter seeding + change feed"
```

---

### Task C5: `ChangeFeedClient` — long-lived SSE consumer

A URLSession-based SSE consumer that reconnects with exponential backoff and signals the working-set enumerator on each delivered event.

**Files:**
- Create: `src/apple/MapleFileProvider/ChangeFeedClient.swift`
- Modify: `src/apple/MapleFileProvider/FileProviderExtension.swift`

- [ ] **Step 1: Write the client**

```swift
// src/apple/MapleFileProvider/ChangeFeedClient.swift
import Foundation
import FileProvider
import MapleCore
import OSLog

/// Subscribes to /api/changes/subscribe and signals the FP working-set
/// enumerator on each event. Reconnects on failure with exponential
/// backoff capped at 16 s. Resumes from the last-seen cursor via the
/// `since` query param.
///
/// One instance per FP domain; owned by the FileProviderExtension.
final class ChangeFeedClient {
    private let server: URL
    private let tokensProvider: @Sendable () -> AuthTokens?
    private let cursorStore: ChangeCursorStore
    private let domainID: String
    private let onEvent: @Sendable (AssetChange) async -> Void
    private let log = Logger(subsystem: "app.justmaple.aperture.fileprovider",
                             category: "change-feed")
    private var task: Task<Void, Never>?

    init(server: URL,
         tokensProvider: @escaping @Sendable () -> AuthTokens?,
         cursorStore: ChangeCursorStore,
         domainID: String,
         onEvent: @escaping @Sendable (AssetChange) async -> Void) {
        self.server = server
        self.tokensProvider = tokensProvider
        self.cursorStore = cursorStore
        self.domainID = domainID
        self.onEvent = onEvent
    }

    func start() {
        guard task == nil else { return }
        task = Task { [weak self] in await self?.runForever() }
    }

    func stop() {
        task?.cancel()
        task = nil
    }

    private func runForever() async {
        var backoff: UInt64 = 2_000_000_000  // 2s in ns
        let maxBackoff: UInt64 = 16_000_000_000
        while !Task.isCancelled {
            do {
                try await runOneConnection()
                // Clean disconnect (server closed) — reset backoff for retry.
                backoff = 2_000_000_000
            } catch {
                log.notice("SSE connection ended: \(error.localizedDescription, privacy: .public)")
                try? await Task.sleep(nanoseconds: backoff)
                backoff = min(backoff * 2, maxBackoff)
            }
        }
    }

    private func runOneConnection() async throws {
        let since = cursorStore.load(domain: domainID)
        var comps = URLComponents(url: server.appending(path: "/api/changes/subscribe"),
                                   resolvingAgainstBaseURL: false)!
        comps.queryItems = [.init(name: "since", value: String(since))]
        var req = URLRequest(url: comps.url!)
        req.timeoutInterval = 0  // SSE: indefinite
        req.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        if let tok = tokensProvider() {
            req.setValue("Bearer \(tok.access)", forHTTPHeaderField: "Authorization")
        }

        let (bytes, resp) = try await URLSession.shared.bytes(for: req)
        let code = (resp as? HTTPURLResponse)?.statusCode ?? -1
        if code == 409 {
            // Server says our cursor is too old. Reset to 0 and let the next
            // reconnect catch up via replay-from-zero (the working-set
            // enumerator will full-re-enumerate on the next OS poll).
            log.notice("SSE 409 stale cursor; resetting to 0")
            cursorStore.reset(domain: domainID)
            return
        }
        guard (200..<300).contains(code) else {
            throw URLError(.badServerResponse)
        }

        // Parse SSE line-by-line. Spec: events end with a blank line.
        var dataBuffer = ""
        var idBuffer: String?
        for try await line in bytes.lines {
            if Task.isCancelled { return }
            if line.isEmpty {
                if !dataBuffer.isEmpty {
                    if let ev = decodeEvent(dataBuffer) {
                        if let idStr = idBuffer, let id = Int64(idStr) {
                            cursorStore.save(id, domain: domainID)
                        }
                        await onEvent(ev)
                    }
                }
                dataBuffer = ""
                idBuffer = nil
                continue
            }
            if line.hasPrefix(":") { continue }  // comment / keepalive
            if line.hasPrefix("id:") {
                idBuffer = String(line.dropFirst(3)).trimmingCharacters(in: .whitespaces)
            } else if line.hasPrefix("data:") {
                let chunk = line.dropFirst(5).trimmingCharacters(in: .whitespaces)
                dataBuffer = dataBuffer.isEmpty ? String(chunk) : dataBuffer + "\n" + chunk
            }
        }
    }

    private func decodeEvent(_ data: String) -> AssetChange? {
        guard let raw = data.data(using: .utf8) else { return nil }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return try? decoder.decode(AssetChange.self, from: raw)
    }
}
```

- [ ] **Step 2: Wire into the extension**

In `FileProviderExtension.swift`, add a stored property:

```swift
private var changeFeed: ChangeFeedClient?
```

After the catalog is constructed in `init`, start the feed:

```swift
let domainID = domain.identifier.rawValue
self.changeFeed = ChangeFeedClient(
    server: cfg.serverURL,
    tokensProvider: { tokensStore.load(domain: domainID) },
    cursorStore: self.cursorStore,
    domainID: domainID,
    onEvent: { [weak self] event in
        guard let self else { return }
        await self.handleChangeEvent(event)
    }
)
```

…and in `super.init()`'s downstream call:

```swift
self.changeFeed?.start()
```

(The closure must be set up after `super.init()` because of self-capture; restructure the init to do `super.init()` first, then build the feed, then assign and start it.)

Add the handler:

```swift
private func handleChangeEvent(_ event: AssetChange) async {
    // 1. Update the working set bookkeeping.
    if let assetID = event.assetID {
        let ident = FileProviderIdentifier.asset(assetID).rawValue
        switch event.kind {
        case .delete:
            workingSet.remove(identifier: ident)
        default:
            workingSet.upsert(identifier: ident, kind: .recent,
                              lastTouched: event.at)
        }
    }
    // 2. Signal the working-set enumerator so the OS asks us for changes.
    if let mgr = NSFileProviderManager(for: domain) {
        try? await mgr.signalEnumerator(for: .workingSet)
    }
    // 3. If the change names a folder, also signal that folder's enumerator.
    if let folderID = event.folderID {
        let folderIdent = NSFileProviderItemIdentifier(
            FileProviderIdentifier.folder(folderID: folderID, relativePath: "").rawValue
        )
        if let mgr = NSFileProviderManager(for: domain) {
            try? await mgr.signalEnumerator(for: folderIdent)
        }
        // The library-root cache should drop too — folder counts may have moved.
        await rootCache?.invalidate()
    }
}
```

In `invalidate()`, stop the feed:

```swift
func invalidate() {
    changeFeed?.stop()
    log.info("invalidate")
}
```

- [ ] **Step 3: Verify the project builds**

```bash
cd src/apple && xcodebuild -project Maple.xcodeproj -scheme Maple -destination 'platform=macOS' -quiet build
```

- [ ] **Step 4: Commit**

```bash
git add src/apple/MapleFileProvider/ChangeFeedClient.swift \
        src/apple/MapleFileProvider/FileProviderExtension.swift
git commit -m "feat(fileprovider): SSE-driven ChangeFeedClient with reconnect backoff"
```

---

## Section D — End-to-end verification

### Task D1: Manual smoke (server change → client signal)

Quick Look's panel isn't reachable from `XCTest`, but the change-feed behaviour is. Two-machine setup is ideal; one-machine is acceptable.

- [ ] **Step 1: Two-Mac integration smoke (skip if you only have one)**

1. Enable the FP domain on Mac A and Mac B against the same Maple server.
2. From the Maple app on Mac B, change a photo's rating to 5.
3. On Mac A, watch Finder. Within ~5 seconds (SSE round-trip + signal),
   the file's metadata refresh should fire — verify by inspecting it in
   Get Info (the modification date for the sidecar updates).
4. With Mac A's Wi-Fi off for 2 minutes, change three more photos on
   Mac B.
5. Turn Mac A's Wi-Fi back on. Confirm the three changes propagate
   without a manual Refresh click. Log output in Console should show
   `SSE connection ended` and reconnect.

- [ ] **Step 2: Single-Mac smoke**

1. Enable the FP domain.
2. Open Console.app, filter on subsystem `app.justmaple.aperture.fileprovider`.
3. Run `curl -X PUT -H "Authorization: Bearer <token>" -H "Content-Type: text/plain" \
          --data '<x:xmpmeta />' http://localhost:3000/api/assets/<id>/xmp`.
4. Confirm the log shows a `signalEnumerator(for: .workingSet)` line within ~1 second.

There's no commit at this step.

---

### Task D2: Manual stale-cursor smoke

- [ ] **Step 1: Force the 409 path**

1. Note the current `cursor` in MongoDB:
   `mongosh maple --eval 'db.server_state.findOne()'`.
2. Stop the API server.
3. In the App Group defaults of the extension, manually set a stale cursor:
   ```bash
   defaults write group.app.justmaple.aperture fileprovider.cursor.<domain-id> -int 1
   killall MapleFileProvider  # or restart the host app
   ```
4. Restart the API.
5. Watch Console — the extension's SSE connect should log `409 stale cursor; resetting to 0`.
6. The next working-set enumerate should fire a full re-seed via the list endpoints.

There's no commit at this step.

---

## Self-review

**Spec coverage**

- 5b goal — automatic push refresh via SSE + bounded working set — covered by Sections A (server) and C (extension).
- Server cursor allocation — Task A2 (`allocateCursor` atomic $inc).
- Change rows in same Mongo "transaction" — addressed in the rationale: no transactions exist in this codebase; change rows are best-effort post-write. Plan flags this explicitly.
- HTTP change endpoint with poll + SSE — Tasks A5 (poll) and A6 (SSE).
- SSE replay + 409 stale-cursor — Tasks A3, A6, A7.
- Working-set enumerator with kind-aware eviction (20k cap) — Tasks C3, C4.
- SSE client with reconnect backoff — Task C5.
- Compatibility with Phase 1's Refresh button — unchanged; still calls `signalEnumerator(for: .rootContainer)`. SSE supplements; doesn't replace.
- New filters `has_xmp`, `rating_gte`, `captured_after` — Task B1.

**Placeholders**

None. Each step has the actual code or command.

**Type consistency**

- `AssetChange` / `AssetChangeKind` shape matches between Swift and TS.
- `recordAndPublishAssetChange` signature consistent A4 → A7.
- `WorkingSet.upsert(identifier:kind:lastTouched:)` consistent C3 → C4 → C5.
- `ChangeCursorStore.load/save/reset(domain:)` consistent C2 → C4 → C5.

**Known risks to flag in review**

- `MapleItem` initializers in C4 reference property names (`itemIdentifier`, `filename`, `contentType`, `contentVersion`, etc.) that match the FileProvider protocol but may be expressed slightly differently in this project's `MapleItem.swift`. The implementer must read `MapleItem.swift` first and adjust.
- The Elysia `sse` helper's exact return shape is from `node_modules/elysia/dist/utils.d.ts`. If the runtime behaviour differs (Elysia 1.x has had churn on this), the fallback in A6 Step 4 spells out the raw-frame format.
- The change-emission wire-up in Task A7 touches many files; the integration test in Step 1 only covers `PUT /:id/xmp`. Reviewers should grep for `assets.updateOne` sites and confirm each has a matching emit. A follow-up task (not in this plan) could add a lint rule.
- The `WorkingSetEnumerator`'s `enumerateChanges` returns stub items for non-delete events. A follow-up phase should add a per-asset metadata endpoint so the OS gets full item versions in one round-trip instead of two (`enumerateChanges` → `item(for:)`).

---

## Done when

- [ ] `bun test` passes locally (or skips cleanly with "Mongo unreachable").
- [ ] `swift test` passes for the new MapleCore tests.
- [ ] `xcodebuild ... build` succeeds.
- [ ] Manual smoke in D1 shows server-side mutations propagating to a Finder-mounted library within ~5 seconds.
- [ ] Manual smoke in D2 shows a stale cursor triggering the 409 path and a full re-seed.
- [ ] Working set stays under 20k entries on a heavy library; eviction order matches WorkingSetTests.
