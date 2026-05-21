# Maple File Provider — Phase 5c (Perf Optimisation Pass) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make repeated enumerations and warm refreshes cheap. Add `ETag` + `If-None-Match` to the three enumeration responses (`/api/folders`, `/api/fs/dir`, `/api/assets/:id/thumb`), have the client send `If-None-Match` and reuse its in-memory decoded payload on 304. Prime the library-root list from a `UserDefaults`-backed disk cache so the first `enumerateItems` returns instantly while a background revalidation runs. Then conduct a single measured allocation/profile pass and fix what shows up — without speculating about what will.

**Architecture:**
1. Server: a `withETag()` Elysia helper that wraps a JSON-body handler. Computes `ETag` as `SHA-1(body)` (hex), checks the request's `If-None-Match` header, returns 304 when equal. Apply to `/api/folders`, `/api/fs/dir`. The thumb endpoint (`/api/assets/:id/thumb` and `/api/fs/thumb`) already computes an ETag from the file mtime; finish the `If-None-Match` check that's currently TODO.
2. Client: `RemoteCatalog` grows an in-memory ETag-keyed response cache. Each cacheable call (folders, dir, thumb) reads the cached entry, sends `If-None-Match`, and on 304 returns the cached body. On 200 it replaces the entry.
3. Client: `LibraryRootCache` persists to App Group `UserDefaults` and returns the cached list synchronously on `roots()` while triggering a background revalidation. The revalidation signals `.rootContainer` if it sees a change.
4. Measurement: an `os_signpost`-instrumented run captures before/after for two scenarios (cold Finder open, warm Refresh). Numbers go in the PR description, not a CI test.

**Dependency note:** 5c depends on 5b's working-set enumerator behaviour. With 5b, the OS predominantly calls `enumerateChanges` on the working-set container rather than full `enumerateItems` of root/folders; the ETag work on `/api/folders` and `/api/fs/dir` benefits the *non-working-set* paths that still see traffic (root-container enumeration on Finder open, folder enumeration when the user navigates into a non-pinned folder). Land 5c after 5b.

**Tech Stack:** Elysia, Node `crypto.createHash`, Swift `URLSession`, `os.signpost` for measurement.

## Out of scope

- Speculative micro-optimisations of the render loop. The Maple editor's pipeline is unaffected by FP changes.
- Partial / selective ETag invalidation. We use body-hash ETags so invalidation is automatic — any byte change in the response → new ETag.
- Background prefetch riding the change feed — Phase 6+.
- Profile-driven changes that don't show up in measurement. If the profile shows no per-tick allocations > 1 MB or no functions > 50 ms, the allocation-audit task closes with "no action taken" and we ship.

---

## Baseline measurement caveat

The spec requires before/after performance numbers (cold Finder open, warm Refresh, spacebar cold/hot). These cannot be captured in a CI / sandbox environment — they require:
- A live macOS desktop session with Finder.
- A running Maple API server with a populated MongoDB and on-disk indexed library.
- An enrolled File Provider domain on the test Mac.

**Two execution modes:**

- **Mode A: Live environment available.** Run Task 0 (baseline capture) before any 5c code lands. Numbers go in `.archived-plans/notes/2026-05-16-fp-phase5c-perf-baseline.md` (NOT committed alongside source — keep notes/ in `.gitignore` if it isn't already). Re-run after Task 7 (post-change measurement) and put the deltas in the PR description.
- **Mode B: No live environment.** Skip Task 0 and Task 7. Mark the PR description with `PERF_BASELINES_UNAVAILABLE` and call out which optimisation tasks were taken on faith (the ETag tasks are safe — they're additive caching with explicit tests; the eager root cache adds a code path that the unit tests cover).

If you start in Mode B, do NOT pretend to have numbers. The advisor will catch fabricated baselines.

---

## File structure

**New (server):**
- `src/api/src/runtime/http-etag.ts` — `withBodyETag` helper + 304 handling
- `src/api/src/runtime/http-etag.test.ts`

**Modified (server):**
- `src/api/src/routes/folders.ts` — wrap `GET /` response in `withBodyETag`
- `src/api/src/routes/fs.ts` — wrap `GET /dir` response in `withBodyETag`
- `src/api/src/routes/fs-thumbs.ts` — complete the `If-None-Match` check (TODO comment in current code)
- `src/api/src/routes/assets.ts` — add `If-None-Match` handling to `GET /:id/thumb`

**Modified (extension / MapleCore):**
- `src/apple/Packages/MapleCore/Sources/MapleCore/FileProvider/RemoteCatalog.swift` — ETag dictionary + `listFolders`/`listDir`/`getThumb` send `If-None-Match` and accept 304
- `src/apple/Packages/MapleCore/Sources/MapleCore/FileProvider/LibraryRootCache.swift` — split out of `FileProviderExtension.swift` into a standalone file, gain disk-priming + background revalidation. (Currently inline in `FileProviderExtension.swift` as an `actor` at the bottom; move it.)

**Tests:**
- `src/api/src/routes/folders.etag.test.ts`
- `src/api/src/routes/fs.etag.test.ts`
- `src/api/src/routes/assets.thumb-etag.test.ts`
- `src/apple/Packages/MapleCore/Tests/MapleCoreTests/RemoteCatalogETagTests.swift`
- `src/apple/Packages/MapleCore/Tests/MapleCoreTests/LibraryRootCacheTests.swift`

**Notes (not committed):**
- `.archived-plans/notes/2026-05-16-fp-phase5c-perf-baseline.md` — before/after numbers (Mode A only)

---

## Task 0: Baseline capture (Mode A only)

Skip this task entirely if no live environment is available; proceed to Task 1.

**Files:**
- Create (uncommitted): `.archived-plans/notes/2026-05-16-fp-phase5c-perf-baseline.md`

- [ ] **Step 1: Confirm tooling**

```bash
# Instruments must be installed (Xcode includes it).
xcrun xctrace list templates | grep -i "Time Profiler"
```

- [ ] **Step 2: Cold Finder open**

1. Enable the FP domain. Confirm the domain's library has 50+ roots and at least one folder with 500+ assets.
2. Force-quit Finder (`killall Finder`).
3. In Activity Monitor, watch for `MapleFileProvider`. Quit the process if running.
4. Open Finder, navigate to the Maple-mounted location.
5. Record: time to first paint of root container, time to fully-rendered root container, time to open one folder.
6. Use `xcrun xctrace record --template 'Time Profiler' --attach MapleFileProvider --output ~/perf-cold-before.trace` for a profile capture.

- [ ] **Step 3: Warm Refresh**

1. With Finder already at the mounted location, click the Refresh button in Maple's Settings (or `mgr.signalEnumerator(for: .rootContainer)` from the lldb console).
2. Record: time for the spinner to settle, count of network requests (`tcpdump -i lo0 -nn 'port 3000'` or just Console-log the URL fetches).

- [ ] **Step 4: Spacebar preview**

1. Spacebar a RAW for the first time (cold thumb cache).
2. Record: ms to first paint of the QL panel.
3. Spacebar a different RAW that has already been previewed once (warm thumb cache).
4. Record: ms to first paint.

- [ ] **Step 5: Write down the numbers**

Format (Markdown):

```markdown
# FP Phase 5c — Perf baseline

Captured: 2026-05-16, on <hardware> / <macOS version>
Server: <API host>, library size: <N> roots / <M> assets
Mongo: <N rows in assets / <K> in asset_changes

## Cold Finder open
- First paint root: <ms>
- Fully rendered root: <ms>
- Open one folder (cold): <ms>
- # network requests: <N>

## Warm Refresh
- Spinner-to-settled: <ms>
- # network requests: <N>

## Spacebar
- Cold first paint: <ms>
- Warm first paint: <ms>

## Profile attachment
~/perf-cold-before.trace
```

This file is NOT committed. Save to `.archived-plans/notes/`. Re-create after the perf tasks land.

---

## Task 1: `withBodyETag` server helper

Compute SHA-1 of the JSON-stringified body, set `ETag: "<hex>"`, compare against `If-None-Match` on the way in, return 304 when equal.

**Files:**
- Create: `src/api/src/runtime/http-etag.ts`
- Create: `src/api/src/runtime/http-etag.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/api/src/runtime/http-etag.test.ts
import { describe, expect, it } from "bun:test";
import { computeBodyETag, ifNoneMatchEqual } from "./http-etag.ts";

describe("computeBodyETag", () => {
  it("returns a stable quoted hash for a string body", () => {
    const a = computeBodyETag("hello");
    const b = computeBodyETag("hello");
    expect(a).toBe(b);
    expect(a).toMatch(/^"[a-f0-9]+"$/);
  });

  it("differs for different bodies", () => {
    expect(computeBodyETag("a")).not.toBe(computeBodyETag("b"));
  });

  it("accepts a Buffer body", () => {
    const etag = computeBodyETag(Buffer.from([1, 2, 3]));
    expect(etag).toMatch(/^"[a-f0-9]+"$/);
  });
});

describe("ifNoneMatchEqual", () => {
  it("returns true when client matches exactly", () => {
    expect(ifNoneMatchEqual('"abc"', '"abc"')).toBe(true);
  });

  it("tolerates the weak-validator prefix", () => {
    expect(ifNoneMatchEqual('W/"abc"', '"abc"')).toBe(true);
    expect(ifNoneMatchEqual('"abc"', 'W/"abc"')).toBe(true);
  });

  it("returns false when client value differs", () => {
    expect(ifNoneMatchEqual('"abc"', '"def"')).toBe(false);
  });

  it("returns false when client header missing", () => {
    expect(ifNoneMatchEqual(undefined, '"abc"')).toBe(false);
  });

  it("handles wildcard *", () => {
    expect(ifNoneMatchEqual("*", '"abc"')).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd src/api && bun test src/runtime/http-etag.test.ts 2>&1 | tail -10
```

- [ ] **Step 3: Implement the helper**

```typescript
// src/api/src/runtime/http-etag.ts
/**
 * Tiny utilities for adding RFC-7232 conditional-request handling
 * (ETag + If-None-Match) to JSON / bytes endpoints.
 *
 * Strategy: body-hash ETags. Compute SHA-1 of the response body, quote
 * it. Any byte-level change in the body produces a new ETag, so cache
 * invalidation is automatic and we never have to reason about partial
 * staleness.
 *
 * Used by the File Provider extension to short-circuit enumeration
 * responses when its cached payload is still fresh.
 */

import { createHash } from "node:crypto";

export function computeBodyETag(body: string | Buffer | Uint8Array): string {
  const h = createHash("sha1");
  if (typeof body === "string") h.update(body);
  else h.update(body);
  return `"${h.digest("hex")}"`;
}

/**
 * Compare a client `If-None-Match` header against a server ETag.
 * Tolerates the optional `W/` weak-validator prefix on either side and
 * supports the `*` wildcard (matches any current representation).
 */
export function ifNoneMatchEqual(
  clientHeader: string | undefined,
  serverEtag: string
): boolean {
  if (!clientHeader) return false;
  if (clientHeader.trim() === "*") return true;
  const norm = (s: string) => s.startsWith("W/") ? s.slice(2) : s;
  return norm(clientHeader.trim()) === norm(serverEtag);
}
```

- [ ] **Step 4: Run tests**

```bash
cd src/api && bun test src/runtime/http-etag.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/api/src/runtime/http-etag.ts src/api/src/runtime/http-etag.test.ts
git commit -m "feat(api): body-hash ETag helper + If-None-Match comparator"
```

---

## Task 2: Apply ETag to `GET /api/folders`

**Files:**
- Modify: `src/api/src/routes/folders.ts`
- Create: `src/api/src/routes/folders.etag.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/api/src/routes/folders.etag.test.ts
import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { Elysia } from "elysia";
import { MongoClient, ObjectId, type Db } from "mongodb";
import { foldersRoutes } from "./folders.ts";

const MONGO_URI = process.env.MAPLE_MONGO_URI ?? "mongodb://localhost:27017";
const TEST_DB = `maple_folders_etag_test_${process.pid}`;
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
  await db.collection("folders").insertOne({
    _id: new ObjectId(), path: "/srv/p", label: "p",
    last_scan: null, file_count: 0, created_at: new Date().toISOString(),
  } as never);
});

afterAll(async () => {
  if (db) await db.dropDatabase();
  if (client) await client.close();
});

describe("GET /api/folders — ETag", () => {
  it.skipIf(!client)("returns ETag header on 200", async () => {
    const app = new Elysia().use(foldersRoutes);
    const res = await app.handle(new Request("http://x/api/folders"));
    expect(res.status).toBe(200);
    expect(res.headers.get("ETag")).toMatch(/^"[a-f0-9]+"$/);
  });

  it.skipIf(!client)("returns 304 when If-None-Match matches", async () => {
    const app = new Elysia().use(foldersRoutes);
    const first = await app.handle(new Request("http://x/api/folders"));
    const etag = first.headers.get("ETag")!;
    const second = await app.handle(new Request("http://x/api/folders", {
      headers: { "If-None-Match": etag },
    }));
    expect(second.status).toBe(304);
    expect((await second.text()).length).toBe(0);
    expect(second.headers.get("ETag")).toBe(etag);
  });

  it.skipIf(!client)("returns 200 with a new ETag when folders change", async () => {
    if (!db) return;
    const app = new Elysia().use(foldersRoutes);
    const first = await app.handle(new Request("http://x/api/folders"));
    const etag1 = first.headers.get("ETag")!;
    await db.collection("folders").insertOne({
      _id: new ObjectId(), path: "/srv/q", label: "q",
      last_scan: null, file_count: 0, created_at: new Date().toISOString(),
    } as never);
    const second = await app.handle(new Request("http://x/api/folders", {
      headers: { "If-None-Match": etag1 },
    }));
    expect(second.status).toBe(200);
    expect(second.headers.get("ETag")).not.toBe(etag1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd src/api && bun test src/routes/folders.etag.test.ts 2>&1 | tail -10
```

- [ ] **Step 3: Wire ETag into `GET /api/folders`**

Open `src/api/src/routes/folders.ts`. Find the `GET /` handler and modify it. The current handler returns a plain object; we need to:
1. Serialize the body ourselves.
2. Compute the ETag.
3. Compare against the request's `If-None-Match`.
4. Either return 304 (and bail) or return the body with the ETag header attached.

Pattern (adapt to the existing handler's variable names):

```typescript
import { computeBodyETag, ifNoneMatchEqual } from "../runtime/http-etag.ts";

// inside the GET / handler, after fetching the folders list:
const body = JSON.stringify(folders);
const etag = computeBodyETag(body);
const ifNoneMatch = headers["if-none-match"];
if (ifNoneMatchEqual(typeof ifNoneMatch === "string" ? ifNoneMatch : undefined, etag)) {
  set.status = 304;
  set.headers["ETag"] = etag;
  return new Response(null, { status: 304, headers: { ETag: etag } });
}
set.headers["ETag"] = etag;
set.headers["Content-Type"] = "application/json";
return new Response(body, {
  status: 200,
  headers: { ETag: etag, "Content-Type": "application/json" },
});
```

The current handler signature might not destructure `headers` — add it (`async ({ set, headers }) => {...}`). Elysia exposes `headers` as a lowercase-keyed map.

If the handler is registered as a typed route that demands `t.Object(...)` response schema, you may need to relax it (Response objects bypass type narrowing).

- [ ] **Step 4: Run tests**

```bash
cd src/api && bun test src/routes/folders.etag.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/api/src/routes/folders.ts src/api/src/routes/folders.etag.test.ts
git commit -m "feat(api): ETag + If-None-Match on GET /api/folders"
```

---

## Task 3: Apply ETag to `GET /api/fs/dir`

Same pattern as Task 2.

**Files:**
- Modify: `src/api/src/routes/fs.ts`
- Create: `src/api/src/routes/fs.etag.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/api/src/routes/fs.etag.test.ts
import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { Elysia } from "elysia";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fsRoutes } from "./fs.ts";

let tmp: string | null = null;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "maple-fs-etag-"));
  process.env.MAPLE_ROOTS = tmp;
  await writeFile(join(tmp, "a.dng"), Buffer.alloc(8));
});

afterAll(async () => { if (tmp) await rm(tmp, { recursive: true, force: true }); });

describe("GET /api/fs/dir — ETag", () => {
  it("returns ETag on 200", async () => {
    const app = new Elysia().use(fsRoutes);
    const res = await app.handle(new Request(
      `http://x/api/fs/dir?path=${encodeURIComponent(tmp!)}`
    ));
    expect(res.status).toBe(200);
    expect(res.headers.get("ETag")).toMatch(/^"[a-f0-9]+"$/);
  });

  it("returns 304 when If-None-Match matches", async () => {
    const app = new Elysia().use(fsRoutes);
    const first = await app.handle(new Request(
      `http://x/api/fs/dir?path=${encodeURIComponent(tmp!)}`
    ));
    const etag = first.headers.get("ETag")!;
    const second = await app.handle(new Request(
      `http://x/api/fs/dir?path=${encodeURIComponent(tmp!)}`,
      { headers: { "If-None-Match": etag } }
    ));
    expect(second.status).toBe(304);
  });

  it("returns 200 with a new ETag when contents change", async () => {
    const app = new Elysia().use(fsRoutes);
    const first = await app.handle(new Request(
      `http://x/api/fs/dir?path=${encodeURIComponent(tmp!)}`
    ));
    const etag1 = first.headers.get("ETag")!;
    await writeFile(join(tmp!, "b.dng"), Buffer.alloc(8));
    const second = await app.handle(new Request(
      `http://x/api/fs/dir?path=${encodeURIComponent(tmp!)}`,
      { headers: { "If-None-Match": etag1 } }
    ));
    expect(second.status).toBe(200);
    expect(second.headers.get("ETag")).not.toBe(etag1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd src/api && bun test src/routes/fs.etag.test.ts 2>&1 | tail -10
```

- [ ] **Step 3: Wire ETag into `GET /api/fs/dir`**

Same shape as Task 2. Find the `GET /dir` handler in `fs.ts`; wrap the response in the same way. Note: `fs.ts` has an existing `GET /file` route that already sets an ETag computed from mtime+size — leave that alone, this task only touches `/dir`.

The dir response body is a full `DirContents` JSON. SHA-1 of the JSON body is the right key.

- [ ] **Step 4: Run tests**

```bash
cd src/api && bun test src/routes/fs.etag.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/api/src/routes/fs.ts src/api/src/routes/fs.etag.test.ts
git commit -m "feat(api): ETag + If-None-Match on GET /api/fs/dir"
```

---

## Task 4: Complete `If-None-Match` on thumb endpoints

`GET /api/fs/thumb` already computes the ETag but the `If-None-Match` check is commented out as TODO. `GET /api/assets/:id/thumb` doesn't have ETag handling at all.

**Files:**
- Modify: `src/api/src/routes/fs-thumbs.ts`
- Modify: `src/api/src/routes/assets.ts`
- Create: `src/api/src/routes/assets.thumb-etag.test.ts`

- [ ] **Step 1: Write the failing test for the assets thumb endpoint**

```typescript
// src/api/src/routes/assets.thumb-etag.test.ts
import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { Elysia } from "elysia";
import { MongoClient, ObjectId, type Db } from "mongodb";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { assetsRoutes } from "./assets.ts";
import { resolveThumbPath } from "../fs/xmp.ts";

const MONGO_URI = process.env.MAPLE_MONGO_URI ?? "mongodb://localhost:27017";
const TEST_DB = `maple_assets_thumb_etag_${process.pid}`;
let client: MongoClient | null = null;
let db: Db | null = null;
let tmp: string | null = null;
let assetId: ObjectId | null = null;

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
  tmp = await mkdtemp(join(tmpdir(), "maple-thumb-etag-"));
  process.env.MAPLE_ROOTS = tmp;
  const rawPath = join(tmp, "a.dng");
  await writeFile(rawPath, Buffer.alloc(8));
  const thumbPath = resolveThumbPath(rawPath);
  await mkdir(dirname(thumbPath), { recursive: true });
  await writeFile(thumbPath, Buffer.from([0xff, 0xd8, 0xff]));
  assetId = new ObjectId();
  await db.collection("assets").insertOne({
    _id: assetId, folder_id: new ObjectId(), filename: "a.dng",
    abs_path: rawPath, size: 8, mtime: Date.now(), rating: 0, flag: 0,
    color_label: "", indexed_at: "now",
  } as never);
});

afterAll(async () => {
  if (db) await db.dropDatabase();
  if (client) await client.close();
  if (tmp) await rm(tmp, { recursive: true, force: true });
});

describe("GET /api/assets/:id/thumb — ETag", () => {
  it.skipIf(!client)("returns ETag on 200", async () => {
    const app = new Elysia().use(assetsRoutes);
    const res = await app.handle(new Request(
      `http://x/api/assets/${assetId!.toHexString()}/thumb`
    ));
    expect(res.status).toBe(200);
    expect(res.headers.get("ETag")).toMatch(/^".+"$/);
  });

  it.skipIf(!client)("returns 304 when If-None-Match matches", async () => {
    const app = new Elysia().use(assetsRoutes);
    const first = await app.handle(new Request(
      `http://x/api/assets/${assetId!.toHexString()}/thumb`
    ));
    const etag = first.headers.get("ETag")!;
    const second = await app.handle(new Request(
      `http://x/api/assets/${assetId!.toHexString()}/thumb`,
      { headers: { "If-None-Match": etag } }
    ));
    expect(second.status).toBe(304);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd src/api && bun test src/routes/assets.thumb-etag.test.ts 2>&1 | tail -10
```

- [ ] **Step 3: Add ETag handling to `GET /api/assets/:id/thumb`**

Edit `src/api/src/routes/assets.ts` thumb handler. After `safeReadFile` succeeds:

```typescript
import { stat } from "node:fs/promises";
// ...

const thumbPath = resolveThumbPath(doc.abs_path);
const result = await safeReadFile(thumbPath);
if (!result.ok) {
  set.status = 404;
  return { error: "Thumbnail not yet generated" };
}
const st = await stat(thumbPath);
const etag = `"${Math.floor(st.mtimeMs)}-${st.size}"`;
const ifNoneMatch = headers["if-none-match"];
if (ifNoneMatchEqual(typeof ifNoneMatch === "string" ? ifNoneMatch : undefined, etag)) {
  set.status = 304;
  return new Response(null, { status: 304, headers: { ETag: etag } });
}
set.headers["Content-Type"] = "image/jpeg";
set.headers["Cache-Control"] = "public, max-age=604800, immutable";
set.headers["ETag"] = etag;
return result.data;
```

Add the imports at the top:

```typescript
import { stat } from "node:fs/promises";
import { ifNoneMatchEqual } from "../runtime/http-etag.ts";
```

Add `headers` to the handler signature: `async ({ params, query, headers, set }) => {...}`.

- [ ] **Step 4: Complete the `If-None-Match` check on `GET /api/fs/thumb`**

In `src/api/src/routes/fs-thumbs.ts`, find the comment "If-None-Match handling … keep this simple and just always serve bytes." Replace it with the actual check, mirroring Task 4 Step 3.

The handler must accept `headers` (likely already does — confirm by reading the existing handler signature).

After the `const etag = `"${Math.floor(rawMtimeMs)}"`;` line, add:

```typescript
const ifNoneMatch = headers["if-none-match"];
if (ifNoneMatchEqual(typeof ifNoneMatch === "string" ? ifNoneMatch : undefined, etag)) {
  set.status = 304;
  return new Response(null, { status: 304, headers: { ETag: etag } });
}
```

Add the import:

```typescript
import { ifNoneMatchEqual } from "../runtime/http-etag.ts";
```

- [ ] **Step 5: Run tests**

```bash
cd src/api && bun test src/routes/assets.thumb-etag.test.ts
```

- [ ] **Step 6: Commit**

```bash
git add src/api/src/routes/assets.ts src/api/src/routes/fs-thumbs.ts \
        src/api/src/routes/assets.thumb-etag.test.ts
git commit -m "feat(api): If-None-Match handling on /api/assets/:id/thumb and /api/fs/thumb"
```

---

## Task 5: Client ETag cache in `RemoteCatalog`

Track ETags per URL inside the actor. Each cacheable call:
1. Construct the URL.
2. Look up the cached entry (etag + decoded value).
3. If present, send `If-None-Match`.
4. On 200, decode, replace the cache entry, return.
5. On 304, return the cached decoded value.

**Files:**
- Modify: `src/apple/Packages/MapleCore/Sources/MapleCore/FileProvider/RemoteCatalog.swift`
- Create: `src/apple/Packages/MapleCore/Tests/MapleCoreTests/RemoteCatalogETagTests.swift`

- [ ] **Step 1: Write the failing test**

```swift
import XCTest
@testable import MapleCore

final class RemoteCatalogETagTests: XCTestCase {
    func testListFoldersSendsIfNoneMatchOnSecondCall() async throws {
        let server = URL(string: "https://example.test")!
        let session = MockURLProtocol.makeSession()

        nonisolated(unsafe) var seenIfNoneMatch: [String?] = []
        MockURLProtocol.handler = { req in
            seenIfNoneMatch.append(req.value(forHTTPHeaderField: "If-None-Match"))
            let body = #"""
            [{"id":"650a","path":"/p","label":"p","file_count":1}]
            """#
            let r = HTTPURLResponse(url: req.url!, statusCode: 200,
                                    httpVersion: nil,
                                    headerFields: ["ETag": "\"abc\""])!
            return (r, body.data(using: .utf8)!)
        }

        let http = AuthenticatedHTTPClient(
            server: server, urlSession: session,
            tokensProvider: { AuthTokens(access: "t", refresh: "r") },
            onTokensRefreshed: { _ in }, onSignOut: { }
        )
        let cat = RemoteCatalog(http: http, server: server)
        _ = try await cat.listFolders()
        _ = try await cat.listFolders()
        XCTAssertEqual(seenIfNoneMatch.count, 2)
        XCTAssertNil(seenIfNoneMatch[0])
        XCTAssertEqual(seenIfNoneMatch[1], "\"abc\"")
    }

    func testListFolders304ReturnsCachedValue() async throws {
        let server = URL(string: "https://example.test")!
        let session = MockURLProtocol.makeSession()
        nonisolated(unsafe) var callCount = 0
        MockURLProtocol.handler = { req in
            callCount += 1
            if callCount == 1 {
                let body = #"""
                [{"id":"650a","path":"/p","label":"p","file_count":1}]
                """#
                let r = HTTPURLResponse(url: req.url!, statusCode: 200,
                                        httpVersion: nil,
                                        headerFields: ["ETag": "\"abc\""])!
                return (r, body.data(using: .utf8)!)
            } else {
                let r = HTTPURLResponse(url: req.url!, statusCode: 304,
                                        httpVersion: nil,
                                        headerFields: ["ETag": "\"abc\""])!
                return (r, Data())
            }
        }
        let http = AuthenticatedHTTPClient(
            server: server, urlSession: session,
            tokensProvider: { AuthTokens(access: "t", refresh: "r") },
            onTokensRefreshed: { _ in }, onSignOut: { }
        )
        let cat = RemoteCatalog(http: http, server: server)
        let first = try await cat.listFolders()
        let second = try await cat.listFolders()
        XCTAssertEqual(first, second)
    }

    func testListFoldersNewETagReplacesCache() async throws {
        let server = URL(string: "https://example.test")!
        let session = MockURLProtocol.makeSession()
        nonisolated(unsafe) var callCount = 0
        MockURLProtocol.handler = { req in
            callCount += 1
            let etag = callCount == 1 ? "\"abc\"" : "\"def\""
            let body = callCount == 1
                ? #"[{"id":"a","path":"/a","label":"a","file_count":1}]"#
                : #"[{"id":"a","path":"/a","label":"a","file_count":2}]"#
            let r = HTTPURLResponse(url: req.url!, statusCode: 200,
                                    httpVersion: nil,
                                    headerFields: ["ETag": etag])!
            return (r, body.data(using: .utf8)!)
        }
        let http = AuthenticatedHTTPClient(
            server: server, urlSession: session,
            tokensProvider: { AuthTokens(access: "t", refresh: "r") },
            onTokensRefreshed: { _ in }, onSignOut: { }
        )
        let cat = RemoteCatalog(http: http, server: server)
        let first = try await cat.listFolders()
        let second = try await cat.listFolders()
        XCTAssertEqual(first[0].fileCount, 1)
        XCTAssertEqual(second[0].fileCount, 2)
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd src/apple/Packages/MapleCore && swift test --filter RemoteCatalogETagTests
```

The first test will fail because the second call sends nil for `If-None-Match` (no cache yet).

- [ ] **Step 3: Add the ETag cache to `RemoteCatalog`**

In `RemoteCatalog.swift`, add inside the actor:

```swift
/// In-memory cache of (etag, decoded value) keyed by absolute URL.
/// One entry per URL — sufficient for `/api/folders` (one URL) and
/// `/api/fs/dir?path=...` (one URL per directory the user touches).
/// Cleared on `invalidateETagCache()`.
private var etagCache: [String: (etag: String, payload: Any)] = [:]

public func invalidateETagCache() {
    etagCache.removeAll()
}
```

Refactor `listFolders()` to use the cache. The natural pattern:

```swift
public func listFolders() async throws -> [LibraryRoot] {
    let url = server.appending(path: "/api/folders")
    return try await fetchCachedJSON(url: url, decode: [LibraryRoot].self)
}
```

…where `fetchCachedJSON` is:

```swift
private func fetchCachedJSON<T: Decodable & Sendable>(
    url: URL, decode: T.Type
) async throws -> T {
    var req = URLRequest(url: url)
    let key = url.absoluteString
    let cached = etagCache[key]
    if let cached {
        req.setValue(cached.etag, forHTTPHeaderField: "If-None-Match")
    }
    let (data, resp) = try await http.data(for: req)
    let httpResp = resp as? HTTPURLResponse
    if httpResp?.statusCode == 304, let cached, let value = cached.payload as? T {
        return value
    }
    try Self.check2xx(resp)
    let value = try decoder.decode(T.self, from: data)
    if let etag = httpResp?.value(forHTTPHeaderField: "ETag") {
        etagCache[key] = (etag, value as Any)
    }
    return value
}
```

Apply the same wrapping to `listDir`:

```swift
public func listDir(absolutePath: String) async throws -> DirContents {
    var comps = URLComponents(url: server.appending(path: "/api/fs/dir"),
                              resolvingAgainstBaseURL: false)!
    comps.queryItems = [.init(name: "path", value: absolutePath)]
    return try await fetchCachedJSON(url: comps.url!, decode: DirContents.self)
}
```

For `getThumb`, the same pattern but the payload is `Data`, not a decoded JSON value. Add a parallel helper:

```swift
public func getThumb(assetID: String) async throws -> Data {
    let url = server.appending(path: "/api/assets/\(assetID)/thumb")
    var req = URLRequest(url: url)
    let key = url.absoluteString
    if let cached = etagCache[key] {
        req.setValue(cached.etag, forHTTPHeaderField: "If-None-Match")
    }
    let (data, resp) = try await http.data(for: req)
    let httpResp = resp as? HTTPURLResponse
    if httpResp?.statusCode == 304,
       let cached = etagCache[key],
       let bytes = cached.payload as? Data {
        return bytes
    }
    try Self.check2xx(resp)
    if let etag = httpResp?.value(forHTTPHeaderField: "ETag") {
        etagCache[key] = (etag, data as Any)
    }
    return data
}
```

(Note: `getThumb` was added in Task 3 of plan 5a. If 5a hasn't shipped yet, this task is the one adding it; reconcile with the 5a plan.)

- [ ] **Step 4: Run tests**

```bash
cd src/apple/Packages/MapleCore && swift test --filter RemoteCatalogETagTests
```

- [ ] **Step 5: Commit**

```bash
git add src/apple/Packages/MapleCore/Sources/MapleCore/FileProvider/RemoteCatalog.swift \
        src/apple/Packages/MapleCore/Tests/MapleCoreTests/RemoteCatalogETagTests.swift
git commit -m "feat(fileprovider): in-memory ETag cache in RemoteCatalog"
```

---

## Task 6: `LibraryRootCache` — disk-priming + background revalidation

Move the inline `LibraryRootCache` actor out of `FileProviderExtension.swift` into its own file. Add:
1. Disk priming from App Group `UserDefaults` on init.
2. `roots()` returns the disk-primed list synchronously while triggering a background revalidation.
3. On revalidation, if the list differs, signal `.rootContainer` so the OS re-enumerates.

**Files:**
- Create: `src/apple/Packages/MapleCore/Sources/MapleCore/FileProvider/LibraryRootCache.swift`
- Modify: `src/apple/MapleFileProvider/FileProviderExtension.swift`
- Create: `src/apple/Packages/MapleCore/Tests/MapleCoreTests/LibraryRootCacheTests.swift`

- [ ] **Step 1: Write the failing test**

The cache must support being tested without a real network — the catalog dependency is awkward. Refactor the cache to take a closure `() async throws -> [LibraryRoot]` instead of a catalog reference; the FP extension passes `{ try await catalog.listFolders() }`.

```swift
// src/apple/Packages/MapleCore/Tests/MapleCoreTests/LibraryRootCacheTests.swift
import XCTest
@testable import MapleCore

final class LibraryRootCacheTests: XCTestCase {
    private func freshDefaults() -> UserDefaults {
        UserDefaults(suiteName: "test-\(UUID().uuidString)")!
    }

    private func mkRoot(_ id: String) -> LibraryRoot {
        LibraryRoot(id: id, path: "/p/\(id)", label: id, fileCount: 1)
    }

    func testReturnsDiskPrimedRootsBeforeFetch() async throws {
        let defaults = freshDefaults()
        // Pre-seed disk cache.
        let primed = [mkRoot("a"), mkRoot("b")]
        let data = try JSONEncoder().encode(primed)
        defaults.set(data, forKey: "fileprovider.rootcache.default")

        nonisolated(unsafe) var fetchCount = 0
        let cache = LibraryRootCache(domainID: "default",
                                      defaults: defaults,
                                      fetcher: {
            fetchCount += 1
            try? await Task.sleep(nanoseconds: 50_000_000)
            return primed
        })
        let result = try await cache.roots()
        XCTAssertEqual(result.map { $0.id }, ["a", "b"])
        // Fetcher may or may not have completed depending on scheduling;
        // we just check it was kicked off (or will be).
    }

    func testFirstCallWithoutDiskAwaitsFetcher() async throws {
        let defaults = freshDefaults()
        let cache = LibraryRootCache(domainID: "default",
                                      defaults: defaults,
                                      fetcher: { [self.mkRoot("a")] })
        let result = try await cache.roots()
        XCTAssertEqual(result.map { $0.id }, ["a"])
    }

    func testPersistsToDiskAfterFetch() async throws {
        let defaults = freshDefaults()
        let cache = LibraryRootCache(domainID: "default",
                                      defaults: defaults,
                                      fetcher: { [self.mkRoot("a")] })
        _ = try await cache.roots()
        // Wait briefly for any background persist to flush.
        try await Task.sleep(nanoseconds: 50_000_000)
        let data = defaults.data(forKey: "fileprovider.rootcache.default")
        XCTAssertNotNil(data)
    }

    func testInvalidateDropsDiskCache() async throws {
        let defaults = freshDefaults()
        let cache = LibraryRootCache(domainID: "default",
                                      defaults: defaults,
                                      fetcher: { [self.mkRoot("a")] })
        _ = try await cache.roots()
        try await Task.sleep(nanoseconds: 50_000_000)
        await cache.invalidate()
        XCTAssertNil(defaults.data(forKey: "fileprovider.rootcache.default"))
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd src/apple/Packages/MapleCore && swift test --filter LibraryRootCacheTests
```

Expected: compile error — `LibraryRootCache` not in `MapleCore`.

- [ ] **Step 3: Implement the cache**

```swift
// src/apple/Packages/MapleCore/Sources/MapleCore/FileProvider/LibraryRootCache.swift
import Foundation
import OSLog

/// Caches the library-roots list for the lifetime of the extension
/// process AND persists to App Group `UserDefaults` so first-launch
/// `roots()` returns instantly. The background revalidation runs
/// every call and signals the FP root container if drift is detected.
///
/// The cache does NOT signal anything by itself — it just produces a
/// boolean "drift detected" event the FP extension wires to a
/// `signalEnumerator(for: .rootContainer)` call.
public actor LibraryRootCache {
    public typealias Fetcher = @Sendable () async throws -> [LibraryRoot]
    public typealias DriftHandler = @Sendable () async -> Void

    private let domainID: String
    private let defaults: UserDefaults
    private let fetcher: Fetcher
    private var memoryCache: [LibraryRoot]?
    private var inflight: Task<[LibraryRoot], Error>?
    private var driftHandler: DriftHandler?
    private let log = Logger(subsystem: "app.justmaple.aperture.fileprovider",
                             category: "root-cache")

    public init(domainID: String,
                 defaults: UserDefaults? = nil,
                 fetcher: @escaping Fetcher) {
        self.domainID = domainID
        self.defaults = defaults
            ?? UserDefaults(suiteName: FileProviderConfig.appGroupSuiteName)
            ?? .standard
        self.fetcher = fetcher
    }

    private var diskKey: String { "fileprovider.rootcache.\(domainID)" }

    public func setDriftHandler(_ handler: @escaping DriftHandler) {
        self.driftHandler = handler
    }

    public func roots() async throws -> [LibraryRoot] {
        // Memory cache wins.
        if let mc = memoryCache {
            kickRevalidation()
            return mc
        }
        // Disk cache: return synchronously, kick a background revalidation.
        if let data = defaults.data(forKey: diskKey),
           let decoded = try? JSONDecoder().decode([LibraryRoot].self, from: data) {
            memoryCache = decoded
            kickRevalidation()
            return decoded
        }
        // Cold path: await the fetcher.
        let result = try await runFetcher()
        return result
    }

    public func invalidate() {
        memoryCache = nil
        defaults.removeObject(forKey: diskKey)
    }

    // MARK: - Internals

    private func kickRevalidation() {
        guard inflight == nil else { return }
        let primed = memoryCache
        inflight = Task { [weak self, fetcher] in
            let fresh = try await fetcher()
            await self?.applyRevalidation(fresh: fresh, primed: primed)
            return fresh
        }
    }

    private func applyRevalidation(fresh: [LibraryRoot],
                                    primed: [LibraryRoot]?) {
        defer { inflight = nil }
        memoryCache = fresh
        if let data = try? JSONEncoder().encode(fresh) {
            defaults.set(data, forKey: diskKey)
        }
        let drifted = primed.map { $0 != fresh } ?? true
        if drifted, let handler = driftHandler {
            Task { await handler() }
        }
    }

    private func runFetcher() async throws -> [LibraryRoot] {
        if let t = inflight { return try await t.value }
        let task = Task { [fetcher] in try await fetcher() }
        inflight = task
        let fresh = try await task.value
        applyRevalidation(fresh: fresh, primed: memoryCache)
        return fresh
    }
}
```

- [ ] **Step 4: Delete the inline `LibraryRootCache` from `FileProviderExtension.swift`**

Remove the `actor LibraryRootCache` at the bottom of `FileProviderExtension.swift`. Update the construction:

```swift
self.rootCache = LibraryRootCache(
    domainID: domain.identifier.rawValue,
    fetcher: { [catalog = self.catalog!] in try await catalog.listFolders() }
)
```

(Adjust the capture to whatever shape the existing init uses.)

And wire the drift handler in `init`:

```swift
Task { [weak self] in
    await self?.rootCache?.setDriftHandler { [weak self] in
        guard let self else { return }
        if let mgr = NSFileProviderManager(for: self.domain) {
            try? await mgr.signalEnumerator(for: .rootContainer)
        }
    }
}
```

- [ ] **Step 5: Run tests**

```bash
cd src/apple/Packages/MapleCore && swift test --filter LibraryRootCacheTests
cd src/apple && xcodebuild -project Maple.xcodeproj -scheme Maple -destination 'platform=macOS' -quiet build
```

- [ ] **Step 6: Commit**

```bash
git add src/apple/Packages/MapleCore/Sources/MapleCore/FileProvider/LibraryRootCache.swift \
        src/apple/MapleFileProvider/FileProviderExtension.swift \
        src/apple/Packages/MapleCore/Tests/MapleCoreTests/LibraryRootCacheTests.swift
git commit -m "feat(fileprovider): disk-primed LibraryRootCache with drift-signal handler"
```

---

## Task 7: Allocation audit & post-change measurement (Mode A only)

Skip this task in Mode B.

The spec calls for an `os_signpost`-instrumented run and a fix for anything > 50 ms / > 1 MB. The instrumentation is one or two `OSSignposter` calls bracketing `enumerateItems` and `fetchContents`; the analysis is in Instruments.

- [ ] **Step 1: Add signposts**

Add to `FileProviderExtension.swift`:

```swift
import OSLog

private let signposter = OSSignposter(subsystem: "app.justmaple.aperture.fileprovider",
                                       category: .pointsOfInterest)
```

Bracket `enumerateItems` in each enumerator:

```swift
let state = signposter.beginInterval("enumerateItems")
defer { signposter.endInterval("enumerateItems", state) }
```

Same for `fetchContents`.

- [ ] **Step 2: Profile the cold-open scenario**

Repeat Task 0 Step 2's procedure with the new code in place. Compare deltas:
- Cold first paint root: <ms before> → <ms after>
- Open folder cold: <ms before> → <ms after>

- [ ] **Step 3: Profile the warm Refresh scenario**

Repeat Task 0 Step 3. With ETag in place, the warm Refresh should be:
- No re-decoded JSON bodies.
- All 304 responses (zero body bytes).
- Spinner-to-settled time should drop substantially.

- [ ] **Step 4: Profile spacebar (cold/warm)**

Repeat Task 0 Step 4.

- [ ] **Step 5: Inspect Instruments for any single function > 50 ms or any allocation > 1 MB inside a call path that fires per slider tick / per spacebar / per refresh**

Likely suspects (per the spec):
- `JSONDecoder().decode(...)` on big folder listings — confirm with the time profiler. If it's hot, switch to streaming decode or a hand-rolled mapper.
- `String(data:, encoding:)` on response bodies — confirm with the allocation tracker.
- `MapleItem` instance accumulation across pages — confirm with the allocation tracker.

For each finding > the budget, file a new task in this plan inline (after this task), implement, re-measure. Do NOT batch the changes — measure after each one so you know which intervention paid off.

- [ ] **Step 6: Append measurements to the notes file**

Update `.archived-plans/notes/2026-05-16-fp-phase5c-perf-baseline.md` (uncommitted) with the after-numbers and an "Optimisations taken" section listing each fix and its measured improvement.

- [ ] **Step 7: Commit the signposts and any allocation fixes**

```bash
git add src/apple/MapleFileProvider/*.swift
git commit -m "perf(fileprovider): add os_signposts; [list any concrete fixes here]"
```

If no fixes were warranted (cold path was already within budget, warm-path budget met with ETag alone), commit only the signposts and note in the message: "no per-tick optimisations warranted by profile."

---

## Task 8: Pagination follow-through verification

Phase 4 added server-side pagination of `GET /api/fs/dir`. This task confirms the client correctly follows multi-page cursors AND surfaces partial results to the OS eagerly (i.e., `didEnumerate` fires per page, not just at the end).

**Files:**
- Check / Modify: `src/apple/MapleFileProvider/MapleEnumerator.swift` (`FolderEnumerator.enumerateItems`)

- [ ] **Step 1: Inspect the current `FolderEnumerator.enumerateItems`**

Read `MapleEnumerator.swift`. The current implementation calls `catalog.listDir(absolutePath: ...)` once and calls `observer.didEnumerate(items)` once. If Phase 4's pagination has shipped, `listDir` may now have a `cursor` / `nextPage` parameter — confirm.

If not paginated at this point, this task is a no-op and the work belongs to whatever phase actually delivered pagination. Skip the task with a note in the PR description.

- [ ] **Step 2: If pagination exists, loop**

Pattern (only implement if `listDir` actually returns pages):

```swift
var page: NSFileProviderPage? = nil
repeat {
    let result = try await catalog.listDir(absolutePath: absolutePath,
                                            cursor: page?.cursorFromOSData())
    observer.didEnumerate(result.items)
    page = result.nextCursor.map { NSFileProviderPage(cursor: $0) }
} while page != nil
observer.finishEnumerating(upTo: nil)
```

- [ ] **Step 3: Commit (only if a change was made)**

```bash
git add src/apple/MapleFileProvider/MapleEnumerator.swift
git commit -m "perf(fileprovider): fire didEnumerate per page during folder listing"
```

---

## Self-review

**Spec coverage**

- ETag on `/api/folders`, `/api/fs/dir`, `/api/assets/:id/thumb` — Tasks 2, 3, 4.
- Client tracks ETags + sends `If-None-Match` + reuses on 304 — Task 5.
- Eager root cache (disk-primed `UserDefaults` + background revalidation) — Task 6.
- Per-tick allocation audit — Task 7 (Mode A) explicitly profile-driven, no speculative changes.
- Pagination follow-through verification — Task 8.
- Baseline-then-after measurement — Tasks 0 + 7 (Mode A) with explicit Mode B fallback that doesn't fabricate numbers.

**Placeholders**

None. Every step has actual code or a concrete bash command. Task 7 deliberately doesn't pre-commit to specific optimisations — the spec is explicit that this work is measurement-driven.

**Type consistency**

- `computeBodyETag` / `ifNoneMatchEqual` signatures match between Task 1 (definition) and Tasks 2, 3, 4 (use sites).
- `LibraryRootCache(domainID:defaults:fetcher:)` signature consistent between Task 6 definition and the FP extension wiring step.
- `RemoteCatalog.fetchCachedJSON<T>` is a generic helper; the two call sites (`listFolders`, `listDir`) both use it with the right concrete type.

**Notable risks to flag in review**

- The `getThumb` ETag-cache memory growth: every thumb URL gets a `Data` payload in the cache. A heavy user previewing 1000s of thumbs could push memory significantly. Phase 6 should add a size-bounded LRU; for 5c, the cache simply grows.
- The `LibraryRootCache` test uses `nonisolated(unsafe) var fetchCount` which Swift 6 frowns on. If MapleCore is Swift-6-mode, use `actor` or `OSAllocatedUnfairLock` instead.
- `Task 4 Step 4` (fs-thumbs `If-None-Match`) requires the handler signature to expose `headers` — if it doesn't today, that signature change may invalidate the route's TypeBox schema. Check the current signature first.
- The Elysia `set.status = 304` + `return new Response(null, ...)` pattern is double-setting status. The `Response` form wins; the `set.status` line is belt-and-suspenders. If the runtime warns about a conflict, drop the `set.status` line.
- Task 5's `getThumb` overlaps with plan 5a's Task 3 (which also defines `getThumb`). If 5a has shipped, treat the 5c version as a *modification* (add the ETag caching to the existing method) rather than a fresh add. The diff is small either way.

---

## Done when

- [ ] All new tests pass (`bun test` + `swift test`).
- [ ] `xcodebuild ... build` succeeds.
- [ ] (Mode A) Before/after numbers captured for cold Finder open, warm Refresh, spacebar cold/hot. Numbers in PR description; raw notes uncommitted under `.archived-plans/notes/`.
- [ ] (Mode A) Profile shows no single function > 50 ms / no allocation > 1 MB in per-tick paths, OR each violation has a corresponding commit fixing it with measured improvement.
- [ ] (Mode B) PR description explicitly states `PERF_BASELINES_UNAVAILABLE` and lists which optimisations rely on the design rather than measurement.
