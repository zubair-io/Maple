# File Provider Phase 2 — PR #64 Remediation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]` syntax.

**Goal:** Address the 5 inline review comments on PR #64 so Phase 2 actually round-trips XMP end-to-end. The original plan shipped the enumerate + write paths but left three real holes: no sidecar read path, conflict-copy writes target the canonical file, conflict-copy deletes nuke the canonical, and the regex doesn't recognize the numbered `(N)` collision variants the server itself produces.

**Architecture:** Extend the three XMP endpoints with an optional `?conflict=<basename>` query parameter that addresses a specific conflict-copy file by its basename (no `.xmp` extension). Server validates the basename matches the conflict-suffix regex for the requested asset's RAW filename. When the parameter is present, all three endpoints operate on that exact file unconditionally (no mtime precondition — the user is editing this specific file directly). Client side: `fetchContents` gains a sidecar arm; `modifyItem` and `deleteItem` propagate `conflictBasename` from the parsed identifier to the catalog methods.

**Base SHA:** `c6d6751` (HEAD of `claude/file-provider-phase2` at PR-comment time).

---

## File structure

**Modify (server):**
- `src/api/src/fs/xmp.ts` — add `resolveConflictSidecarPath`, `readConflictSidecarAtomic`, `writeConflictSidecarAtomic`, `deleteConflictSidecar`. Plus a `canonicalBaseFromSidecarFilename` helper that handles the numbered `(N)` variants (move it here from browse.ts since it's the natural home, or update in place).
- `src/api/src/fs/browse.ts` — update `canonicalBaseFromSidecarFilename` regex (or replace with re-export from xmp.ts).
- `src/api/src/routes/assets.ts` — extend GET/PUT/DELETE on `/api/assets/:id/xmp` to honour `?conflict=<basename>`.

**Modify (server tests):**
- `src/api/tests/fs-dir-sidecars.test.ts` — add a case for the numbered variant.
- New: `src/api/tests/assets-xmp-conflict-addressing.test.ts` — GET/PUT/DELETE with `?conflict=` query.

**Modify (client core):**
- `src/apple/Packages/MapleCore/Sources/MapleCore/FileProvider/RemoteCatalog.swift` — add `getXMP(assetID:conflictBasename:)`, add optional `conflictBasename` parameter to `putXMP` (skips precondition when set) and `deleteXMP`.

**Modify (client extension):**
- `src/apple/MapleFileProvider/FileProviderExtension.swift` — add `.sidecar` arm in `fetchContents`; thread `conflictBasename` from parsed identifier through `modifyItem` and `deleteItem`.

**Modify (docs):**
- `docs/superpowers/specs/2026-05-16-file-provider-phase2-design.md` — fix the response example.

---

## Task 1: Server — extend `canonicalBaseFromSidecarFilename` to handle numbered variants

**Files:**
- Modify: `src/api/src/fs/browse.ts`

The current regex `/^(.+?)( \(conflict from [^)]+\))?\.xmp$/i` doesn't match `IMG_1 (conflict from MacBook) (2).xmp` correctly — it returns `IMG_1 (conflict from MacBook) (2)` as the base.

- [ ] **Step 1: Update the regex**

In `src/api/src/fs/browse.ts`, find:

```typescript
export function canonicalBaseFromSidecarFilename(filename: string): string | null {
  const m = /^(.+?)( \(conflict from [^)]+\))?\.xmp$/i.exec(filename);
  return m ? m[1] : null;
}
```

Replace with:

```typescript
/**
 * Match a sidecar filename and return its canonical base (no .xmp).
 *
 * Recognized forms:
 *   IMG_1.xmp                               → IMG_1
 *   IMG_1 (conflict from MacBook).xmp       → IMG_1
 *   IMG_1 (conflict from MacBook) (2).xmp   → IMG_1
 *   notes.txt                               → null
 *
 * The optional ` (N)` numeric suffix is produced by `pickFreeConflictPath`
 * when multiple writers race on the same conflict-copy filename.
 */
export function canonicalBaseFromSidecarFilename(filename: string): string | null {
  const m = /^(.+?)( \(conflict from [^)]+\))?( \(\d+\))?\.xmp$/i.exec(filename);
  return m ? m[1] : null;
}
```

- [ ] **Step 2: Verify with a unit-level sanity check**

There's no standalone test for this helper, but the existing `fs-dir-sidecars.test.ts` exercises it indirectly. Add a numbered-variant case to that test (Step 3 of this task).

- [ ] **Step 3: Extend the existing fs-dir-sidecars test**

In `src/api/tests/fs-dir-sidecars.test.ts`, locate the first test ("pairs canonical + conflict sidecars to the same asset"). After the existing fixture file creation, add a numbered-variant fixture:

Find:

```typescript
    conflictXmpPath = path.join(realTmpRoot, "IMG_1 (conflict from MacBook).xmp");
    orphanXmpPath = path.join(realTmpRoot, "DSCF0001.xmp");
    await fs.writeFile(rawPath, new Uint8Array([0xff, 0xd8, 0xff]));
    await fs.writeFile(canonicalXmpPath, "<x:xmpmeta/>");
    await fs.writeFile(conflictXmpPath, "<x:xmpmeta/>");
    await fs.writeFile(orphanXmpPath, "<x:xmpmeta/>");
```

Replace with:

```typescript
    conflictXmpPath = path.join(realTmpRoot, "IMG_1 (conflict from MacBook).xmp");
    const numberedConflictXmpPath = path.join(realTmpRoot, "IMG_1 (conflict from MacBook) (2).xmp");
    orphanXmpPath = path.join(realTmpRoot, "DSCF0001.xmp");
    await fs.writeFile(rawPath, new Uint8Array([0xff, 0xd8, 0xff]));
    await fs.writeFile(canonicalXmpPath, "<x:xmpmeta/>");
    await fs.writeFile(conflictXmpPath, "<x:xmpmeta/>");
    await fs.writeFile(numberedConflictXmpPath, "<x:xmpmeta/>");
    await fs.writeFile(orphanXmpPath, "<x:xmpmeta/>");
```

Update the assertion in the first test to expect three sidecars (in sorted name order):

```typescript
    const names = body.sidecars.map((s) => s.name).sort();
    expect(names).toEqual([
      "IMG_1 (conflict from MacBook) (2).xmp",
      "IMG_1 (conflict from MacBook).xmp",
      "IMG_1.xmp",
    ]);
```

- [ ] **Step 4: Run the test**

```bash
cd /Users/riabuz/Projects/_Maple/src/api && bun test tests/fs-dir-sidecars.test.ts 2>&1 | tail -10
```

Expected: 2 pass.

- [ ] **Step 5: Commit**

```bash
cd /Users/riabuz/Projects/_Maple
git add src/api/src/fs/browse.ts src/api/tests/fs-dir-sidecars.test.ts
git commit -m "fix(api): canonicalBaseFromSidecarFilename handles numbered conflict variants

Per PR #64 review on browse.ts:204. pickFreeConflictPath generates
names like 'IMG (conflict from MacBook) (2).xmp' on collision; the
prior regex returned the whole base+suffix instead of the canonical
base, so the numbered variants never paired to their asset and never
enumerated through /api/fs/dir."
```

---

## Task 2: Server — conflict-addressed read/write/delete helpers

**Files:**
- Modify: `src/api/src/fs/xmp.ts`

The route handlers need three new helpers that operate on a specific conflict-copy file by its basename: read, atomic write (no precondition), and idempotent delete. All three resolve the basename to an absolute path via a shared validator that prevents path traversal.

- [ ] **Step 1: Add the path resolver**

Append to `src/api/src/fs/xmp.ts`:

```typescript
/**
 * Resolve a conflict-copy sidecar's absolute path for a given asset.
 *
 * Validates that `conflictBasename` (without `.xmp` extension) matches the
 * conflict-suffix pattern for the asset's RAW filename, with optional
 * numbered variant. This prevents path-traversal: a malicious or buggy
 * caller can't address arbitrary sidecars on disk.
 *
 *   rawAbsPath = "/photos/IMG_1.ARW"
 *   conflictBasename = "IMG_1 (conflict from MacBook)"
 *   → "/photos/IMG_1 (conflict from MacBook).xmp"
 *
 *   rawAbsPath = "/photos/IMG_1.ARW"
 *   conflictBasename = "IMG_1 (conflict from MacBook) (2)"
 *   → "/photos/IMG_1 (conflict from MacBook) (2).xmp"
 *
 *   rawAbsPath = "/photos/IMG_1.ARW"
 *   conflictBasename = "../etc/passwd"
 *   → null
 *
 *   rawAbsPath = "/photos/IMG_1.ARW"
 *   conflictBasename = "IMG_2 (conflict from MacBook)"   // different RAW
 *   → null
 */
export function resolveConflictSidecarPath(
  rawAbsPath: string,
  conflictBasename: string,
): string | null {
  if (conflictBasename.includes("/") || conflictBasename.includes("\\")) return null;
  if (conflictBasename.includes("..")) return null;

  const ext = path.extname(rawAbsPath);
  const rawBase = path.basename(rawAbsPath, ext); // e.g. "IMG_1"

  // The basename must start with the RAW's base and end with the
  // conflict-suffix (optionally followed by a numbered variant).
  const pattern = new RegExp(
    `^${escapeRegex(rawBase)} \\(conflict from [^)]+\\)( \\(\\d+\\))?$`,
  );
  if (!pattern.test(conflictBasename)) return null;

  return path.join(path.dirname(rawAbsPath), `${conflictBasename}.xmp`);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
```

- [ ] **Step 2: Add the read helper**

Append:

```typescript
/**
 * Read a specific conflict-copy sidecar. Returns ok:false if the basename
 * doesn't validate or the file doesn't exist.
 */
export async function readConflictSidecar(
  rawAbsPath: string,
  conflictBasename: string,
): Promise<OpResult<string>> {
  const sidecar = resolveConflictSidecarPath(rawAbsPath, conflictBasename);
  if (!sidecar) return { ok: false, error: "Invalid conflict basename" };
  try {
    const content = await fs.readFile(sidecar, "utf-8");
    return { ok: true, data: content };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `No conflict sidecar at "${sidecar}": ${msg}` };
  }
}
```

- [ ] **Step 3: Add the atomic write helper**

Append:

```typescript
/**
 * Atomically overwrite a specific conflict-copy sidecar. No precondition —
 * the user is editing this exact file directly. Returns the new mtime.
 */
export async function writeConflictSidecarAtomic(
  rawAbsPath: string,
  conflictBasename: string,
  xmlContent: string,
): Promise<{ ok: true; mtime: Date } | { ok: false; error: string }> {
  const sidecar = resolveConflictSidecarPath(rawAbsPath, conflictBasename);
  if (!sidecar) return { ok: false, error: "Invalid conflict basename" };

  const allowed = await safeWriteAllowed(sidecar);
  if (!allowed.ok) return { ok: false, error: allowed.error ?? "Path not allowed" };

  const tmp = sidecar + ".tmp." + process.pid;
  try {
    await fs.mkdir(path.dirname(sidecar), { recursive: true });
    const fh = await fs.open(tmp, "w");
    try {
      await fh.writeFile(xmlContent, "utf-8");
      await fh.datasync();
    } finally {
      await fh.close();
    }
    await fs.rename(tmp, sidecar);
    const st = await fs.stat(sidecar);
    return { ok: true, mtime: st.mtime };
  } catch (err) {
    try { await fs.unlink(tmp); } catch {}
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Conflict sidecar write failed: ${msg}` };
  }
}
```

- [ ] **Step 4: Add the delete helper**

Append:

```typescript
/**
 * Delete a specific conflict-copy sidecar. Idempotent — succeeds whether
 * or not the file existed. Returns error only if the basename doesn't
 * validate.
 */
export async function deleteConflictSidecar(
  rawAbsPath: string,
  conflictBasename: string,
): Promise<OpResult> {
  const sidecar = resolveConflictSidecarPath(rawAbsPath, conflictBasename);
  if (!sidecar) return { ok: false, error: "Invalid conflict basename" };
  const allowed = await safeWriteAllowed(sidecar);
  if (!allowed.ok) return { ok: false, error: allowed.error ?? "Path not allowed" };
  try {
    await fs.unlink(sidecar);
    return { ok: true };
  } catch (err: unknown) {
    if (err && typeof err === "object" && "code" in err && (err as { code: string }).code === "ENOENT") {
      return { ok: true };
    }
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Conflict sidecar delete failed: ${msg}` };
  }
}
```

- [ ] **Step 5: Type-check**

```bash
cd /Users/riabuz/Projects/_Maple/src/api && bun run --bun tsc --noEmit 2>&1 | grep "xmp.ts" | head -5
```

Expected: no new errors.

- [ ] **Step 6: Commit**

```bash
cd /Users/riabuz/Projects/_Maple
git add src/api/src/fs/xmp.ts
git commit -m "feat(api): conflict-addressed sidecar read/write/delete helpers

Per PR #64 review. Adds resolveConflictSidecarPath (with traversal
guard) + read/write/delete helpers that operate on a specific
conflict-copy file by basename. The write helper has no precondition
because the caller is editing this exact file directly, not racing
against an unknown server-side state."
```

---

## Task 3: Server — routes honour `?conflict=` query parameter

**Files:**
- Modify: `src/api/src/routes/assets.ts`

Extend the three XMP routes (GET, PUT, DELETE) to honour an optional `?conflict=<basename>` query parameter that routes to the conflict-copy helpers from Task 2.

- [ ] **Step 1: Update imports**

In `src/api/src/routes/assets.ts`, find:

```typescript
import { readXmp, writeXmpAtomic, writeXmpWithPrecondition, deleteXmpSidecar, resolveThumbPath } from "../fs/xmp.ts";
```

Replace with:

```typescript
import {
  readXmp,
  writeXmpAtomic,
  writeXmpWithPrecondition,
  deleteXmpSidecar,
  readConflictSidecar,
  writeConflictSidecarAtomic,
  deleteConflictSidecar,
  resolveThumbPath,
} from "../fs/xmp.ts";
```

- [ ] **Step 2: Extend the GET handler**

Locate `.get("/:id/xmp", ...)`. Replace the handler body so it reads the optional `conflict` query parameter:

Current body:

```typescript
  .get("/:id/xmp", async ({ params, set }) => {
    let id: ObjectId;
    try {
      id = new ObjectId(params.id);
    } catch {
      set.status = 400;
      return { error: "Invalid asset id" };
    }

    const coll = await assetsCollection();
    const doc = await coll.findOne({ _id: id });
    if (!doc) {
      set.status = 404;
      return { error: "Asset not found" };
    }

    const result = await readXmp(doc.abs_path);
    if (!result.ok) {
      // No sidecar yet — return empty XMP
      set.headers["Content-Type"] = "application/xml";
      return emptyXmp(doc.filename);
    }

    set.headers["Content-Type"] = "application/xml";
    return result.data;
  })
```

Replace with:

```typescript
  .get("/:id/xmp", async ({ params, query, set }) => {
    let id: ObjectId;
    try {
      id = new ObjectId(params.id);
    } catch {
      set.status = 400;
      return { error: "Invalid asset id" };
    }

    const coll = await assetsCollection();
    const doc = await coll.findOne({ _id: id });
    if (!doc) {
      set.status = 404;
      return { error: "Asset not found" };
    }

    const conflict = typeof query.conflict === "string" ? query.conflict : null;
    if (conflict !== null) {
      const result = await readConflictSidecar(doc.abs_path, conflict);
      if (!result.ok) {
        set.status = 404;
        return { error: result.error };
      }
      set.headers["Content-Type"] = "application/xml";
      return result.data;
    }

    const result = await readXmp(doc.abs_path);
    if (!result.ok) {
      // No sidecar yet — return empty XMP
      set.headers["Content-Type"] = "application/xml";
      return emptyXmp(doc.filename);
    }

    set.headers["Content-Type"] = "application/xml";
    return result.data;
  })
```

- [ ] **Step 3: Extend the PUT handler**

Locate `.put("/:id/xmp", ...)`. The handler currently reads `headers` for precondition. Update the destructuring and add a `conflict` query branch BEFORE the precondition logic:

Find:

```typescript
  .put(
    "/:id/xmp",
    async ({ params, body, headers, set }) => {
```

Replace with:

```typescript
  .put(
    "/:id/xmp",
    async ({ params, body, headers, query, set }) => {
```

Then find the section right after the `doc` is loaded and `xmlContent` is decoded:

```typescript
      const xmlContent =
        typeof body === "string"
          ? body
          : (body as unknown) instanceof Uint8Array
            ? new TextDecoder().decode(body as unknown as Uint8Array)
            : String(body);

      const ifMtimeHeader = headers["x-if-mtime-matches"];
```

Insert between `xmlContent` and `const ifMtimeHeader`:

```typescript
      const conflict = typeof query.conflict === "string" ? query.conflict : null;
      if (conflict !== null) {
        const outcome = await writeConflictSidecarAtomic(doc.abs_path, conflict, xmlContent);
        if (!outcome.ok) {
          set.status = 400;
          return { error: outcome.error };
        }
        set.headers["Last-Modified"] = outcome.mtime.toUTCString();
        set.status = 204;
        return;
      }

```

(Note the trailing blank line — leave the existing `const ifMtimeHeader = headers["x-if-mtime-matches"];` line as-is below this insert.)

- [ ] **Step 4: Extend the DELETE handler**

Locate `.delete("/:id/xmp", ...)`. Replace the handler with:

```typescript
  .delete("/:id/xmp", async ({ params, query, set }) => {
    let id: ObjectId;
    try {
      id = new ObjectId(params.id);
    } catch {
      set.status = 400;
      return { error: "Invalid asset id" };
    }
    const coll = await assetsCollection();
    const doc = await coll.findOne({ _id: id });
    if (!doc) {
      set.status = 404;
      return { error: "Asset not found" };
    }
    const conflict = typeof query.conflict === "string" ? query.conflict : null;
    const result = conflict !== null
      ? await deleteConflictSidecar(doc.abs_path, conflict)
      : await deleteXmpSidecar(doc.abs_path);
    if (!result.ok) {
      set.status = 400;
      return { error: result.error };
    }
    set.status = 204;
    return;
  })
```

- [ ] **Step 5: Type-check**

```bash
cd /Users/riabuz/Projects/_Maple/src/api && bun run --bun tsc --noEmit 2>&1 | grep "assets.ts" | head -5
```

Expected: no new errors.

- [ ] **Step 6: Commit**

```bash
cd /Users/riabuz/Projects/_Maple
git add src/api/src/routes/assets.ts
git commit -m "feat(api): XMP routes honour optional ?conflict=<basename> query param

Per PR #64 review. GET/PUT/DELETE on /api/assets/:id/xmp now route to
the conflict-copy helpers when ?conflict=<basename> is set. PUT in
this mode is unconditional (no precondition needed; caller is editing
this exact file)."
```

---

## Task 4: Server — tests for conflict-addressed routes

**Files:**
- Create: `src/api/tests/assets-xmp-conflict-addressing.test.ts`

- [ ] **Step 1: Write the test file**

Create `src/api/tests/assets-xmp-conflict-addressing.test.ts`. Use the same Mongo + tmpdir pattern as `assets-xmp-conflict.test.ts`:

```typescript
/**
 * GET / PUT / DELETE /api/assets/:id/xmp?conflict=<basename>
 *
 * Verifies the conflict-addressing query parameter:
 *   - GET reads the specific conflict file (404 if absent or invalid)
 *   - PUT unconditionally overwrites the named conflict file, no precondition
 *   - DELETE removes the named conflict file (idempotent; 204 if absent)
 *   - Invalid basenames (traversal, wrong asset, malformed suffix) return 400
 *
 * Real Mongo; skip-passes if MongoDB is unreachable.
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
} from "bun:test";
import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs/promises";
import { MongoClient, ObjectId, type Db } from "mongodb";
import { pendingEnrichment } from "../src/db/schema.ts";

const TEST_DB = `maple_test_fp2_conflict_addr_${process.pid}`;
const PRIOR_MONGO_DB = process.env.MAPLE_MONGO_DB;
const MONGO_URI = process.env.MAPLE_MONGO_URI ?? "mongodb://localhost:27017";

let mongo: MongoClient | null = null;
let mongoReachable = false;
let db: Db | null = null;
let tmpRoot: string;
let realTmpRoot: string;
let rawPath: string;
let conflictXmpPath: string;
let assetId: ObjectId;

async function tryConnect(): Promise<MongoClient | null> {
  const c = new MongoClient(MONGO_URI, {
    serverSelectionTimeoutMS: 1500,
    connectTimeoutMS: 1500,
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

async function call(method: "GET" | "PUT" | "DELETE", query: string, body?: string): Promise<Response> {
  const { assetsRoutes } = await import("../src/routes/assets.ts");
  const url = `http://test/api/assets/${assetId.toHexString()}/xmp${query}`;
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.headers = { "content-type": "text/plain" };
    init.body = body;
  }
  return assetsRoutes.handle(new Request(url, init));
}

describe("XMP routes — ?conflict=<basename> addressing", () => {
  beforeAll(async () => {
    const { closeDb } = await import("../src/db/client.ts");
    await closeDb();
    process.env.MAPLE_MONGO_DB = TEST_DB;
    mongo = await tryConnect();
    mongoReachable = mongo !== null;
    if (!mongoReachable) return;

    db = mongo!.db(TEST_DB);
    await db.dropDatabase();

    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "maple-fp2-confaddr-"));
    realTmpRoot = await fs.realpath(tmpRoot);
    process.env.MAPLE_ROOTS = realTmpRoot;

    rawPath = path.join(realTmpRoot, "IMG_1.ARW");
    conflictXmpPath = path.join(realTmpRoot, "IMG_1 (conflict from MacBook).xmp");
    await fs.writeFile(rawPath, new Uint8Array([0xff, 0xd8, 0xff]));
    await fs.writeFile(conflictXmpPath, "<x:xmpmeta>conflict-v1</x:xmpmeta>");

    const now = new Date().toISOString();
    assetId = new ObjectId();
    await db.collection("assets").insertOne({
      _id: assetId,
      folder_id: new ObjectId(),
      filename: "IMG_1.ARW",
      abs_path: rawPath,
      size: 3,
      mtime: now,
      indexed_at: now,
      enrichment: pendingEnrichment(),
    } as never);
  });

  afterAll(async () => {
    const { closeDb } = await import("../src/db/client.ts");
    await closeDb();
    if (mongo) {
      try { await db?.dropDatabase(); } catch {}
      await mongo.close();
    }
    try { await fs.rm(tmpRoot, { recursive: true, force: true }); } catch {}
    if (PRIOR_MONGO_DB === undefined) delete process.env.MAPLE_MONGO_DB;
    else process.env.MAPLE_MONGO_DB = PRIOR_MONGO_DB;
  });

  it("GET ?conflict=<basename> reads the specific conflict file", async () => {
    if (!mongoReachable) return;
    const res = await call("GET", "?conflict=" + encodeURIComponent("IMG_1 (conflict from MacBook)"));
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("conflict-v1");
  });

  it("PUT ?conflict=<basename> overwrites unconditionally, no precondition needed", async () => {
    if (!mongoReachable) return;
    const res = await call(
      "PUT",
      "?conflict=" + encodeURIComponent("IMG_1 (conflict from MacBook)"),
      "<x:xmpmeta>conflict-v2</x:xmpmeta>",
    );
    expect(res.status).toBe(204);
    expect(res.headers.get("last-modified")).toBeTruthy();
    const onDisk = await fs.readFile(conflictXmpPath, "utf8");
    expect(onDisk).toContain("conflict-v2");
  });

  it("DELETE ?conflict=<basename> removes the specific conflict file", async () => {
    if (!mongoReachable) return;
    const res = await call("DELETE", "?conflict=" + encodeURIComponent("IMG_1 (conflict from MacBook)"));
    expect(res.status).toBe(204);
    await expect(fs.access(conflictXmpPath)).rejects.toThrow();
    await fs.access(rawPath); // RAW must still exist.
  });

  it("DELETE ?conflict=<basename> is idempotent (returns 204 when absent)", async () => {
    if (!mongoReachable) return;
    // Already deleted above.
    const res = await call("DELETE", "?conflict=" + encodeURIComponent("IMG_1 (conflict from MacBook)"));
    expect(res.status).toBe(204);
  });

  it("rejects path-traversal in the conflict basename", async () => {
    if (!mongoReachable) return;
    const res = await call("GET", "?conflict=" + encodeURIComponent("../etc/passwd"));
    expect(res.status).toBe(404);
  });

  it("rejects wrong-asset basenames", async () => {
    if (!mongoReachable) return;
    // Basename matches the conflict-suffix pattern but for a DIFFERENT raw.
    const res = await call("GET", "?conflict=" + encodeURIComponent("IMG_2 (conflict from MacBook)"));
    expect(res.status).toBe(404);
  });

  it("PUT ?conflict=<numbered-variant> works for pickFreeConflictPath output", async () => {
    if (!mongoReachable) return;
    // Numbered variant from pickFreeConflictPath collision handling.
    const res = await call(
      "PUT",
      "?conflict=" + encodeURIComponent("IMG_1 (conflict from MacBook) (2)"),
      "<x:xmpmeta>numbered</x:xmpmeta>",
    );
    expect(res.status).toBe(204);
    const expected = path.join(realTmpRoot, "IMG_1 (conflict from MacBook) (2).xmp");
    const onDisk = await fs.readFile(expected, "utf8");
    expect(onDisk).toContain("numbered");
  });
});
```

- [ ] **Step 2: Run the test**

```bash
cd /Users/riabuz/Projects/_Maple/src/api && bun test tests/assets-xmp-conflict-addressing.test.ts 2>&1 | tail -10
```

Expected: 7 pass (or 7 skip-pass if no Mongo).

- [ ] **Step 3: Commit**

```bash
cd /Users/riabuz/Projects/_Maple
git add src/api/tests/assets-xmp-conflict-addressing.test.ts
git commit -m "test(api): XMP routes ?conflict=<basename> addressing"
```

---

## Task 5: Client (MapleCore) — RemoteCatalog conflict-aware methods

**Files:**
- Modify: `src/apple/Packages/MapleCore/Sources/MapleCore/FileProvider/RemoteCatalog.swift`

- [ ] **Step 1: Add `getXMP` method to the RemoteCatalog actor**

Locate the `public actor RemoteCatalog` body. Find `putXMP` and insert `getXMP` immediately before it:

```swift
    /// GET /api/assets/<assetID>/xmp[?conflict=<basename>]. Returns the
    /// raw XMP bytes. For conflict copies, `conflictBasename` must match
    /// the server's pairing rule (canonical base + " (conflict from …)"
    /// suffix, optionally with " (N)").
    public func getXMP(assetID: String, conflictBasename: String?) async throws -> Data {
        var comps = URLComponents(
            url: server.appending(path: "/api/assets/\(assetID)/xmp"),
            resolvingAgainstBaseURL: false,
        )!
        if let conflictBasename {
            comps.queryItems = [.init(name: "conflict", value: conflictBasename)]
        }
        let req = URLRequest(url: comps.url!)
        let (data, resp) = try await http.data(for: req)
        try Self.check2xx(resp)
        return data
    }
```

- [ ] **Step 2: Extend `putXMP` to accept an optional `conflictBasename`**

Find the existing `putXMP` signature:

```swift
    public func putXMP(
        assetID: String,
        data: Data,
        ifMtimeMatches: Date?,
        deviceName: String
    ) async throws -> XMPWriteResult {
```

Replace the entire method (signature + body) with:

```swift
    /// PUT /api/assets/<assetID>/xmp.
    ///
    /// - `conflictBasename`: when non-nil, addresses a specific conflict
    ///   copy via `?conflict=<basename>`. Unconditional write — the
    ///   `ifMtimeMatches` precondition is ignored in this mode because
    ///   the caller is editing this exact file directly.
    /// - `ifMtimeMatches`: only used when `conflictBasename == nil`.
    ///   nil = unconditional create; otherwise precondition.
    /// - `deviceName`: stamped into conflict-copy filenames the server
    ///   may create on precondition mismatch (canonical-write mode only).
    public func putXMP(
        assetID: String,
        data: Data,
        ifMtimeMatches: Date?,
        deviceName: String,
        conflictBasename: String? = nil
    ) async throws -> XMPWriteResult {
        var comps = URLComponents(
            url: server.appending(path: "/api/assets/\(assetID)/xmp"),
            resolvingAgainstBaseURL: false,
        )!
        if let conflictBasename {
            comps.queryItems = [.init(name: "conflict", value: conflictBasename)]
        }
        var req = URLRequest(url: comps.url!)
        req.httpMethod = "PUT"
        req.setValue("text/plain; charset=utf-8", forHTTPHeaderField: "Content-Type")
        req.setValue(deviceName, forHTTPHeaderField: "X-Maple-Device-Name")
        // Precondition only applies to the canonical write path.
        if conflictBasename == nil, let prior = ifMtimeMatches {
            req.setValue(String(Int(prior.timeIntervalSince1970)), forHTTPHeaderField: "X-If-Mtime-Matches")
        }
        req.httpBody = data
        let (respData, resp) = try await http.data(for: req)
        let status = (resp as? HTTPURLResponse)?.statusCode ?? -1
        if status == 204 {
            let mtime = Self.parseLastModified(resp as? HTTPURLResponse) ?? Date()
            return .ok(mtime: mtime)
        }
        if status == 409 {
            struct Body: Decodable { let conflict_path: String; let conflict_mtime: String }
            let body = try decoder.decode(Body.self, from: respData)
            let iso = ISO8601DateFormatter()
            iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            let mtime = iso.date(from: body.conflict_mtime)
                ?? ISO8601DateFormatter().date(from: body.conflict_mtime)
                ?? Date()
            return .conflict(path: body.conflict_path, mtime: mtime)
        }
        throw URLError(.badServerResponse)
    }
```

- [ ] **Step 3: Extend `deleteXMP` to accept an optional `conflictBasename`**

Find the existing `deleteXMP`:

```swift
    /// DELETE /api/assets/<assetID>/xmp. Idempotent.
    public func deleteXMP(assetID: String) async throws {
        var req = URLRequest(url: server.appending(path: "/api/assets/\(assetID)/xmp"))
        req.httpMethod = "DELETE"
        let (_, resp) = try await http.data(for: req)
        try Self.check2xx(resp)
    }
```

Replace with:

```swift
    /// DELETE /api/assets/<assetID>/xmp[?conflict=<basename>]. Idempotent.
    public func deleteXMP(assetID: String, conflictBasename: String? = nil) async throws {
        var comps = URLComponents(
            url: server.appending(path: "/api/assets/\(assetID)/xmp"),
            resolvingAgainstBaseURL: false,
        )!
        if let conflictBasename {
            comps.queryItems = [.init(name: "conflict", value: conflictBasename)]
        }
        var req = URLRequest(url: comps.url!)
        req.httpMethod = "DELETE"
        let (_, resp) = try await http.data(for: req)
        try Self.check2xx(resp)
    }
```

- [ ] **Step 4: Build the package**

```bash
cd /Users/riabuz/Projects/_Maple/src/apple/Packages/MapleCore && swift build 2>&1 | tail -3
```

Expected: `Build complete!`.

- [ ] **Step 5: Run tests to confirm no regressions**

```bash
cd /Users/riabuz/Projects/_Maple/src/apple/Packages/MapleCore && swift test --filter FileProvider 2>&1 | grep -E "Executed.*tests" | tail -3
```

Expected: 11 pass (existing tests still work — default arg keeps backward compat).

- [ ] **Step 6: Commit**

```bash
cd /Users/riabuz/Projects/_Maple
git add src/apple/Packages/MapleCore/Sources/MapleCore/FileProvider/RemoteCatalog.swift
git commit -m "feat(core): RemoteCatalog getXMP + conflictBasename on put/delete

Per PR #64 review. getXMP is new (needed by fetchContents in the
extension). putXMP/deleteXMP gain an optional conflictBasename
parameter that routes to ?conflict=<basename> on the server.
Defaulted nil to preserve existing call sites."
```

---

## Task 6: Client (extension) — fetchContents sidecar arm + thread conflictBasename

**Files:**
- Modify: `src/apple/MapleFileProvider/FileProviderExtension.swift`

This task does three things:
1. Add a `.sidecar` arm in `fetchContents` so external editors can read the bytes.
2. Update `modifyItem` to extract `conflictBasename` from the parsed identifier and pass it to `putXMP`. Conflict items skip the precondition.
3. Update `deleteItem` similarly.

- [ ] **Step 1: Add the sidecar fetch path**

Open `src/apple/MapleFileProvider/FileProviderExtension.swift`. Find `func fetchContents`. Locate the existing identifier-parsing block:

```swift
                let parsed = try FileProviderIdentifier(rawValue: itemIdentifier.rawValue)
                guard case .asset(let id) = parsed else {
                    completionHandler(nil, nil, NSError(domain: NSFileProviderErrorDomain,
                                                        code: NSFileProviderError.noSuchItem.rawValue))
                    return
                }
```

Replace with:

```swift
                let parsed = try FileProviderIdentifier(rawValue: itemIdentifier.rawValue)
                let manager = NSFileProviderManager(for: domain)
                let tmpDir = (try? manager?.temporaryDirectoryURL()) ?? FileManager.default.temporaryDirectory
                let localURL = tmpDir.appendingPathComponent(UUID().uuidString)

                switch parsed {
                case .asset(let id):
                    try await catalog.downloadAsset(assetID: id, to: localURL)
                    completionHandler(localURL, nil, nil)
                    return
                case .sidecar(let assetID, let conflictBasename):
                    let bytes = try await catalog.getXMP(assetID: assetID, conflictBasename: conflictBasename)
                    try bytes.write(to: localURL, options: .atomic)
                    completionHandler(localURL, nil, nil)
                    return
                case .folder:
                    completionHandler(nil, nil, NSError(domain: NSFileProviderErrorDomain,
                                                        code: NSFileProviderError.noSuchItem.rawValue))
                    return
                }
```

Then DELETE the now-duplicated downloadAsset block that follows (the existing code after the `guard case .asset` that did `try await catalog.downloadAsset(...)` and `completionHandler(localURL, nil, nil)`). Make sure no stray code is left between the switch and the closing `} catch`.

- [ ] **Step 2: Update `modifyItem` to thread conflictBasename**

Find the `modifyItem` guard:

```swift
        guard case .sidecar(let assetID, _) = parsed,
              let contentsURL = newContents else {
```

Replace with:

```swift
        guard case .sidecar(let assetID, let conflictBasename) = parsed,
              let contentsURL = newContents else {
```

Then find the `putXMP` call inside the Task:

```swift
                let result = try await catalog.putXMP(
                    assetID: assetID,
                    data: xmpBytes,
                    ifMtimeMatches: priorMtime,
                    deviceName: self.deviceName
                )
```

Replace with:

```swift
                // Conflict copies are addressed by ?conflict=<basename> and
                // skip the mtime precondition: the user is editing this
                // exact file directly, not racing against the canonical.
                let result = try await catalog.putXMP(
                    assetID: assetID,
                    data: xmpBytes,
                    ifMtimeMatches: conflictBasename == nil ? priorMtime : nil,
                    deviceName: self.deviceName,
                    conflictBasename: conflictBasename
                )
```

- [ ] **Step 3: Update `deleteItem` to thread conflictBasename**

Find the `deleteItem` guard:

```swift
        guard case .sidecar(let assetID, _) = parsed else {
            completionHandler(NSError(domain: NSCocoaErrorDomain, code: NSFeatureUnsupportedError))
            return Progress()
        }
```

Replace with:

```swift
        guard case .sidecar(let assetID, let conflictBasename) = parsed else {
            completionHandler(NSError(domain: NSCocoaErrorDomain, code: NSFeatureUnsupportedError))
            return Progress()
        }
```

Then find the `deleteXMP` call inside the Task:

```swift
                try await catalog.deleteXMP(assetID: assetID)
```

Replace with:

```swift
                try await catalog.deleteXMP(assetID: assetID, conflictBasename: conflictBasename)
```

- [ ] **Step 4: Build**

```bash
cd /Users/riabuz/Projects/_Maple/src/apple && xcodebuild -project Maple.xcodeproj -scheme Maple -destination 'platform=macOS,arch=arm64' build 2>&1 | grep -E "^\*\*|error:" | tail -5
```

Expected: `** BUILD SUCCEEDED **`.

- [ ] **Step 5: Run client tests to confirm no regressions**

```bash
cd /Users/riabuz/Projects/_Maple/src/apple/Packages/MapleCore && swift test --filter FileProvider 2>&1 | grep -E "Executed.*tests" | tail -3
```

Expected: 11 pass.

- [ ] **Step 6: Commit**

```bash
cd /Users/riabuz/Projects/_Maple
git add src/apple/MapleFileProvider/FileProviderExtension.swift
git commit -m "fix(fileprovider): fetchContents reads sidecars; modifyItem/deleteItem honour conflict basename

Per PR #64 review:
- fetchContents now has a .sidecar arm calling catalog.getXMP. External
  editors can actually read XMPs through the Finder mount. Without
  this, advertising .allowsReading on sidecar items was a lie.
- modifyItem and deleteItem now extract the conflictBasename from the
  parsed identifier and pass it through to the catalog methods. Conflict
  items now operate on their own file, not the canonical sidecar.
- modifyItem skips the mtime precondition when conflictBasename is set:
  the caller is editing this exact file directly, no race-detection
  semantics apply."
```

---

## Task 7: Docs — fix the spec example field name

**Files:**
- Modify: `docs/superpowers/specs/2026-05-16-file-provider-phase2-design.md`

- [ ] **Step 1: Update the field name in the response example**

Find the section that shows the `/api/fs/dir` response example. Locate:

```json
    { "name": "IMG_1.xmp", "path": "/photos/2024/IMG_1.xmp",
      "mtime": "2026-05-15T10:00:00Z", "size": 18432, "assetID": "650a..." }
```

Replace with:

```json
    { "name": "IMG_1.xmp", "path": "/photos/2024/IMG_1.xmp",
      "mtime": "2026-05-15T10:00:00Z", "size": 18432, "asset_id": "650a..." }
```

- [ ] **Step 2: Commit**

```bash
cd /Users/riabuz/Projects/_Maple
git add docs/superpowers/specs/2026-05-16-file-provider-phase2-design.md
git commit -m "docs: spec example uses asset_id matching the implementation"
```

---

## Self-review

- ✅ **Comment coverage:**
  - `MapleItem.swift:95` (sidecars not readable) → Task 6 Step 1 (fetchContents sidecar arm)
  - `FileProviderExtension.swift:335` (modifyItem wrong file) → Task 6 Step 2
  - `FileProviderExtension.swift:426` (deleteItem wrong file) → Task 6 Step 3
  - `browse.ts:204` (numbered variants drop) → Task 1
  - `spec.md:54` (doc drift) → Task 7
  - Required server endpoints to support sidecar fetch + conflict-addressed mutate → Tasks 2, 3, 4
  - Required client catalog methods → Task 5

- ✅ **Placeholder scan:** no TBD/TODO/incomplete sections.

- ✅ **Type consistency:**
  - `resolveConflictSidecarPath` / `readConflictSidecar` / `writeConflictSidecarAtomic` / `deleteConflictSidecar` (Task 2) are consumed by Task 3 with identical signatures.
  - `catalog.getXMP(assetID:, conflictBasename:)` (Task 5) is called from Task 6 with the right shape.
  - `catalog.putXMP(... conflictBasename:)` and `catalog.deleteXMP(... conflictBasename:)` (Task 5) match the call sites in Task 6.

- ✅ **Phase boundary:** still just XMP via FP. No iOS, no working set, no rename/move.
