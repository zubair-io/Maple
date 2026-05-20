# Maple File Provider — Phase 2 (XMP writes) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement XMP create / modify / delete via the macOS File Provider extension shipped in Phase 1, plus the server-side enumeration + write API extensions that make conflict copies possible.

**Architecture:** Three subsystems change. The Bun/Elysia API extends `/api/fs/dir` to surface `sidecars[]` alongside `images[]`; the XMP PUT route gains an mtime precondition that produces conflict copies on mismatch; a new DELETE endpoint mirrors the PUT. The Swift extension adds a `sidecar/<asset-id>` identifier case, a writable `MapleItem` initializer, and real `createItem` / `modifyItem` / `deleteItem` implementations that route through the catalog client.

**Tech Stack:** Bun + Elysia + MongoDB (server, existing); Swift FileProvider + MapleCore (client, existing). No new dependencies.

**Spec:** `.archived-plans/specs/2026-05-16-file-provider-phase2-design.md`

---

## File structure

**Modify (server):**
- `src/api/src/fs/xmp.ts` — add `writeXmpWithPrecondition` (conflict-copy aware) and `deleteXmpSidecar`. Keep existing `writeXmpAtomic` for non-FP callers (Maple editor, backup ingest).
- `src/api/src/fs/browse.ts` — extend `DirContents` with `sidecars: SidecarChild[]`; walk XMP files in `listDirContents` and pair against indexed assets via filename-base + optional conflict-suffix.
- `src/api/src/routes/assets.ts` — PUT route honours `X-If-Mtime-Matches` and `X-Maple-Device-Name`, sets `Last-Modified` on success, returns 409 + JSON on conflict; new DELETE handler.

**New (server tests):**
- `src/api/tests/assets-xmp-conflict.test.ts`
- `src/api/tests/assets-xmp-delete.test.ts`
- `src/api/tests/fs-dir-sidecars.test.ts`

**Modify (client):**
- `src/apple/Packages/MapleCore/Sources/MapleCore/FileProvider/FileProviderIdentifier.swift` — add `case sidecar(assetID:, conflictBasename:)` (nil basename = canonical).
- `src/apple/Packages/MapleCore/Sources/MapleCore/FileProvider/RemoteCatalog.swift` — add `SidecarChild` DTO; extend `DirContents` to include sidecars; add `putXMP` and `deleteXMP` methods; introduce `XMPWriteResult` enum.
- `src/apple/MapleFileProvider/MapleItem.swift` — add `init(sidecar:parentIdentifier:)` with writable capabilities.
- `src/apple/MapleFileProvider/MapleEnumerator.swift` — `FolderEnumerator` emits sidecar items alongside images.
- `src/apple/MapleFileProvider/FileProviderExtension.swift` — implement `createItem`, `modifyItem`, `deleteItem` for sidecar identifiers; non-sidecars still return `NSFeatureUnsupportedError`.

**Modify (client tests):**
- `src/apple/Packages/MapleCore/Tests/MapleCoreTests/FileProviderIdentifierTests.swift` — add round-trip tests for canonical + conflict-copy sidecars.
- `src/apple/Packages/MapleCore/Tests/MapleCoreTests/RemoteCatalogTests.swift` — add DTO decode tests for the new `sidecars` field.

---

## Identifier scheme reminder

| Conceptual item | Encoded form |
|---|---|
| Canonical XMP sidecar | `sidecar/<mongo-objectid>` |
| Conflict-copy XMP sidecar | `sidecar/<mongo-objectid>:<b64url(basename-without-.xmp)>` |

Two sidecars per asset are possible (canonical + one conflict copy from each device). The base64url-encoded basename in the conflict form makes each identifier unique.

---

## Task 1: Server — `writeXmpWithPrecondition` helper

**Files:**
- Modify: `src/api/src/fs/xmp.ts`

- [ ] **Step 1: Add the new function alongside `writeXmpAtomic`**

Append to `src/api/src/fs/xmp.ts` (after `writeXmpAtomic`):

```typescript
import { stat } from "node:fs/promises";

/**
 * Result of an XMP write that may produce a conflict copy.
 * - `ok`: normal atomic write succeeded; `mtime` is the new file's mtime.
 * - `conflict`: mtime precondition failed; the incoming bytes were written
 *   to a conflict-copy file alongside the original. The original is
 *   untouched.
 * - `error`: any other failure (path jail, disk full, etc.).
 */
export type XmpWriteOutcome =
  | { kind: "ok"; mtime: Date }
  | { kind: "conflict"; conflictPath: string; conflictMtime: Date }
  | { kind: "error"; error: string };

/** Sanitize a device name for use in a conflict-copy filename. */
function sanitizeDeviceName(raw: string | undefined): string {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return "Unknown device";
  // Reject characters that are unsafe in filenames; replace with hyphen.
  return trimmed.replace(/[\/\\:*?"<>|]/g, "-").slice(0, 64);
}

/** Compose the conflict-copy path for a given RAW + device name. */
export function conflictCopyPath(rawAbsPath: string, deviceName: string): string {
  const ext = path.extname(rawAbsPath);
  const base = rawAbsPath.slice(0, -ext.length);
  return `${base} (conflict from ${sanitizeDeviceName(deviceName)}).xmp`;
}

/**
 * Atomic XMP write with an optional mtime precondition.
 *
 * When `ifMtimeMatchesEpoch` is provided and the on-disk file's mtime in
 * seconds differs, the bytes are written to a conflict-copy file
 * (`<base> (conflict from <device>).xmp`) instead of the canonical sidecar.
 * The canonical sidecar is left untouched in that case so the user can
 * pick a winner manually via Finder.
 *
 * Precondition semantics:
 *   - omitted     → unconditional create-or-overwrite
 *   - provided    → write only if on-disk mtime in epoch seconds matches
 *   - mismatch    → write to conflict-copy path; return `kind: "conflict"`
 *
 * mtime granularity is one second. XMP saves happen at human cadence
 * (one save per editor flush) so this is sufficient.
 */
export async function writeXmpWithPrecondition(
  rawAbsPath: string,
  xmlContent: string,
  ifMtimeMatchesEpoch: number | null,
  deviceName: string,
): Promise<XmpWriteOutcome> {
  const sidecar = xmpSidecarPath(rawAbsPath);

  // Precondition check (only when client supplied one).
  if (ifMtimeMatchesEpoch !== null) {
    let onDiskEpoch: number | null = null;
    try {
      const st = await stat(sidecar);
      onDiskEpoch = Math.floor(st.mtimeMs / 1000);
    } catch {
      // File doesn't exist yet; treat as precondition mismatch (the client
      // thinks there's a version T to overwrite, but there's nothing).
      onDiskEpoch = null;
    }
    if (onDiskEpoch !== ifMtimeMatchesEpoch) {
      const conflictPath = conflictCopyPath(rawAbsPath, deviceName);
      const allowed = await safeWriteAllowed(conflictPath);
      if (!allowed.ok) return { kind: "error", error: allowed.error };
      const tmp = conflictPath + ".tmp." + process.pid;
      try {
        await fs.mkdir(path.dirname(conflictPath), { recursive: true });
        const fh = await fs.open(tmp, "w");
        try {
          await fh.writeFile(xmlContent, "utf-8");
          await fh.datasync();
        } finally {
          await fh.close();
        }
        await fs.rename(tmp, conflictPath);
        const st = await stat(conflictPath);
        return { kind: "conflict", conflictPath, conflictMtime: st.mtime };
      } catch (err) {
        try { await fs.unlink(tmp); } catch {}
        const msg = err instanceof Error ? err.message : String(err);
        return { kind: "error", error: `Conflict-copy write failed: ${msg}` };
      }
    }
  }

  // Normal path: atomic overwrite.
  const result = await writeXmpAtomic(rawAbsPath, xmlContent);
  if (!result.ok) return { kind: "error", error: result.error };
  try {
    const st = await stat(sidecar);
    return { kind: "ok", mtime: st.mtime };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { kind: "error", error: `stat after write failed: ${msg}` };
  }
}

/**
 * Delete an XMP sidecar. Idempotent — succeeds whether or not the file
 * existed. Never touches the paired RAW.
 */
export async function deleteXmpSidecar(rawAbsPath: string): Promise<OpResult> {
  const sidecar = xmpSidecarPath(rawAbsPath);
  const allowed = await safeWriteAllowed(sidecar);
  if (!allowed.ok) return { ok: false, error: allowed.error };
  try {
    await fs.unlink(sidecar);
    return { ok: true };
  } catch (err: unknown) {
    if (err && typeof err === "object" && "code" in err && (err as { code: string }).code === "ENOENT") {
      return { ok: true };
    }
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `XMP delete failed: ${msg}` };
  }
}
```

- [ ] **Step 2: Verify the file still type-checks**

```bash
cd src/api && bun run --bun tsc --noEmit 2>&1 | head -10
```

Expected: no new errors.

- [ ] **Step 3: Commit**

```bash
git add src/api/src/fs/xmp.ts
git commit -m "feat(api): writeXmpWithPrecondition + deleteXmpSidecar for File Provider conflict copies"
```

---

## Task 2: Server — PUT route honours precondition + DELETE handler

**Files:**
- Modify: `src/api/src/routes/assets.ts`

- [ ] **Step 1: Replace the existing PUT handler and add DELETE**

In `src/api/src/routes/assets.ts`, locate the existing `.put("/:id/xmp", ...)` block (around line 182). Replace its body and append a `.delete` block after it.

Replace this section:

```typescript
  // Write XMP sidecar (atomic)
  .put(
    "/:id/xmp",
    async ({ params, body, set }) => {
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

      const xmlContent =
        typeof body === "string"
          ? body
          : (body as unknown) instanceof Uint8Array
            ? new TextDecoder().decode(body as unknown as Uint8Array)
            : String(body);

      const result = await writeXmpAtomic(doc.abs_path, xmlContent);
      if (!result.ok) {
        set.status = 500;
        return { error: result.error };
      }

      set.status = 204;
      return;
    },
    {
      type: "text",
      body: t.String(),
    }
  )
```

With this:

```typescript
  // Write XMP sidecar.
  //
  // Optional headers:
  //   X-If-Mtime-Matches: <epoch-seconds>  Precondition for conflict-copy
  //                                        mode. Omit to write
  //                                        unconditionally.
  //   X-Maple-Device-Name: <string>        Used in the conflict-copy
  //                                        filename. Defaults to
  //                                        "Unknown device".
  //
  // Responses:
  //   204 No Content + Last-Modified header — normal write
  //   409 Conflict   + JSON body { conflict_path, conflict_mtime } —
  //                    precondition mismatch; bytes written to conflict copy
  .put(
    "/:id/xmp",
    async ({ params, body, headers, set }) => {
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

      const xmlContent =
        typeof body === "string"
          ? body
          : (body as unknown) instanceof Uint8Array
            ? new TextDecoder().decode(body as unknown as Uint8Array)
            : String(body);

      const ifMtimeHeader = headers["x-if-mtime-matches"];
      const ifMtimeMatchesEpoch =
        typeof ifMtimeHeader === "string" && /^\d+$/.test(ifMtimeHeader)
          ? parseInt(ifMtimeHeader, 10)
          : null;
      const deviceHeader = headers["x-maple-device-name"];
      const deviceName = typeof deviceHeader === "string" ? deviceHeader : "";

      const outcome = await writeXmpWithPrecondition(
        doc.abs_path,
        xmlContent,
        ifMtimeMatchesEpoch,
        deviceName,
      );

      if (outcome.kind === "error") {
        set.status = 500;
        return { error: outcome.error };
      }
      if (outcome.kind === "conflict") {
        set.status = 409;
        return {
          conflict_path: outcome.conflictPath,
          conflict_mtime: outcome.conflictMtime.toISOString(),
        };
      }
      set.headers["Last-Modified"] = outcome.mtime.toUTCString();
      set.status = 204;
      return;
    },
    {
      type: "text",
      body: t.String(),
    }
  )

  // Delete XMP sidecar (idempotent).
  .delete("/:id/xmp", async ({ params, set }) => {
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
    const result = await deleteXmpSidecar(doc.abs_path);
    if (!result.ok) {
      set.status = 500;
      return { error: result.error };
    }
    set.status = 204;
    return;
  })
```

- [ ] **Step 2: Update the imports at the top of the file**

Find the existing import line:
```typescript
import { readXmp, writeXmpAtomic, resolveThumbPath } from "../fs/xmp.ts";
```

Replace with:
```typescript
import { readXmp, writeXmpAtomic, writeXmpWithPrecondition, deleteXmpSidecar, resolveThumbPath } from "../fs/xmp.ts";
```

- [ ] **Step 3: Type-check**

```bash
cd src/api && bun run --bun tsc --noEmit 2>&1 | head -10
```

Expected: no new errors.

- [ ] **Step 4: Commit**

```bash
git add src/api/src/routes/assets.ts
git commit -m "feat(api): PUT /api/assets/:id/xmp honours mtime precondition; add DELETE"
```

---

## Task 3: Server — `listDirContents` emits sidecars

**Files:**
- Modify: `src/api/src/fs/browse.ts`

- [ ] **Step 1: Extend the DirContents interface and add SidecarChild**

In `src/api/src/fs/browse.ts`, locate the `DirContents` interface (around line 218). Insert a new interface and extend `DirContents`:

```typescript
export interface SidecarChild {
  name: string;
  path: string;       // absolute, symlink-resolved
  mtime: string;      // ISO-8601
  size: number;       // bytes
  /**
   * Hex Mongo `_id` of the asset this XMP is paired to. Always set —
   * sidecars without a matching indexed asset are dropped from the
   * listing (same filter as `images`).
   */
  assetID: string;
}

export interface DirContents {
  path: string;
  parent: string | null;
  dirs: DirChild[];
  images: ImageChild[];
  sidecars: SidecarChild[];
}
```

- [ ] **Step 2: Add a helper that extracts the canonical base from a sidecar filename**

Add near the top of `browse.ts` (after `IMAGE_EXTENSIONS` is defined):

```typescript
/**
 * Match the optional `" (conflict from <device>)"` suffix on a sidecar
 * filename. Captures the canonical base before the suffix (group 1).
 * Returns null if the filename isn't a `.xmp` at all.
 *
 * Examples:
 *   "IMG_1.xmp"                                 → "IMG_1"
 *   "IMG_1 (conflict from MacBook).xmp"         → "IMG_1"
 *   "IMG_1 (conflict from work-laptop).xmp"     → "IMG_1"
 *   "notes.txt"                                 → null
 */
export function canonicalBaseFromSidecarFilename(filename: string): string | null {
  const m = /^(.+?)( \(conflict from [^)]+\))?\.xmp$/i.exec(filename);
  return m ? m[1] : null;
}
```

- [ ] **Step 3: Walk XMPs in `listDirContents` and pair against assets**

Find the directory-walk loop in `listDirContents` (around line 277). After the existing `if (st.isFile())` block that handles images, add a sibling `else if` branch for `.xmp` files. Locate this section:

```typescript
    if (st.isDirectory()) {
      dirs.push({ name, path: childReal, mtime: st.mtime.toISOString() });
    } else if (st.isFile()) {
      const dot = name.lastIndexOf(".");
      if (dot < 0) continue;
      const ext = name.slice(dot + 1).toLowerCase();
      if (!IMAGE_EXTENSIONS.has(ext)) continue;
      images.push({
        name,
        path: childReal,
        size: st.size,
        mtime: st.mtime.toISOString(),
        ext,
      });
    }
```

Replace with:

```typescript
    if (st.isDirectory()) {
      dirs.push({ name, path: childReal, mtime: st.mtime.toISOString() });
    } else if (st.isFile()) {
      const dot = name.lastIndexOf(".");
      if (dot < 0) continue;
      const ext = name.slice(dot + 1).toLowerCase();
      if (IMAGE_EXTENSIONS.has(ext)) {
        images.push({
          name,
          path: childReal,
          size: st.size,
          mtime: st.mtime.toISOString(),
          ext,
        });
      } else if (ext === "xmp") {
        sidecarRaw.push({
          name,
          path: childReal,
          size: st.size,
          mtime: st.mtime.toISOString(),
        });
      }
    }
```

Add `const sidecarRaw: Array<Omit<SidecarChild, "assetID">> = [];` near the top of the function, next to `const dirs: DirChild[] = [];`.

- [ ] **Step 4: Pair sidecars to indexed assets**

After the existing `Bulk-attach indexed EXIF` block (the one that populates `byPath`), add:

```typescript
  // Pair each candidate sidecar to an indexed asset by matching the
  // canonical base against the image filenames present in this listing.
  // Image filenames -> canonical-base (no extension) lookup table.
  const imageBaseToAsset = new Map<string, string>();
  for (const img of images) {
    if (!img.id) continue;
    const dot = img.name.lastIndexOf(".");
    const base = dot >= 0 ? img.name.slice(0, dot) : img.name;
    imageBaseToAsset.set(base, img.id);
  }

  const sidecars: SidecarChild[] = [];
  for (const cand of sidecarRaw) {
    const base = canonicalBaseFromSidecarFilename(cand.name);
    if (!base) continue;
    const assetID = imageBaseToAsset.get(base);
    if (!assetID) continue;
    sidecars.push({ ...cand, assetID });
  }
```

- [ ] **Step 5: Include `sidecars` in the returned `DirContents`**

Find the return statement at the end of the function:

```typescript
  return {
    ok: true,
    data: {
      path: real,
      parent: isRoot ? null : path.dirname(real),
      dirs,
      images,
    },
  };
```

Replace with:

```typescript
  return {
    ok: true,
    data: {
      path: real,
      parent: isRoot ? null : path.dirname(real),
      dirs,
      images,
      sidecars,
    },
  };
```

- [ ] **Step 6: Type-check**

```bash
cd src/api && bun run --bun tsc --noEmit 2>&1 | head -10
```

Expected: no new errors.

- [ ] **Step 7: Commit**

```bash
git add src/api/src/fs/browse.ts
git commit -m "feat(api): /api/fs/dir returns sidecars[] paired to indexed assets"
```

---

## Task 4: Server tests — fs-dir sidecars

**Files:**
- Create: `src/api/tests/fs-dir-sidecars.test.ts`

- [ ] **Step 1: Write the test file**

Create `src/api/tests/fs-dir-sidecars.test.ts`:

```typescript
/**
 * `/api/fs/dir` returns a `sidecars[]` array containing every `.xmp`
 * file whose canonical base (with optional "(conflict from …)" suffix
 * stripped) pairs to an indexed image in the same directory.
 *
 * Real Mongo; skip-passes if MongoDB is unreachable. Same pattern as
 * fs-dir-asset-link.test.ts.
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

const TEST_DB = `maple_test_fs_dir_sidecars_${process.pid}`;
const PRIOR_MONGO_DB = process.env.MAPLE_MONGO_DB;
const MONGO_URI = process.env.MAPLE_MONGO_URI ?? "mongodb://localhost:27017";

let mongo: MongoClient | null = null;
let mongoReachable = false;
let db: Db | null = null;
let tmpRoot: string;
let realTmpRoot: string;
let rawPath: string;
let canonicalXmpPath: string;
let conflictXmpPath: string;
let orphanXmpPath: string;
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

describe("GET /api/fs/dir — sidecars[] pairing", () => {
  beforeAll(async () => {
    process.env.MAPLE_MONGO_DB = TEST_DB;
    mongo = await tryConnect();
    mongoReachable = mongo !== null;
    if (!mongoReachable) return;

    db = mongo!.db(TEST_DB);
    await db.collection("assets").deleteMany({});
    await db.collection("folders").deleteMany({});

    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "maple-fp2-fsdir-"));
    realTmpRoot = await fs.realpath(tmpRoot);
    process.env.MAPLE_ROOTS = realTmpRoot;

    // Write fixture files.
    rawPath = path.join(realTmpRoot, "IMG_1.ARW");
    canonicalXmpPath = path.join(realTmpRoot, "IMG_1.xmp");
    conflictXmpPath = path.join(realTmpRoot, "IMG_1 (conflict from MacBook).xmp");
    orphanXmpPath = path.join(realTmpRoot, "DSCF0001.xmp");
    await fs.writeFile(rawPath, new Uint8Array([0xff, 0xd8, 0xff]));
    await fs.writeFile(canonicalXmpPath, "<x:xmpmeta/>");
    await fs.writeFile(conflictXmpPath, "<x:xmpmeta/>");
    await fs.writeFile(orphanXmpPath, "<x:xmpmeta/>");

    // Index the RAW.
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
    });

    // Force the singleton route handler to reopen against TEST_DB.
    const { closeMongoConnections } = await import("../src/db/client.ts");
    await closeMongoConnections();
  });

  afterAll(async () => {
    if (mongo) {
      try { await db?.dropDatabase(); } catch {}
      await mongo.close();
    }
    try { await fs.rm(tmpRoot, { recursive: true, force: true }); } catch {}
    if (PRIOR_MONGO_DB === undefined) delete process.env.MAPLE_MONGO_DB;
    else process.env.MAPLE_MONGO_DB = PRIOR_MONGO_DB;
  });

  it("pairs canonical + conflict sidecars to the same asset", async () => {
    if (!mongoReachable) return;
    const { fsRoutes } = await import("../src/routes/fs.ts");
    const app = fsRoutes;
    const url = `http://test/api/fs/dir?path=${encodeURIComponent(realTmpRoot)}`;
    const res = await app.handle(new Request(url));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      sidecars: Array<{ name: string; assetID: string }>;
    };
    const names = body.sidecars.map((s) => s.name).sort();
    expect(names).toEqual([
      "IMG_1 (conflict from MacBook).xmp",
      "IMG_1.xmp",
    ]);
    for (const s of body.sidecars) {
      expect(s.assetID).toBe(assetId.toHexString());
    }
  });

  it("drops orphan sidecars (no paired indexed asset)", async () => {
    if (!mongoReachable) return;
    const { fsRoutes } = await import("../src/routes/fs.ts");
    const app = fsRoutes;
    const url = `http://test/api/fs/dir?path=${encodeURIComponent(realTmpRoot)}`;
    const res = await app.handle(new Request(url));
    const body = (await res.json()) as {
      sidecars: Array<{ name: string }>;
    };
    expect(body.sidecars.find((s) => s.name === "DSCF0001.xmp")).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test**

```bash
cd src/api && bun test tests/fs-dir-sidecars.test.ts 2>&1 | tail -15
```

Expected: 2 pass (if Mongo reachable) or 2 skip-passes (if not). Either is acceptable.

- [ ] **Step 3: Commit**

```bash
git add src/api/tests/fs-dir-sidecars.test.ts
git commit -m "test(api): /api/fs/dir sidecars[] pairing including conflict-suffix"
```

---

## Task 5: Server tests — XMP conflict-copy + delete

**Files:**
- Create: `src/api/tests/assets-xmp-conflict.test.ts`
- Create: `src/api/tests/assets-xmp-delete.test.ts`

- [ ] **Step 1: Write the conflict test**

Create `src/api/tests/assets-xmp-conflict.test.ts`:

```typescript
/**
 * PUT /api/assets/:id/xmp with X-If-Mtime-Matches:
 *  - omitted             → unconditional write, 204, Last-Modified set
 *  - matches on-disk     → atomic overwrite, 204, Last-Modified set
 *  - mismatches on-disk  → conflict-copy file written, 409 + JSON,
 *                          original untouched
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

const TEST_DB = `maple_test_fp2_conflict_${process.pid}`;
const PRIOR_MONGO_DB = process.env.MAPLE_MONGO_DB;
const MONGO_URI = process.env.MAPLE_MONGO_URI ?? "mongodb://localhost:27017";

let mongo: MongoClient | null = null;
let mongoReachable = false;
let db: Db | null = null;
let tmpRoot: string;
let realTmpRoot: string;
let rawPath: string;
let xmpPath: string;
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

async function callPut(body: string, headers: Record<string, string> = {}): Promise<Response> {
  const { assetsRoutes } = await import("../src/routes/assets.ts");
  const url = `http://test/api/assets/${assetId.toHexString()}/xmp`;
  return assetsRoutes.handle(
    new Request(url, {
      method: "PUT",
      headers: { "content-type": "text/plain", ...headers },
      body,
    }),
  );
}

describe("PUT /api/assets/:id/xmp — conflict copies", () => {
  beforeAll(async () => {
    process.env.MAPLE_MONGO_DB = TEST_DB;
    mongo = await tryConnect();
    mongoReachable = mongo !== null;
    if (!mongoReachable) return;

    db = mongo!.db(TEST_DB);
    await db.collection("assets").deleteMany({});

    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "maple-fp2-conflict-"));
    realTmpRoot = await fs.realpath(tmpRoot);
    process.env.MAPLE_ROOTS = realTmpRoot;

    rawPath = path.join(realTmpRoot, "IMG_1.ARW");
    xmpPath = path.join(realTmpRoot, "IMG_1.xmp");
    await fs.writeFile(rawPath, new Uint8Array([0xff, 0xd8, 0xff]));

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
    });

    const { closeMongoConnections } = await import("../src/db/client.ts");
    await closeMongoConnections();
  });

  afterAll(async () => {
    if (mongo) {
      try { await db?.dropDatabase(); } catch {}
      await mongo.close();
    }
    try { await fs.rm(tmpRoot, { recursive: true, force: true }); } catch {}
    if (PRIOR_MONGO_DB === undefined) delete process.env.MAPLE_MONGO_DB;
    else process.env.MAPLE_MONGO_DB = PRIOR_MONGO_DB;
  });

  it("unconditional write returns 204 with Last-Modified", async () => {
    if (!mongoReachable) return;
    const res = await callPut("<x:xmpmeta>v1</x:xmpmeta>");
    expect(res.status).toBe(204);
    expect(res.headers.get("last-modified")).toBeTruthy();
    const onDisk = await fs.readFile(xmpPath, "utf8");
    expect(onDisk).toContain("v1");
  });

  it("matching precondition overwrites atomically", async () => {
    if (!mongoReachable) return;
    const st = await fs.stat(xmpPath);
    const epoch = Math.floor(st.mtimeMs / 1000);
    const res = await callPut("<x:xmpmeta>v2</x:xmpmeta>", {
      "x-if-mtime-matches": String(epoch),
      "x-maple-device-name": "test-mbp",
    });
    expect(res.status).toBe(204);
    const onDisk = await fs.readFile(xmpPath, "utf8");
    expect(onDisk).toContain("v2");
    // No conflict copy created.
    const dir = await fs.readdir(realTmpRoot);
    expect(dir.some((f) => f.includes("conflict from"))).toBe(false);
  });

  it("mismatching precondition writes a conflict copy", async () => {
    if (!mongoReachable) return;
    // Use an mtime that's definitely not current.
    const res = await callPut("<x:xmpmeta>v3-from-B</x:xmpmeta>", {
      "x-if-mtime-matches": "1",
      "x-maple-device-name": "test-laptop-B",
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as {
      conflict_path: string;
      conflict_mtime: string;
    };
    expect(body.conflict_path).toContain("IMG_1 (conflict from test-laptop-B).xmp");
    const onDisk = await fs.readFile(body.conflict_path, "utf8");
    expect(onDisk).toContain("v3-from-B");
    // Original sidecar untouched (still contains v2 from the prior test).
    const orig = await fs.readFile(xmpPath, "utf8");
    expect(orig).toContain("v2");
  });

  it("missing device name produces 'Unknown device' conflict file", async () => {
    if (!mongoReachable) return;
    const res = await callPut("<x:xmpmeta>v4</x:xmpmeta>", {
      "x-if-mtime-matches": "1",
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { conflict_path: string };
    expect(body.conflict_path).toContain("(conflict from Unknown device)");
  });
});
```

- [ ] **Step 2: Write the delete test**

Create `src/api/tests/assets-xmp-delete.test.ts`:

```typescript
/**
 * DELETE /api/assets/:id/xmp:
 *   - removes existing sidecar, 204
 *   - non-existent sidecar still returns 204 (idempotent)
 *   - never touches the paired RAW
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

const TEST_DB = `maple_test_fp2_delete_${process.pid}`;
const PRIOR_MONGO_DB = process.env.MAPLE_MONGO_DB;
const MONGO_URI = process.env.MAPLE_MONGO_URI ?? "mongodb://localhost:27017";

let mongo: MongoClient | null = null;
let mongoReachable = false;
let db: Db | null = null;
let tmpRoot: string;
let realTmpRoot: string;
let rawPath: string;
let xmpPath: string;
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

describe("DELETE /api/assets/:id/xmp", () => {
  beforeAll(async () => {
    process.env.MAPLE_MONGO_DB = TEST_DB;
    mongo = await tryConnect();
    mongoReachable = mongo !== null;
    if (!mongoReachable) return;

    db = mongo!.db(TEST_DB);
    await db.collection("assets").deleteMany({});

    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "maple-fp2-delete-"));
    realTmpRoot = await fs.realpath(tmpRoot);
    process.env.MAPLE_ROOTS = realTmpRoot;

    rawPath = path.join(realTmpRoot, "IMG_1.ARW");
    xmpPath = path.join(realTmpRoot, "IMG_1.xmp");
    await fs.writeFile(rawPath, new Uint8Array([0xff, 0xd8, 0xff]));

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
    });

    const { closeMongoConnections } = await import("../src/db/client.ts");
    await closeMongoConnections();
  });

  afterAll(async () => {
    if (mongo) {
      try { await db?.dropDatabase(); } catch {}
      await mongo.close();
    }
    try { await fs.rm(tmpRoot, { recursive: true, force: true }); } catch {}
    if (PRIOR_MONGO_DB === undefined) delete process.env.MAPLE_MONGO_DB;
    else process.env.MAPLE_MONGO_DB = PRIOR_MONGO_DB;
  });

  it("removes an existing sidecar, returns 204, RAW untouched", async () => {
    if (!mongoReachable) return;
    await fs.writeFile(xmpPath, "<x:xmpmeta/>");
    const { assetsRoutes } = await import("../src/routes/assets.ts");
    const res = await assetsRoutes.handle(
      new Request(`http://test/api/assets/${assetId.toHexString()}/xmp`, {
        method: "DELETE",
      }),
    );
    expect(res.status).toBe(204);
    await expect(fs.access(xmpPath)).rejects.toThrow();
    await fs.access(rawPath); // RAW must still exist.
  });

  it("non-existent sidecar is idempotent (returns 204)", async () => {
    if (!mongoReachable) return;
    // Sidecar was deleted in the prior test.
    const { assetsRoutes } = await import("../src/routes/assets.ts");
    const res = await assetsRoutes.handle(
      new Request(`http://test/api/assets/${assetId.toHexString()}/xmp`, {
        method: "DELETE",
      }),
    );
    expect(res.status).toBe(204);
  });
});
```

- [ ] **Step 3: Run both tests**

```bash
cd src/api && bun test tests/assets-xmp-conflict.test.ts tests/assets-xmp-delete.test.ts 2>&1 | tail -20
```

Expected: all pass (or skip-pass when Mongo unreachable).

- [ ] **Step 4: Commit**

```bash
git add src/api/tests/assets-xmp-conflict.test.ts src/api/tests/assets-xmp-delete.test.ts
git commit -m "test(api): XMP precondition conflict copies + idempotent delete"
```

---

## Task 6: Client — `FileProviderIdentifier` sidecar case

**Files:**
- Modify: `src/apple/Packages/MapleCore/Sources/MapleCore/FileProvider/FileProviderIdentifier.swift`
- Modify: `src/apple/Packages/MapleCore/Tests/MapleCoreTests/FileProviderIdentifierTests.swift`

- [ ] **Step 1: Add failing tests first**

Append to `src/apple/Packages/MapleCore/Tests/MapleCoreTests/FileProviderIdentifierTests.swift` (inside the existing `final class FileProviderIdentifierTests`):

```swift
    func testCanonicalSidecarRoundTrip() throws {
        let id = FileProviderIdentifier.sidecar(assetID: "650a1b", conflictBasename: nil)
        XCTAssertEqual(id.rawValue, "sidecar/650a1b")
        XCTAssertEqual(try FileProviderIdentifier(rawValue: id.rawValue), id)
    }

    func testConflictSidecarRoundTrip() throws {
        let id = FileProviderIdentifier.sidecar(
            assetID: "650a1b",
            conflictBasename: "IMG_1 (conflict from MacBook)"
        )
        // base64url("IMG_1 (conflict from MacBook)") = "SU1HXzEgKGNvbmZsaWN0IGZyb20gTWFjQm9vaykg" minus trailing pad
        XCTAssertTrue(id.rawValue.hasPrefix("sidecar/650a1b:"))
        XCTAssertEqual(try FileProviderIdentifier(rawValue: id.rawValue), id)
    }

    func testSidecarPrefixWithoutPayloadIsCanonical() throws {
        // Bare "sidecar/<id>" with no trailing colon is canonical.
        let id = try FileProviderIdentifier(rawValue: "sidecar/abc")
        XCTAssertEqual(id, .sidecar(assetID: "abc", conflictBasename: nil))
    }

    func testSidecarWithEmptyPayloadIsAlsoCanonical() throws {
        // Defensive: "sidecar/<id>:" with empty payload should still decode
        // as canonical.
        let id = try FileProviderIdentifier(rawValue: "sidecar/abc:")
        XCTAssertEqual(id, .sidecar(assetID: "abc", conflictBasename: nil))
    }
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
cd src/apple/Packages/MapleCore && swift test --filter FileProviderIdentifierTests 2>&1 | tail -10
```

Expected: compile failure (new case doesn't exist yet).

- [ ] **Step 3: Add the sidecar case to the enum**

Replace the entire contents of `src/apple/Packages/MapleCore/Sources/MapleCore/FileProvider/FileProviderIdentifier.swift` with:

```swift
// src/apple/Packages/MapleCore/Sources/MapleCore/FileProvider/FileProviderIdentifier.swift
import Foundation

public enum FileProviderIdentifier: Equatable, Hashable, Sendable {
    case asset(String)
    case folder(folderID: String, relativePath: String)
    /// XMP sidecar paired to an asset. `conflictBasename` is nil for the
    /// canonical `<base>.xmp` and non-nil for conflict copies
    /// (`<base> (conflict from <device>).xmp`). The basename excludes the
    /// `.xmp` extension.
    case sidecar(assetID: String, conflictBasename: String?)

    public enum DecodeError: Error { case invalidPrefix, malformedFolder, malformedSidecar, badBase64 }

    public var rawValue: String {
        switch self {
        case .asset(let id):
            return "asset/\(id)"
        case .folder(let folderID, let relativePath):
            return "folder/\(folderID):\(Self.b64urlEncode(relativePath))"
        case .sidecar(let assetID, let conflictBasename):
            if let conflictBasename {
                return "sidecar/\(assetID):\(Self.b64urlEncode(conflictBasename))"
            }
            return "sidecar/\(assetID)"
        }
    }

    public init(rawValue: String) throws {
        if let id = rawValue.dropPrefixIfPresent("asset/") {
            self = .asset(String(id))
            return
        }
        if let body = rawValue.dropPrefixIfPresent("folder/") {
            guard let colon = body.firstIndex(of: ":") else { throw DecodeError.malformedFolder }
            let folderID = String(body[..<colon])
            let encoded = String(body[body.index(after: colon)...])
            guard let path = Self.b64urlDecode(encoded) else { throw DecodeError.badBase64 }
            self = .folder(folderID: folderID, relativePath: path)
            return
        }
        if let body = rawValue.dropPrefixIfPresent("sidecar/") {
            if let colon = body.firstIndex(of: ":") {
                let assetID = String(body[..<colon])
                if assetID.isEmpty { throw DecodeError.malformedSidecar }
                let encoded = String(body[body.index(after: colon)...])
                if encoded.isEmpty {
                    self = .sidecar(assetID: assetID, conflictBasename: nil)
                    return
                }
                guard let name = Self.b64urlDecode(encoded) else { throw DecodeError.badBase64 }
                self = .sidecar(assetID: assetID, conflictBasename: name)
                return
            }
            let assetID = String(body)
            if assetID.isEmpty { throw DecodeError.malformedSidecar }
            self = .sidecar(assetID: assetID, conflictBasename: nil)
            return
        }
        throw DecodeError.invalidPrefix
    }

    private static func b64urlEncode(_ s: String) -> String {
        let data = Data(s.utf8)
        return data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    private static func b64urlDecode(_ s: String) -> String? {
        if s.isEmpty { return "" }
        var padded = s.replacingOccurrences(of: "-", with: "+")
                      .replacingOccurrences(of: "_", with: "/")
        while padded.count % 4 != 0 { padded.append("=") }
        guard let data = Data(base64Encoded: padded),
              let s = String(data: data, encoding: .utf8) else { return nil }
        return s
    }
}

private extension String {
    func dropPrefixIfPresent(_ prefix: String) -> Substring? {
        guard hasPrefix(prefix) else { return nil }
        return dropFirst(prefix.count)
    }
}
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
cd src/apple/Packages/MapleCore && swift test --filter FileProviderIdentifierTests 2>&1 | tail -5
```

Expected: all tests pass (10 total — 6 original + 4 new).

- [ ] **Step 5: Commit**

```bash
git add src/apple/Packages/MapleCore/Sources/MapleCore/FileProvider/FileProviderIdentifier.swift \
        src/apple/Packages/MapleCore/Tests/MapleCoreTests/FileProviderIdentifierTests.swift
git commit -m "feat(core): file provider identifier — sidecar case (canonical + conflict)"
```

---

## Task 7: Client — `RemoteCatalog` sidecars DTO + putXMP/deleteXMP

**Files:**
- Modify: `src/apple/Packages/MapleCore/Sources/MapleCore/FileProvider/RemoteCatalog.swift`
- Modify: `src/apple/Packages/MapleCore/Tests/MapleCoreTests/RemoteCatalogTests.swift`

- [ ] **Step 1: Add failing DTO decode tests**

Append to `src/apple/Packages/MapleCore/Tests/MapleCoreTests/RemoteCatalogTests.swift` (inside the existing class):

```swift
    func testDecodeDirContentsWithSidecars() throws {
        let json = """
        {
          "path": "/photos",
          "parent": null,
          "dirs": [],
          "images": [
            {"name":"IMG_1.ARW","path":"/photos/IMG_1.ARW","mtime":"2026-05-15T10:00:00Z","size":100,"ext":"arw","id":"650a"}
          ],
          "sidecars": [
            {"name":"IMG_1.xmp","path":"/photos/IMG_1.xmp","mtime":"2026-05-15T10:00:00Z","size":50,"asset_id":"650a"}
          ]
        }
        """.data(using: .utf8)!
        let d = JSONDecoder()
        d.dateDecodingStrategy = .iso8601
        let contents = try d.decode(DirContents.self, from: json)
        XCTAssertEqual(contents.sidecars.count, 1)
        XCTAssertEqual(contents.sidecars[0].name, "IMG_1.xmp")
        XCTAssertEqual(contents.sidecars[0].assetID, "650a")
        XCTAssertEqual(contents.sidecars[0].size, 50)
    }

    func testDecodeDirContentsWithoutSidecarsField() throws {
        // The server omits sidecars[] on older versions of the API — the
        // client must tolerate that by defaulting to an empty array.
        let json = """
        {"path":"/p","parent":null,"dirs":[],"images":[]}
        """.data(using: .utf8)!
        let d = JSONDecoder()
        d.dateDecodingStrategy = .iso8601
        let contents = try d.decode(DirContents.self, from: json)
        XCTAssertEqual(contents.sidecars, [])
    }
```

- [ ] **Step 2: Confirm they fail**

```bash
cd src/apple/Packages/MapleCore && swift test --filter RemoteCatalogTests 2>&1 | tail -5
```

Expected: compile failure (`SidecarChild` and `DirContents.sidecars` not defined).

- [ ] **Step 3: Add SidecarChild + XMPWriteResult + extend DirContents**

Open `src/apple/Packages/MapleCore/Sources/MapleCore/FileProvider/RemoteCatalog.swift`.

Find the `public struct DirContents` declaration. Replace it with the extended form and add a new `SidecarChild` struct above it:

```swift
public struct SidecarChild: Codable, Equatable, Sendable {
    public let name: String
    public let path: String
    public let mtime: Date
    public let size: Int64
    public let assetID: String

    enum CodingKeys: String, CodingKey {
        case name, path, mtime, size
        case assetID = "asset_id"
    }
}

public struct DirContents: Codable, Equatable, Sendable {
    public let path: String
    public let parent: String?
    public let dirs: [DirChild]
    public let images: [ImageChild]
    public let sidecars: [SidecarChild]

    public init(path: String, parent: String?, dirs: [DirChild], images: [ImageChild], sidecars: [SidecarChild]) {
        self.path = path
        self.parent = parent
        self.dirs = dirs
        self.images = images
        self.sidecars = sidecars
    }

    private enum CodingKeys: String, CodingKey { case path, parent, dirs, images, sidecars }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.path = try c.decode(String.self, forKey: .path)
        self.parent = try c.decodeIfPresent(String.self, forKey: .parent)
        self.dirs = try c.decode([DirChild].self, forKey: .dirs)
        self.images = try c.decode([ImageChild].self, forKey: .images)
        // Tolerate the field being absent — pre-Phase-2 servers don't send it.
        self.sidecars = (try? c.decode([SidecarChild].self, forKey: .sidecars)) ?? []
    }
}
```

- [ ] **Step 4: Add XMPWriteResult enum**

Below the new struct, add:

```swift
public enum XMPWriteResult: Equatable, Sendable {
    /// Write succeeded; the response's Last-Modified header is parsed
    /// into this Date and reflects the new on-disk mtime.
    case ok(mtime: Date)
    /// Server detected a precondition mismatch and wrote the bytes to a
    /// conflict-copy file instead. The original sidecar is untouched.
    case conflict(path: String, mtime: Date)
}
```

- [ ] **Step 5: Add putXMP + deleteXMP methods to the RemoteCatalog actor**

Find the closing `}` of the `RemoteCatalog` actor. Just before it, insert:

```swift
    /// PUT /api/assets/<assetID>/xmp.
    ///
    /// - `ifMtimeMatches`: omit (nil) for first-write create; pass the
    ///   last-known mtime for modify so the server can detect concurrent
    ///   edits and produce a conflict copy.
    /// - `deviceName`: stamped into conflict-copy filenames.
    public func putXMP(
        assetID: String,
        data: Data,
        ifMtimeMatches: Date?,
        deviceName: String
    ) async throws -> XMPWriteResult {
        var req = URLRequest(url: server.appending(path: "/api/assets/\(assetID)/xmp"))
        req.httpMethod = "PUT"
        req.setValue("text/plain; charset=utf-8", forHTTPHeaderField: "Content-Type")
        req.setValue(deviceName, forHTTPHeaderField: "X-Maple-Device-Name")
        if let prior = ifMtimeMatches {
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

    /// DELETE /api/assets/<assetID>/xmp. Idempotent.
    public func deleteXMP(assetID: String) async throws {
        var req = URLRequest(url: server.appending(path: "/api/assets/\(assetID)/xmp"))
        req.httpMethod = "DELETE"
        let (_, resp) = try await http.data(for: req)
        try Self.check2xx(resp)
    }

    private static func parseLastModified(_ resp: HTTPURLResponse?) -> Date? {
        guard let raw = resp?.value(forHTTPHeaderField: "Last-Modified") else { return nil }
        let fmt = DateFormatter()
        fmt.locale = Locale(identifier: "en_US_POSIX")
        fmt.timeZone = TimeZone(identifier: "GMT")
        fmt.dateFormat = "EEE, dd MMM yyyy HH:mm:ss zzz"
        return fmt.date(from: raw)
    }
```

- [ ] **Step 6: Verify tests pass**

```bash
cd src/apple/Packages/MapleCore && swift test --filter RemoteCatalogTests 2>&1 | tail -5
```

Expected: all tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/apple/Packages/MapleCore/Sources/MapleCore/FileProvider/RemoteCatalog.swift \
        src/apple/Packages/MapleCore/Tests/MapleCoreTests/RemoteCatalogTests.swift
git commit -m "feat(core): RemoteCatalog sidecars[] DTO + putXMP/deleteXMP"
```

---

## Task 8: Client — `MapleItem` sidecar init

**Files:**
- Modify: `src/apple/MapleFileProvider/MapleItem.swift`

- [ ] **Step 1: Replace the file**

Replace `src/apple/MapleFileProvider/MapleItem.swift` with:

```swift
// src/apple/MapleFileProvider/MapleItem.swift
import FileProvider
import MapleCore
import UniformTypeIdentifiers

final class MapleItem: NSObject, NSFileProviderItem {
    private let identifier: FileProviderIdentifier
    private let displayName: String
    private let isDirectory: Bool
    private let size: NSNumber?
    private let modified: Date?
    private let utType: UTType
    private let writeCapabilities: NSFileProviderItemCapabilities

    let itemIdentifier: NSFileProviderItemIdentifier
    let parentItemIdentifier: NSFileProviderItemIdentifier
    let filename: String
    var contentType: UTType { utType }
    var capabilities: NSFileProviderItemCapabilities { writeCapabilities }
    var documentSize: NSNumber? { size }
    var contentModificationDate: Date? { modified }
    var creationDate: Date? { modified }
    var itemVersion: NSFileProviderItemVersion {
        let mtimeBytes = String(Int(modified?.timeIntervalSince1970 ?? 0)).data(using: .utf8) ?? Data()
        return .init(contentVersion: mtimeBytes, metadataVersion: mtimeBytes)
    }
    var isUploaded: Bool { true }
    var isDownloaded: Bool { false }

    init(libraryRoot root: LibraryRoot) {
        self.identifier = .folder(folderID: root.id, relativePath: "")
        self.displayName = root.label
        self.isDirectory = true
        self.size = nil
        self.modified = nil
        self.utType = .folder
        self.writeCapabilities = [.allowsReading]
        self.itemIdentifier = NSFileProviderItemIdentifier(self.identifier.rawValue)
        self.parentItemIdentifier = .rootContainer
        self.filename = root.label
    }

    init(subdirectory dir: DirChild, parentFolderID: String, parentRelativePath: String, parentIdentifier: NSFileProviderItemIdentifier) {
        let child = parentRelativePath.isEmpty ? dir.name : "\(parentRelativePath)/\(dir.name)"
        self.identifier = .folder(folderID: parentFolderID, relativePath: child)
        self.displayName = dir.name
        self.isDirectory = true
        self.size = nil
        self.modified = dir.mtime
        self.utType = .folder
        self.writeCapabilities = [.allowsReading]
        self.itemIdentifier = NSFileProviderItemIdentifier(self.identifier.rawValue)
        self.parentItemIdentifier = parentIdentifier
        self.filename = dir.name
    }

    /// Returns nil for unindexed images (no asset ID).
    init?(image: ImageChild, parentIdentifier: NSFileProviderItemIdentifier) {
        guard let assetID = image.assetID, !assetID.isEmpty else { return nil }
        self.identifier = .asset(assetID)
        self.displayName = image.name
        self.isDirectory = false
        self.size = NSNumber(value: image.size)
        self.modified = image.mtime
        self.utType = UTType(filenameExtension: image.ext) ?? .data
        // RAWs remain read-only in Phase 2.
        self.writeCapabilities = [.allowsReading]
        self.itemIdentifier = NSFileProviderItemIdentifier(self.identifier.rawValue)
        self.parentItemIdentifier = parentIdentifier
        self.filename = image.name
    }

    /// Writable XMP sidecar. `parentImageBase` is the image filename
    /// without its extension (e.g. "IMG_1" for "IMG_1.ARW"); used to
    /// determine whether this sidecar is canonical or a conflict copy
    /// from the on-disk filename.
    init(sidecar: SidecarChild, parentImageBase: String, parentIdentifier: NSFileProviderItemIdentifier) {
        let canonicalName = "\(parentImageBase).xmp"
        let isCanonical = sidecar.name == canonicalName
        let basenameWithoutExt: String? = {
            guard !isCanonical else { return nil }
            // Strip ".xmp" suffix.
            if sidecar.name.hasSuffix(".xmp") {
                return String(sidecar.name.dropLast(4))
            }
            return sidecar.name
        }()
        self.identifier = .sidecar(assetID: sidecar.assetID, conflictBasename: basenameWithoutExt)
        self.displayName = sidecar.name
        self.isDirectory = false
        self.size = NSNumber(value: sidecar.size)
        self.modified = sidecar.mtime
        self.utType = UTType(filenameExtension: "xmp") ?? .xml
        self.writeCapabilities = [.allowsReading, .allowsWriting, .allowsDeleting]
        self.itemIdentifier = NSFileProviderItemIdentifier(self.identifier.rawValue)
        self.parentItemIdentifier = parentIdentifier
        self.filename = sidecar.name
    }
}
```

- [ ] **Step 2: Build the extension target**

```bash
cd src/apple && xcodebuild -project Maple.xcodeproj -scheme Maple -destination 'platform=macOS,arch=arm64' build 2>&1 | grep -E "^\*\*|error:" | tail -5
```

Expected: `** BUILD SUCCEEDED **`.

- [ ] **Step 3: Commit**

```bash
git add src/apple/MapleFileProvider/MapleItem.swift
git commit -m "feat(fileprovider): MapleItem sidecar init with writable capabilities"
```

---

## Task 9: Client — `FolderEnumerator` emits sidecars

**Files:**
- Modify: `src/apple/MapleFileProvider/MapleEnumerator.swift`

- [ ] **Step 1: Extend `FolderEnumerator.enumerateItems`**

Open `src/apple/MapleFileProvider/MapleEnumerator.swift`. Find the `FolderEnumerator.enumerateItems` method. Replace this section:

```swift
                let contents = try await catalog.listDir(absolutePath: absolutePath)
                var items: [NSFileProviderItem] = contents.dirs.map { d in
                    MapleItem(subdirectory: d,
                              parentFolderID: folderID,
                              parentRelativePath: relativePath,
                              parentIdentifier: containerIdentifier)
                }
                // Failable init filters out unindexed images.
                items.append(contentsOf: contents.images.compactMap {
                    MapleItem(image: $0, parentIdentifier: containerIdentifier)
                })
```

With:

```swift
                let contents = try await catalog.listDir(absolutePath: absolutePath)
                var items: [NSFileProviderItem] = contents.dirs.map { d in
                    MapleItem(subdirectory: d,
                              parentFolderID: folderID,
                              parentRelativePath: relativePath,
                              parentIdentifier: containerIdentifier)
                }
                // Failable init filters out unindexed images.
                items.append(contentsOf: contents.images.compactMap {
                    MapleItem(image: $0, parentIdentifier: containerIdentifier)
                })
                // Build a lookup from asset ID to that asset's filename base
                // (no extension) so each sidecar can resolve its canonical-vs-
                // conflict status.
                var assetIDToBase: [String: String] = [:]
                for img in contents.images {
                    guard let id = img.assetID else { continue }
                    let dot = img.name.lastIndex(of: ".")
                    let base = dot.map { String(img.name[..<$0]) } ?? img.name
                    assetIDToBase[id] = base
                }
                for sidecar in contents.sidecars {
                    let base = assetIDToBase[sidecar.assetID] ?? sidecar.name
                    items.append(MapleItem(sidecar: sidecar,
                                           parentImageBase: base,
                                           parentIdentifier: containerIdentifier))
                }
```

- [ ] **Step 2: Build**

```bash
cd src/apple && xcodebuild -project Maple.xcodeproj -scheme Maple -destination 'platform=macOS,arch=arm64' build 2>&1 | grep -E "^\*\*|error:" | tail -3
```

Expected: `** BUILD SUCCEEDED **`.

- [ ] **Step 3: Commit**

```bash
git add src/apple/MapleFileProvider/MapleEnumerator.swift
git commit -m "feat(fileprovider): FolderEnumerator emits sidecars alongside images"
```

---

## Task 10: Client — `FileProviderExtension` write methods

**Files:**
- Modify: `src/apple/MapleFileProvider/FileProviderExtension.swift`

- [ ] **Step 1: Add a stored device-name property to the extension**

In `FileProviderExtension.swift`, find the stored properties block at the top of `final class FileProviderExtension` and add `private let deviceName: String` next to `private let dormant: Bool`.

Find the `required init(domain:)` method and add right after `super.init()` in the happy path (the path that sets `dormant = false`):

```swift
        self.deviceName = ProcessInfo.processInfo.hostName
```

Hold on — `deviceName` needs to be initialised on both paths (dormant and not). Update `required init(domain:)` to initialise `deviceName` regardless:

Locate the dormant-path block:
```swift
        guard let cfg = config.load(domain: domain.identifier.rawValue) else {
            self.dormant = true
            self.catalog = nil
            self.rootCache = nil
            super.init()
            log.notice("init dormant — no config for domain \(domain.identifier.rawValue, privacy: .public)")
            return
        }
```

Replace with:
```swift
        let deviceName = ProcessInfo.processInfo.hostName
        guard let cfg = config.load(domain: domain.identifier.rawValue) else {
            self.dormant = true
            self.catalog = nil
            self.rootCache = nil
            self.deviceName = deviceName
            super.init()
            log.notice("init dormant — no config for domain \(domain.identifier.rawValue, privacy: .public)")
            return
        }
```

Then locate the happy-path final assignments (right before `super.init()`):
```swift
        let catalog = RemoteCatalog(http: http, server: cfg.serverURL)
        self.dormant = false
        self.catalog = catalog
        self.rootCache = LibraryRootCache(catalog: catalog)
        super.init()
        log.info("init domain=\(domain.identifier.rawValue, privacy: .public)")
```

Replace with:
```swift
        let catalog = RemoteCatalog(http: http, server: cfg.serverURL)
        self.dormant = false
        self.catalog = catalog
        self.rootCache = LibraryRootCache(catalog: catalog)
        self.deviceName = deviceName
        super.init()
        log.info("init domain=\(domain.identifier.rawValue, privacy: .public)")
```

- [ ] **Step 2: Replace `createItem`, `modifyItem`, `deleteItem`**

Locate the three stub methods (`func createItem`, `func modifyItem`, `func deleteItem`) at the bottom of the class. Replace ALL THREE methods with:

```swift
    // MARK: - XMP write paths

    func createItem(basedOn itemTemplate: NSFileProviderItem,
                    fields: NSFileProviderItemFields,
                    contents url: URL?,
                    options: NSFileProviderCreateItemOptions = [],
                    request: NSFileProviderRequest,
                    completionHandler: @escaping (NSFileProviderItem?, NSFileProviderItemFields, Bool, Error?) -> Void) -> Progress {
        if dormant {
            completionHandler(nil, [], false, notAuthenticatedError())
            return Progress()
        }
        guard let catalog = self.catalog else {
            completionHandler(nil, [], false, notAuthenticatedError())
            return Progress()
        }
        // Only XMP sidecars are writable in Phase 2. Determine the target
        // asset ID by matching the template filename's base against the
        // parent folder's image listing.
        let filename = itemTemplate.filename
        guard filename.lowercased().hasSuffix(".xmp"),
              let contentsURL = url else {
            completionHandler(nil, [], false,
                NSError(domain: NSCocoaErrorDomain, code: NSFeatureUnsupportedError))
            return Progress()
        }
        let progress = Progress(totalUnitCount: 1)
        Task {
            defer { progress.completedUnitCount = 1 }
            do {
                let xmpBytes = try Data(contentsOf: contentsURL)
                let parentID = itemTemplate.parentItemIdentifier
                guard let assetID = try await self.assetID(forSidecarNamed: filename,
                                                            in: parentID,
                                                            catalog: catalog) else {
                    completionHandler(nil, [], false,
                        NSError(domain: NSFileProviderErrorDomain,
                                code: NSFileProviderError.noSuchItem.rawValue))
                    return
                }
                let result = try await catalog.putXMP(
                    assetID: assetID,
                    data: xmpBytes,
                    ifMtimeMatches: nil,
                    deviceName: self.deviceName
                )
                switch result {
                case .ok(let mtime):
                    let synthesized = SidecarChild(
                        name: filename,
                        path: filename, // path isn't load-bearing for the item
                        mtime: mtime,
                        size: Int64(xmpBytes.count),
                        assetID: assetID
                    )
                    let baseFromFilename = filename.hasSuffix(".xmp")
                        ? String(filename.dropLast(4)) : filename
                    let item = MapleItem(sidecar: synthesized,
                                         parentImageBase: baseFromFilename,
                                         parentIdentifier: parentID)
                    completionHandler(item, [], false, nil)
                case .conflict(let conflictPath, _):
                    self.log.notice("createItem conflict — server wrote to \(conflictPath, privacy: .public)")
                    completionHandler(nil, [], false,
                        NSError(domain: NSFileProviderErrorDomain,
                                code: NSFileProviderError.filenameCollision.rawValue))
                    await self.signalEnumeratorReload()
                }
            } catch {
                self.log.error("createItem failed: \(error.localizedDescription, privacy: .public)")
                completionHandler(nil, [], false, error)
            }
        }
        return progress
    }

    func modifyItem(_ item: NSFileProviderItem,
                    baseVersion version: NSFileProviderItemVersion,
                    changedFields: NSFileProviderItemFields,
                    contents newContents: URL?,
                    options: NSFileProviderModifyItemOptions = [],
                    request: NSFileProviderRequest,
                    completionHandler: @escaping (NSFileProviderItem?, NSFileProviderItemFields, Bool, Error?) -> Void) -> Progress {
        if dormant {
            completionHandler(nil, [], false, notAuthenticatedError())
            return Progress()
        }
        guard let catalog = self.catalog else {
            completionHandler(nil, [], false, notAuthenticatedError())
            return Progress()
        }
        // Only handle sidecar identifiers. Everything else (e.g. RAW or
        // folder modifications) stays unsupported.
        let parsed: FileProviderIdentifier
        do { parsed = try FileProviderIdentifier(rawValue: item.itemIdentifier.rawValue) }
        catch {
            completionHandler(nil, [], false,
                NSError(domain: NSCocoaErrorDomain, code: NSFeatureUnsupportedError))
            return Progress()
        }
        guard case .sidecar(let assetID, _) = parsed,
              let contentsURL = newContents else {
            completionHandler(nil, [], false,
                NSError(domain: NSCocoaErrorDomain, code: NSFeatureUnsupportedError))
            return Progress()
        }
        // Decode the prior mtime from the version's contentVersion field.
        let priorMtime: Date? = {
            guard let s = String(data: version.contentVersion, encoding: .utf8),
                  let epoch = Int(s), epoch > 0 else { return nil }
            return Date(timeIntervalSince1970: TimeInterval(epoch))
        }()
        let progress = Progress(totalUnitCount: 1)
        Task {
            defer { progress.completedUnitCount = 1 }
            do {
                let xmpBytes = try Data(contentsOf: contentsURL)
                let result = try await catalog.putXMP(
                    assetID: assetID,
                    data: xmpBytes,
                    ifMtimeMatches: priorMtime,
                    deviceName: self.deviceName
                )
                switch result {
                case .ok(let mtime):
                    let synthesized = SidecarChild(
                        name: item.filename,
                        path: item.filename,
                        mtime: mtime,
                        size: Int64(xmpBytes.count),
                        assetID: assetID
                    )
                    let baseFromFilename = item.filename.hasSuffix(".xmp")
                        ? String(item.filename.dropLast(4)) : item.filename
                    let updatedItem = MapleItem(sidecar: synthesized,
                                                parentImageBase: baseFromFilename,
                                                parentIdentifier: item.parentItemIdentifier)
                    completionHandler(updatedItem, [], false, nil)
                case .conflict(let conflictPath, _):
                    self.log.notice("modifyItem conflict — server wrote to \(conflictPath, privacy: .public)")
                    completionHandler(nil, [], false,
                        NSError(domain: NSFileProviderErrorDomain,
                                code: NSFileProviderError.filenameCollision.rawValue))
                    await self.signalEnumeratorReload()
                }
            } catch {
                self.log.error("modifyItem failed: \(error.localizedDescription, privacy: .public)")
                completionHandler(nil, [], false, error)
            }
        }
        return progress
    }

    func deleteItem(identifier: NSFileProviderItemIdentifier,
                    baseVersion version: NSFileProviderItemVersion,
                    options: NSFileProviderDeleteItemOptions = [],
                    request: NSFileProviderRequest,
                    completionHandler: @escaping (Error?) -> Void) -> Progress {
        if dormant {
            completionHandler(notAuthenticatedError())
            return Progress()
        }
        guard let catalog = self.catalog else {
            completionHandler(notAuthenticatedError())
            return Progress()
        }
        let parsed: FileProviderIdentifier
        do { parsed = try FileProviderIdentifier(rawValue: identifier.rawValue) }
        catch {
            completionHandler(NSError(domain: NSCocoaErrorDomain, code: NSFeatureUnsupportedError))
            return Progress()
        }
        guard case .sidecar(let assetID, _) = parsed else {
            // RAWs and folders are not deletable.
            completionHandler(NSError(domain: NSCocoaErrorDomain, code: NSFeatureUnsupportedError))
            return Progress()
        }
        let progress = Progress(totalUnitCount: 1)
        Task {
            defer { progress.completedUnitCount = 1 }
            do {
                try await catalog.deleteXMP(assetID: assetID)
                completionHandler(nil)
            } catch {
                self.log.error("deleteItem failed: \(error.localizedDescription, privacy: .public)")
                completionHandler(error)
            }
        }
        return progress
    }

    // MARK: - Sidecar helpers

    /// Find the asset whose RAW filename (without extension) matches the
    /// sidecar's canonical base. Returns nil if no matching image is in
    /// the enumeration response for the parent folder.
    private func assetID(forSidecarNamed filename: String,
                         in parentID: NSFileProviderItemIdentifier,
                         catalog: RemoteCatalog) async throws -> String? {
        guard let rootCache = self.rootCache else { return nil }
        let parsed = try FileProviderIdentifier(rawValue: parentID.rawValue)
        guard case .folder(let folderID, let relativePath) = parsed else { return nil }
        let roots = try await rootCache.roots()
        guard let root = roots.first(where: { $0.id == folderID }) else { return nil }
        let absolutePath = relativePath.isEmpty ? root.path : "\(root.path)/\(relativePath)"
        let contents = try await catalog.listDir(absolutePath: absolutePath)
        // Strip ".xmp" and the optional "(conflict from <device>)" suffix.
        let canonicalBase = Self.canonicalBase(forSidecarFilename: filename)
        for img in contents.images {
            guard let assetID = img.assetID else { continue }
            let dot = img.name.lastIndex(of: ".")
            let imgBase = dot.map { String(img.name[..<$0]) } ?? img.name
            if imgBase == canonicalBase { return assetID }
        }
        return nil
    }

    /// Strip the `.xmp` extension and an optional `" (conflict from …)"`
    /// suffix from a sidecar filename, mirroring the server-side regex
    /// in `canonicalBaseFromSidecarFilename`.
    static func canonicalBase(forSidecarFilename name: String) -> String {
        var s = name
        if s.lowercased().hasSuffix(".xmp") { s = String(s.dropLast(4)) }
        // Suffix form: "<base> (conflict from <device>)".
        if let openParen = s.range(of: " (conflict from "),
           s.hasSuffix(")") {
            s = String(s[..<openParen.lowerBound])
        }
        return s
    }

    private func signalEnumeratorReload() async {
        guard let mgr = NSFileProviderManager(for: domain) else { return }
        try? await mgr.signalEnumerator(for: .rootContainer)
    }
```

- [ ] **Step 3: Build**

```bash
cd src/apple && xcodebuild -project Maple.xcodeproj -scheme Maple -destination 'platform=macOS,arch=arm64' build 2>&1 | grep -E "^\*\*|error:" | tail -5
```

Expected: `** BUILD SUCCEEDED **`.

- [ ] **Step 4: Run the existing client tests**

```bash
cd src/apple/Packages/MapleCore && swift test --filter FileProvider 2>&1 | grep -E "Executed.*tests" | tail -3
```

Expected: all FileProvider tests still pass (no regressions).

- [ ] **Step 5: Commit**

```bash
git add src/apple/MapleFileProvider/FileProviderExtension.swift
git commit -m "feat(fileprovider): implement createItem / modifyItem / deleteItem for XMP sidecars"
```

---

## Manual verification (one-time, requires a running server + Lightroom or curl)

This validates the end-to-end XMP flow that Phase 2 enables. The unit + API tests cover the code paths; this step proves the FP extension wires through correctly. Skip on CI; required pre-merge.

1. **Start the API** with a folder registered, containing at least one indexed RAW:
   ```bash
   cd src/api && bun run dev
   ```
2. **Build + install Maple** locally, sign in, enable the server in Settings → Finder.
3. **Materialize one RAW** by Quick-Looking it once in Finder — this ensures the asset is indexed.
4. **Test plain XMP write** via `curl` (faster than driving Lightroom):
   ```bash
   curl -X PUT \
        -H "Content-Type: text/plain" \
        -H "X-Maple-Device-Name: test-curl" \
        --data-binary '<x:xmpmeta>hello</x:xmpmeta>' \
        http://localhost:3000/api/assets/<asset-id>/xmp -i
   ```
   Expected: `204` + `Last-Modified` header.
5. **Confirm the sidecar appears in Finder.** Re-enumerate the folder (click out and back in). `IMG_1.xmp` should appear next to `IMG_1.ARW` with a cloud icon.
6. **Test conflict copy.** Read the current mtime from `stat` on the sidecar, subtract 100 seconds, PUT with that wrong precondition:
   ```bash
   curl -X PUT \
        -H "Content-Type: text/plain" \
        -H "X-Maple-Device-Name: device-B" \
        -H "X-If-Mtime-Matches: 1" \
        --data-binary '<x:xmpmeta>from-B</x:xmpmeta>' \
        http://localhost:3000/api/assets/<asset-id>/xmp -i
   ```
   Expected: `409` + JSON body with `conflict_path`. `<base> (conflict from device-B).xmp` appears on disk.
7. **Re-enumerate the folder in Finder.** Both `IMG_1.xmp` and `IMG_1 (conflict from device-B).xmp` should be visible.
8. **Test delete via Finder.** Drag the conflict copy to the Trash → should disappear from Finder and from the server filesystem.

Steps 4–8 cover the write paths. The full Lightroom integration test (modify rating, save, observe in Maple) is the highest-confidence test but is left for human verification because it requires a Lightroom install.

---

## Self-review

- ✅ **Spec coverage:**
  - Architecture overview / 1. Server enumeration → Tasks 3, 4
  - Architecture overview / 2. Server write path → Tasks 1, 2, 5
  - Architecture overview / 3. Client write paths → Tasks 6, 7, 8, 9, 10
  - Identifier scheme (canonical + conflict) → Task 6
  - Device name → Task 10
  - Conflict resolution user flow → Task 10's `signalEnumeratorReload`
  - Error handling matrix → Tasks 2 (server side) + 10 (client side)
  - Testing strategy → Tasks 4, 5 (server) + Tasks 6, 7 (client unit) + manual verification section
  - Performance invariants → no render-path code touched (verified by virtue of files modified)

- ✅ **Placeholder scan:** no TBD/TODO/incomplete sections.

- ✅ **Type consistency:**
  - `XMPWriteResult` defined in Task 7, used in Task 10. ✓
  - `SidecarChild` defined in Task 7, used in Tasks 8, 9, 10. ✓
  - `FileProviderIdentifier.sidecar(assetID:conflictBasename:)` defined in Task 6, used in Tasks 8, 10. ✓
  - `canonicalBaseFromSidecarFilename` (server) in Task 3 mirrors `canonicalBase(forSidecarFilename:)` (client) in Task 10. ✓

- ✅ **Phase boundary:** no rename/move, no working-set, no push channel, no iOS code touched.
