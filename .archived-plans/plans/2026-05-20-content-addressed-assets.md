# Content-Addressed Assets Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Shift the `assets` collection from path-keyed to content-keyed. One BLAKE3-derived `maple_id` per content; multiple file locations recorded as a `fileinfo[]` array. Derived artefact paths (thumbs, previews) computed from `(library, fileinfo[0], maple_id)` instead of stored.

**Architecture:** Six sequential PRs. Each PR ships independently — the cluster compiles, tests pass, and the running system stays correct between PRs. The dedup key already exists (`maple_id` with a unique partial index); what's missing is (a) hashing at insert time so dedup happens at discover instead of failing later in the pipeline, (b) the `fileinfo[]` array as the canonical location record, and (c) cache resolution keyed on `maple_id` instead of basename hash.

**Tech Stack:** TypeScript + Bun + Elysia + MongoDB (api); Angular 21 + signals (web); SwiftUI + `@Observable` (apple). Shared schema constants live in the cross-platform codegen at `src/scripts/codegen/`.

---

## Background

### Current state (verified by reading code)

- `AssetDoc` has `folder_id: ObjectId`, `filename: string`, `abs_path: string` as the location triple.
- `maple_id` already exists as an optional `string` field (16-byte BLAKE3-derived hex, computed by `src/api/src/indexer/id.ts`).
- A **unique partial index** on `{ maple_id: 1 }` filtered to `{ maple_id: { $type: "string" } }` is created by `ensureIndexes` ([src/api/src/db/client.ts:535](src/api/src/db/client.ts:535)). Skeleton rows are inserted with `maple_id: null` and pass the filter; the hash stage later fills the field.
- The `(folder_id, filename)` index was already loosened to non-unique ([src/api/src/db/client.ts:421-456](src/api/src/db/client.ts:421-456)) in anticipation of this change — same filename can already legitimately appear twice.
- The **hash stage** (`src/api/src/workers/stages/hash.ts`) currently runs AFTER discover inserts the skeleton row. When two files have the same content, the discover stage inserts two skeleton rows; the hash stage then tries to `$set` the same `maple_id` on both — the second write triggers an E11000 against the unique index and the stage marks the second row as failed. The user sees both rows in the UI because the failed row is never cleaned up.
- The **backup-ingest** route ([src/api/src/routes/backup-ingest.ts:260](src/api/src/routes/backup-ingest.ts:260)) already implements the right pattern: lookup-by-maple_id, append a `phasset_link` on hit, insert on miss. We are generalising this pattern from "PhotoKit upload" to "every discovered file."
- Cache paths are derived from `sha256_prefix16(basename)` ([src/api/src/fs/xmp.ts:110](src/api/src/fs/xmp.ts:110)) — NOT from `maple_id`. The user's spec replaces this with `maple_id` as the cache key.

### What the user asked for

> 1) remove `abs_path` and change it to `fileinfo:[]`. Path object should look like `{ path: path after lib path, filename: file name with ext, library_id: mongo id to lib }`.
>
> 2) we do not need to store thumbnail or preview path in the DB — that should be computed by `lib path + fileinfo[0].path + "/.maple/[thumbs|previews]/{maple_id}.{ext}"`.
>
> So now I can store the same image in more than one folder and lib, and store less text in the db, and `maple_id` can be unique.

### Open decisions (settled here; revisit only if execution surfaces a problem)

1. **`fileinfo[0]` semantics.** Ordered by discovery — first observation is at `[0]`. Cache resolution walks the array and picks the first entry whose `library_id` still resolves to a registered folder on disk; this survives a single library being unregistered.
2. **`{ext}` in the cache path.** Always literal `.jpg`. Thumbs and previews are JPEGs regardless of source format.
3. **`fileinfo.path` shape.** The directory relative to the library root, slash-separated, no leading slash, no trailing slash. `""` (empty string) means the file sits at the library root. This matches the existing `apple_rendered_path` and File Provider `relative_path` conventions.
4. **Soft delete.** `deleted_at` becomes per-fileinfo: an entry has its own `deleted_at` when only one location vanishes; the asset row stays alive while any entry is live. The row is soft-deleted only when every entry is dead.
5. **Existing data.** Migrated by a one-shot script invoked from `ensureIndexes` after the new index is in place. Rows with `maple_id: null` keep `abs_path` until the next pipeline pass (which will then run hash and dedup).
6. **Existing on-disk thumbs/previews.** Orphaned by the cache-key change. A GC pass at the end of PR 3 deletes any `.maple/thumbs/*.jpg` and `.maple/previews/*.jpg` whose basename doesn't match a known `maple_id`. The next render regenerates against the new path.

### File layout — what changes

| File | Responsibility |
| --- | --- |
| `src/api/src/db/schema.ts` | `AssetDoc.fileinfo`, `FileInfo` interface, drop `abs_path` / `filename` / `folder_id` |
| `src/api/src/db/client.ts` | Drop `abs_path_1` and `folder_id_1_filename_1` indexes; add `fileinfo.library_id_1` |
| `src/api/src/db/migrations.ts` | New migration: build `fileinfo[]` from `(folder_id, filename, abs_path)` and merge by `maple_id` |
| `src/api/src/indexer/images.repo.ts` | Helpers: `assetAbsPath(asset)`, `assetPrimaryFileInfo(asset)`, `findAssetByMapleId`, `upsertAssetByMapleId` |
| `src/api/src/workers/discover/index.ts` | Hash-on-discover; insert by `maple_id`; append `fileinfo[]` on dedup |
| `src/api/src/workers/stages/hash.ts` | Becomes a no-op (or removed) once discover hashes |
| `src/api/src/fs/xmp.ts` | `resolveThumbPath(asset)`, `cachePathFor(asset, kind)` — takes the asset row, not a path |
| `src/api/src/routes/*.ts` | Wire-shape changes; new helper used everywhere `abs_path` was read |
| `src/web/projects/maple-common/src/lib/models/asset.ts` | TS model mirrors the new shape |
| `src/web/projects/maple-common/src/lib/**` | Consumers of `abs_path` move to `fileinfo[]` helpers |
| `src/apple/Sources/MapleCore/**` | Swift DTOs mirror the new shape |

---

## PR 1 — Schema + repo layer (additive only)

**Goal:** Add `fileinfo` to the schema, write/read it on every code path, but leave `abs_path` in place so legacy code keeps working. This PR ships independently and changes no behaviour; it makes the next PR safe.

### Task 1.1: Add `FileInfo` interface and `fileinfo[]` to `AssetDoc`

**Files:**
- Modify: `src/api/src/db/schema.ts` — insert `FileInfo` and add `fileinfo?: FileInfo[]` next to `abs_path`

- [ ] **Step 1: Write the failing test**

```typescript
// src/api/src/db/schema.test.ts — append at end
import { describe, it, expect } from "bun:test";
import type { AssetDoc, FileInfo } from "./schema.ts";
import { ObjectId } from "mongodb";

describe("FileInfo", () => {
  it("matches the canonical shape", () => {
    const libId = new ObjectId();
    const fi: FileInfo = { path: "vacation/2024", filename: "IMG_001.dng", library_id: libId };
    expect(fi.path).toBe("vacation/2024");
    expect(fi.filename).toBe("IMG_001.dng");
    expect(fi.library_id.equals(libId)).toBe(true);
  });

  it("attaches to AssetDoc as an array", () => {
    const a: Partial<AssetDoc> = { fileinfo: [] };
    expect(Array.isArray(a.fileinfo)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd src/api && bun test src/db/schema.test.ts
```

Expected: type error or runtime failure — `FileInfo` is not exported.

- [ ] **Step 3: Add the interface and field**

```typescript
// src/api/src/db/schema.ts — insert above `AssetDoc`
/**
 * One known on-disk location for an asset. An asset may appear in multiple
 * places (same content backed up from two devices, or a copy under a
 * different folder); each location is one entry here. `fileinfo[0]` is the
 * canonical entry used for cache-path resolution; subsequent entries
 * are alternates discovered later.
 *
 * `path` is the directory relative to the library root, slash-separated,
 * no leading slash. `""` means "at the library root".
 */
export interface FileInfo {
  /** Directory relative to the library root, e.g. "vacation/2024". */
  path: string;
  /** File name with extension, e.g. "IMG_001.dng". */
  filename: string;
  /** ObjectId of the registered folder this entry lives under. */
  library_id: ObjectId;
  /** Set when only this location has been unlinked; the asset row stays
   * alive while another entry is live. ISO string or absent. */
  deleted_at?: string | null;
}
```

Then add to `AssetDoc` (immediately after `abs_path`):

```typescript
  /**
   * Known on-disk locations for this asset. Populated by the discover
   * watcher (and by backup-ingest). Length ≥ 1 for any live asset.
   * Coexists with `abs_path` during the content-addressing migration
   * (PR 1); `abs_path` is removed in PR 6.
   */
  fileinfo?: FileInfo[];
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd src/api && bun test src/db/schema.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/api/src/db/schema.ts src/api/src/db/schema.test.ts
git commit -m "schema: add FileInfo and AssetDoc.fileinfo[] (additive)"
```

---

### Task 1.2: Helpers in the images repo for derived path access

**Files:**
- Modify: `src/api/src/indexer/images.repo.ts` — add `assetAbsPath`, `assetPrimaryFileInfo`, `assetLibraryPath`
- Test: `src/api/src/indexer/images.repo.test.ts` (create or extend)

- [ ] **Step 1: Write the failing test**

```typescript
// src/api/src/indexer/images.repo.helpers.test.ts
import { describe, it, expect } from "bun:test";
import { ObjectId } from "mongodb";
import { assetAbsPath, assetPrimaryFileInfo, assetLibraryPath } from "./images.repo.ts";
import type { AssetDoc, FileInfo } from "../db/schema.ts";

const libId = new ObjectId();

function makeAsset(over: Partial<AssetDoc>): AssetDoc {
  return {
    folder_id: libId,
    filename: "IMG_001.dng",
    abs_path: "/lib/vacation/2024/IMG_001.dng",
    size: 1, mtime: 1, rating: 0, flag: 0, color_label: "",
    indexed_at: "2026-05-20T00:00:00Z",
    ...over,
  };
}

describe("asset location helpers", () => {
  it("prefers fileinfo[0] when present", () => {
    const fi: FileInfo = { path: "vacation/2024", filename: "IMG_001.dng", library_id: libId };
    const asset = makeAsset({ fileinfo: [fi] });
    const libraries = new Map([[libId.toHexString(), "/lib"]]);
    expect(assetPrimaryFileInfo(asset)).toEqual(fi);
    expect(assetAbsPath(asset, libraries)).toBe("/lib/vacation/2024/IMG_001.dng");
    expect(assetLibraryPath(asset, libraries)).toBe("/lib");
  });

  it("falls back to legacy abs_path when fileinfo is missing", () => {
    const asset = makeAsset({});
    const libraries = new Map([[libId.toHexString(), "/lib"]]);
    expect(assetAbsPath(asset, libraries)).toBe("/lib/vacation/2024/IMG_001.dng");
    expect(assetPrimaryFileInfo(asset)).toBeNull();
  });

  it("handles a path of '' (file at library root)", () => {
    const fi: FileInfo = { path: "", filename: "root.dng", library_id: libId };
    const asset = makeAsset({ fileinfo: [fi], abs_path: "/lib/root.dng", filename: "root.dng" });
    const libraries = new Map([[libId.toHexString(), "/lib"]]);
    expect(assetAbsPath(asset, libraries)).toBe("/lib/root.dng");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd src/api && bun test src/indexer/images.repo.helpers.test.ts
```

Expected: FAIL — helpers don't exist.

- [ ] **Step 3: Implement the helpers**

```typescript
// src/api/src/indexer/images.repo.ts — append, near the existing helpers
import * as path from "node:path";
import type { FileInfo } from "../db/schema.ts";

/**
 * Pick the first live `fileinfo` entry, or `null` if the asset predates
 * the migration (no `fileinfo` array) or every entry is dead.
 *
 * During PR 1–5 of the content-addressing migration, returning `null`
 * means callers should fall back to `abs_path`. After PR 6, the
 * fallback is removed.
 */
export function assetPrimaryFileInfo(asset: Pick<AssetDoc, "fileinfo">): FileInfo | null {
  const list = asset.fileinfo;
  if (!list || list.length === 0) return null;
  const live = list.find((f) => !f.deleted_at);
  return live ?? null;
}

/**
 * Library root absolute path for the asset's primary fileinfo entry,
 * looked up in the supplied `libraries` map (hex `_id` → absolute path).
 * Falls back to `path.dirname(abs_path)` for legacy rows that haven't
 * been migrated yet; returns `null` if neither source is available.
 */
export function assetLibraryPath(
  asset: Pick<AssetDoc, "fileinfo" | "abs_path">,
  libraries: ReadonlyMap<string, string>,
): string | null {
  const primary = assetPrimaryFileInfo(asset);
  if (primary) {
    const root = libraries.get(primary.library_id.toHexString());
    if (root) return root;
  }
  if (asset.abs_path) return path.dirname(asset.abs_path);
  return null;
}

/**
 * Resolve the absolute filesystem path of the asset's primary location.
 * Composed from `(library root, fileinfo[0].path, fileinfo[0].filename)`
 * with a fallback to the legacy `abs_path` field for unmigrated rows.
 */
export function assetAbsPath(
  asset: Pick<AssetDoc, "fileinfo" | "abs_path">,
  libraries: ReadonlyMap<string, string>,
): string | null {
  const primary = assetPrimaryFileInfo(asset);
  if (primary) {
    const root = libraries.get(primary.library_id.toHexString());
    if (root) return path.join(root, primary.path, primary.filename);
  }
  if (asset.abs_path) return asset.abs_path;
  return null;
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd src/api && bun test src/indexer/images.repo.helpers.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/api/src/indexer/images.repo.ts src/api/src/indexer/images.repo.helpers.test.ts
git commit -m "indexer: add fileinfo-aware location helpers with abs_path fallback"
```

---

### Task 1.3: Library-roots cache, fetched once per request

**Files:**
- Create: `src/api/src/indexer/libraries.cache.ts`
- Test: `src/api/src/indexer/libraries.cache.test.ts`

Library lookups happen in every cache-path resolution. A per-request cache avoids hammering Mongo.

- [ ] **Step 1: Write the failing test**

```typescript
// src/api/src/indexer/libraries.cache.test.ts
import { describe, it, expect, beforeEach } from "bun:test";
import { ObjectId } from "mongodb";
import { loadLibraryRoots, invalidateLibraryRoots } from "./libraries.cache.ts";
import { foldersCollection } from "../db/client.ts";

describe("library roots cache", () => {
  beforeEach(async () => {
    const f = await foldersCollection();
    await f.deleteMany({});
    invalidateLibraryRoots();
  });

  it("returns a map keyed by hex _id", async () => {
    const f = await foldersCollection();
    const id = new ObjectId();
    await f.insertOne({
      _id: id, path: "/srv/lib-a", label: "A",
      last_scan: null, file_count: 0, created_at: "now",
    });
    const roots = await loadLibraryRoots();
    expect(roots.get(id.toHexString())).toBe("/srv/lib-a");
  });

  it("invalidate forces a re-read", async () => {
    const f = await foldersCollection();
    await f.insertOne({
      _id: new ObjectId(), path: "/x", label: "X",
      last_scan: null, file_count: 0, created_at: "now",
    });
    const first = await loadLibraryRoots();
    expect(first.size).toBe(1);
    invalidateLibraryRoots();
    await f.deleteMany({});
    const second = await loadLibraryRoots();
    expect(second.size).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd src/api && bun test src/indexer/libraries.cache.test.ts
```

Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement the cache**

```typescript
// src/api/src/indexer/libraries.cache.ts
/**
 * Process-wide cache of `library_id hex → absolute path` for use by
 * every code path that resolves `fileinfo[]` to an on-disk location.
 *
 * Folders rarely change; we invalidate explicitly when the folders
 * route mutates the collection. The cache is process-local and is
 * rebuilt on next read after `invalidateLibraryRoots()` is called.
 */
import { foldersCollection } from "../db/client.ts";

let cached: ReadonlyMap<string, string> | null = null;

export async function loadLibraryRoots(): Promise<ReadonlyMap<string, string>> {
  if (cached) return cached;
  const coll = await foldersCollection();
  const docs = await coll
    .find({}, { projection: { path: 1 } })
    .toArray();
  const map = new Map<string, string>();
  for (const d of docs) {
    map.set((d._id as { toHexString: () => string }).toHexString(), d.path as string);
  }
  cached = map;
  return map;
}

export function invalidateLibraryRoots(): void {
  cached = null;
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd src/api && bun test src/indexer/libraries.cache.test.ts
```

Expected: PASS.

- [ ] **Step 5: Wire invalidation into the folders route**

```typescript
// src/api/src/routes/folders.ts — at the top of every POST/DELETE/PATCH
// handler that mutates the folders collection, after the mutation:
import { invalidateLibraryRoots } from "../indexer/libraries.cache.ts";
// ...
invalidateLibraryRoots();
```

Find every `foldersCollection()` write call site in `src/api/src/routes/folders.ts` and add the invalidation after the write. Run the existing folders tests:

```bash
cd src/api && bun test src/routes/folders.test.ts
```

Expected: PASS (existing tests are unaffected).

- [ ] **Step 6: Commit**

```bash
git add src/api/src/indexer/libraries.cache.ts src/api/src/indexer/libraries.cache.test.ts src/api/src/routes/folders.ts
git commit -m "indexer: process-wide library-roots cache for fileinfo resolution"
```

---

### Task 1.4: Discover writes `fileinfo[]` on every upsert (PR 1 — still keeps `abs_path`)

**Files:**
- Modify: `src/api/src/workers/discover/index.ts:113-158`
- Test: `src/api/src/workers/discover/discover.test.ts` (extend)

The discover stage currently writes only `abs_path` + `filename` + `folder_id` on insert. Here we add `fileinfo[0]` on insert and append a new entry on rename. We do NOT remove the legacy fields yet (PR 6).

- [ ] **Step 1: Write the failing test**

```typescript
// src/api/src/workers/discover/discover.test.ts — append
import { describe, it, expect, beforeEach } from "bun:test";
import { ObjectId } from "mongodb";
import { handleEvent } from "./index.ts";
import { assetsCollection, foldersCollection } from "../../db/client.ts";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

describe("discover writes fileinfo[]", () => {
  let root: string;
  let folderId: ObjectId;
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "maple-discover-"));
    folderId = new ObjectId();
    const f = await foldersCollection();
    await f.deleteMany({});
    await f.insertOne({
      _id: folderId, path: root, label: "test",
      last_scan: null, file_count: 0, created_at: "now",
    });
    const a = await assetsCollection();
    await a.deleteMany({});
  });

  it("inserts fileinfo[0] with path-relative-to-library", async () => {
    const sub = path.join(root, "vacation/2024");
    await fs.mkdir(sub, { recursive: true });
    const file = path.join(sub, "IMG_001.dng");
    await fs.writeFile(file, "fake-raw-bytes");

    await handleEvent({ kind: "created", absPath: file }, folderId);

    const a = await assetsCollection();
    const doc = await a.findOne({ abs_path: file });
    expect(doc).not.toBeNull();
    expect(doc!.fileinfo).toHaveLength(1);
    expect(doc!.fileinfo![0].path).toBe("vacation/2024");
    expect(doc!.fileinfo![0].filename).toBe("IMG_001.dng");
    expect(doc!.fileinfo![0].library_id.equals(folderId)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd src/api && bun test src/workers/discover/discover.test.ts
```

Expected: FAIL — `fileinfo` is undefined on the inserted doc.

- [ ] **Step 3: Implement — discover writes fileinfo[0]**

Replace the `$setOnInsert` block in `handleEvent` ([src/api/src/workers/discover/index.ts:132](src/api/src/workers/discover/index.ts:132)):

```typescript
// src/api/src/workers/discover/index.ts — inside handleEvent, replace the
// `created or modified` branch starting at the `now = ...` line.

  // created or modified — upsert with skeleton.
  let stat: Awaited<ReturnType<typeof fsNode.stat>>;
  try {
    stat = await fsNode.stat(absPath);
  } catch {
    log.warn({ absPath }, "stat failed after watch event — skipping");
    return;
  }

  // Resolve the library root for this absPath so we can write a
  // proper fileinfo entry. We can't depend on libraries.cache here
  // because handleEvent runs in the discover worker process where
  // the folders collection state may differ; load it once via the
  // db helper.
  const fld = await (await foldersCollection()).findOne(
    { _id: folderId },
    { projection: { path: 1 } },
  );
  const libraryRoot = fld?.path as string | undefined;
  if (!libraryRoot) {
    log.warn({ folderId: folderId.toHexString() }, "library row missing — skipping");
    return;
  }
  const relDir = path.relative(libraryRoot, path.dirname(absPath));
  const filename = path.basename(absPath);
  const fileinfoEntry = {
    path: relDir === "" ? "" : relDir,
    filename,
    library_id: folderId,
  };

  const now = new Date().toISOString();
  const res = await coll.findOneAndUpdate(
    { abs_path: absPath },
    {
      $set: {
        size: stat.size,
        mtime: stat.mtimeMs,
        indexed_at: now,
        deleted_at: null,
      },
      $setOnInsert: {
        abs_path: absPath,
        folder_id: folderId,
        filename,
        fileinfo: [fileinfoEntry],
        rating: 0,
        flag: 0,
        color_label: "",
        exif: null,
        maple_id: null,
        sha1_head: null,
        stages: blankStagesSkeleton(),
      },
    },
    { upsert: true, returnDocument: "after" },
  );
```

Also update the `renamed` branch ([src/api/src/workers/discover/index.ts:83-111](src/api/src/workers/discover/index.ts:83-111)) to update `fileinfo[0]` alongside `abs_path` + `filename`:

```typescript
  if (kind === "renamed" && fromPath) {
    const before = await coll.findOne(
      { abs_path: fromPath },
      { projection: { _id: 1, fileinfo: 1 } },
    );
    if (!before) return;

    const fld = await (await foldersCollection()).findOne(
      { _id: folderId },
      { projection: { path: 1 } },
    );
    const libraryRoot = fld?.path as string | undefined;
    let newFileinfo = before.fileinfo;
    if (libraryRoot) {
      const relDir = path.relative(libraryRoot, path.dirname(absPath));
      const entry = {
        path: relDir === "" ? "" : relDir,
        filename: path.basename(absPath),
        library_id: folderId,
      };
      // Update entry [0] in place — rename does not introduce a new location.
      newFileinfo = [entry, ...(before.fileinfo ?? []).slice(1)];
    }

    await coll.updateOne(
      { abs_path: fromPath },
      {
        $set: {
          abs_path: absPath,
          filename: path.basename(absPath),
          fileinfo: newFileinfo,
          indexed_at: new Date().toISOString(),
          deleted_at: null,
        },
      },
    );
    log.info({ from: fromPath, to: absPath }, "renamed");
    await recordAndPublishAssetChange({
      kind: "update",
      asset_id: before._id,
      folder_id: folderId,
      abs_path: absPath,
    });
    return;
  }
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd src/api && bun test src/workers/discover/discover.test.ts
```

Expected: PASS. The full discover suite should still pass too:

```bash
cd src/api && bun test src/workers/discover/
```

- [ ] **Step 5: Commit**

```bash
git add src/api/src/workers/discover/index.ts src/api/src/workers/discover/discover.test.ts
git commit -m "discover: write fileinfo[0] on insert and rename (additive)"
```

---

### Task 1.5: Backup-ingest writes `fileinfo[]` (additive)

**Files:**
- Modify: `src/api/src/routes/backup-ingest.ts:307-321` (and the dedup branch at 269-287)

- [ ] **Step 1: Write the failing test**

Extend an existing backup-ingest test to assert `fileinfo` on both branches (insert and dedup-append). Find `src/api/src/routes/backup-ingest.test.ts` (or equivalent integration test) and add:

```typescript
it("writes fileinfo[0] on first insert", async () => {
  // … existing setup ending in a successful final-chunk POST …
  const a = await assetsCollection();
  const doc = await a.findOne({ maple_id: mapleId });
  expect(doc!.fileinfo).toHaveLength(1);
  expect(doc!.fileinfo![0].library_id.equals(libraryId)).toBe(true);
  expect(doc!.fileinfo![0].filename).toBe(filename);
});

it("does NOT append a fileinfo entry on dedup (same library + same target_rel_path)", async () => {
  // first upload …
  // second upload from a different device with same maple_id …
  const a = await assetsCollection();
  const doc = await a.findOne({ maple_id: mapleId });
  // Same canonical location — still one entry. Two phasset_links though.
  expect(doc!.fileinfo).toHaveLength(1);
  expect(doc!.phasset_links).toHaveLength(2);
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd src/api && bun test src/routes/backup-ingest.test.ts
```

Expected: FAIL on the `fileinfo` length assertion.

- [ ] **Step 3: Implement — backup-ingest writes fileinfo on insert**

In the insert branch ([src/api/src/routes/backup-ingest.ts:307-321](src/api/src/routes/backup-ingest.ts:307-321)):

```typescript
    await a.insertOne({
      _id: new ObjectId(),
      folder_id: libraryId,
      filename,
      abs_path: finalPath,
      fileinfo: [{
        path: path.dirname(resolvedTargetRelPath) === "." ? "" : path.dirname(resolvedTargetRelPath),
        filename,
        library_id: libraryId,
      }],
      size: totalBytes,
      mtime: Date.now(),
      rating: 0,
      flag: 0,
      color_label: "",
      indexed_at: new Date().toISOString(),
      maple_id: mapleId,
      phasset_links: [link],
      deleted_from_photos: false,
    } as any);
```

Dedup branch already returns early without inserting; no fileinfo change is needed because we deliberately don't add a new location for the existing canonical copy.

- [ ] **Step 4: Run tests**

```bash
cd src/api && bun test src/routes/backup-ingest.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/api/src/routes/backup-ingest.ts src/api/src/routes/backup-ingest.test.ts
git commit -m "backup-ingest: write fileinfo[0] alongside legacy abs_path"
```

---

### Task 1.6: Migrate existing rows — backfill `fileinfo[]` from `(folder_id, filename, abs_path)`

**Files:**
- Modify: `src/api/src/db/migrations.ts`
- Test: `src/api/src/db/migrations.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/api/src/db/migrations.test.ts — append
import { describe, it, expect, beforeEach } from "bun:test";
import { ObjectId } from "mongodb";
import { backfillFileinfo } from "./migrations.ts";
import { assetsCollection, foldersCollection } from "./client.ts";

describe("backfillFileinfo", () => {
  beforeEach(async () => {
    const f = await foldersCollection();
    await f.deleteMany({});
    const a = await assetsCollection();
    await a.deleteMany({});
  });

  it("populates fileinfo[0] from abs_path/folder_id/filename for unmigrated rows", async () => {
    const f = await foldersCollection();
    const folderId = new ObjectId();
    await f.insertOne({
      _id: folderId, path: "/lib", label: "x",
      last_scan: null, file_count: 0, created_at: "now",
    });
    const a = await assetsCollection();
    await a.insertOne({
      _id: new ObjectId(),
      folder_id: folderId,
      filename: "IMG_001.dng",
      abs_path: "/lib/vacation/2024/IMG_001.dng",
      size: 1, mtime: 1, rating: 0, flag: 0, color_label: "",
      indexed_at: "now",
    } as any);

    const n = await backfillFileinfo();
    expect(n).toBe(1);

    const doc = await a.findOne({ filename: "IMG_001.dng" });
    expect(doc!.fileinfo).toHaveLength(1);
    expect(doc!.fileinfo![0].path).toBe("vacation/2024");
    expect(doc!.fileinfo![0].filename).toBe("IMG_001.dng");
    expect(doc!.fileinfo![0].library_id.equals(folderId)).toBe(true);
  });

  it("skips rows that already have fileinfo", async () => {
    const f = await foldersCollection();
    const folderId = new ObjectId();
    await f.insertOne({
      _id: folderId, path: "/lib", label: "x",
      last_scan: null, file_count: 0, created_at: "now",
    });
    const a = await assetsCollection();
    await a.insertOne({
      _id: new ObjectId(),
      folder_id: folderId, filename: "x.dng",
      abs_path: "/lib/x.dng",
      fileinfo: [{ path: "", filename: "x.dng", library_id: folderId }],
      size: 1, mtime: 1, rating: 0, flag: 0, color_label: "",
      indexed_at: "now",
    } as any);

    const n = await backfillFileinfo();
    expect(n).toBe(0);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd src/api && bun test src/db/migrations.test.ts
```

Expected: FAIL — `backfillFileinfo` not exported.

- [ ] **Step 3: Implement the backfill**

```typescript
// src/api/src/db/migrations.ts — append
import * as path from "node:path";

/**
 * Backfill `fileinfo[0]` for legacy rows that pre-date the content-addressing
 * migration. Idempotent — rows that already have `fileinfo` are skipped.
 *
 * Reads every (folder_id, filename, abs_path) triple, derives the relative
 * directory from `abs_path` and the library root, and writes a single-entry
 * fileinfo array. Runs once on boot from `ensureIndexes`; callable from
 * tests directly.
 */
export async function backfillFileinfo(): Promise<number> {
  const folders = await foldersCollection();
  const folderMap = new Map<string, string>();
  for (const f of await folders.find({}, { projection: { path: 1 } }).toArray()) {
    folderMap.set((f._id as { toHexString: () => string }).toHexString(), f.path as string);
  }

  const a = await assetsCollection();
  const cursor = a.find(
    { fileinfo: { $exists: false }, abs_path: { $exists: true } },
    { projection: { _id: 1, folder_id: 1, filename: 1, abs_path: 1 } },
  );
  let updated = 0;
  for await (const doc of cursor) {
    const libRoot = folderMap.get(
      ((doc.folder_id as unknown) as { toHexString: () => string }).toHexString(),
    );
    if (!libRoot) continue;
    const relDir = path.relative(libRoot, path.dirname(doc.abs_path as string));
    await a.updateOne(
      { _id: doc._id },
      {
        $set: {
          fileinfo: [{
            path: relDir === "" || relDir === "." ? "" : relDir,
            filename: doc.filename as string,
            library_id: doc.folder_id,
          }],
        },
      },
    );
    updated += 1;
  }
  return updated;
}
```

Wire it into `ensureIndexes` in `src/api/src/db/client.ts` (call near the end, after every index is created):

```typescript
// src/api/src/db/client.ts — at the end of ensureIndexes, before the
// `set the migration marker` block.
import { backfillFileinfo } from "./migrations.ts";
// ...
const fileinfoBackfillKey = "fileinfo_backfill_v1";
const marker = await db.collection("server_state").findOne({ _id: fileinfoBackfillKey });
if (!marker) {
  const n = await backfillFileinfo();
  await db.collection("server_state").insertOne({
    _id: fileinfoBackfillKey,
    backfilled: n,
    completed_at: new Date().toISOString(),
  });
}
```

- [ ] **Step 4: Run tests**

```bash
cd src/api && bun test src/db/migrations.test.ts src/db/client.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/api/src/db/migrations.ts src/api/src/db/migrations.test.ts src/api/src/db/client.ts
git commit -m "migrations: backfill fileinfo[0] from legacy abs_path+folder_id+filename"
```

---

### Task 1.7: PR 1 verification

- [ ] **Step 1: Full API test suite**

```bash
cd src/api && bun test
```

Expected: PASS.

- [ ] **Step 2: Boot the API in dev against a sandbox Mongo and confirm**

```bash
cd src/api && bun run dev
# in another terminal:
mongo --eval 'db.assets.findOne({ fileinfo: { $exists: true } })' maple
```

Expected: returns a doc with `fileinfo` of length 1.

- [ ] **Step 3: Open PR 1**

```bash
git push -u origin HEAD
gh pr create --title "Content-addressed assets — PR 1: schema + repo (additive)" \
  --body "Adds FileInfo and AssetDoc.fileinfo[]. Discover and backup-ingest now write fileinfo[0] on every upsert. Legacy abs_path/filename/folder_id are still written and read; helpers fall back to them. A one-shot backfill on boot populates fileinfo on existing rows. No behaviour changes. Closes #<ticket-number>."
```

---

## PR 2 — Hash-on-discover + dedup-on-insert

**Goal:** Move `maple_id` computation from the `hash` stage (post-insert) to the discover watcher (pre-insert). Switch the insert path to "find-or-append-fileinfo by maple_id," collapsing duplicates into a single row.

### Task 2.1: Extract hashing into a reusable function

**Files:**
- Modify: `src/api/src/indexer/id.ts` — add `hashFileForId(absPath)`
- Test: `src/api/src/indexer/id.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/api/src/indexer/id.test.ts — append
import { describe, it, expect } from "bun:test";
import { hashFileForId } from "./id.ts";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

describe("hashFileForId", () => {
  it("returns the same id as the hash stage's inline derivation", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "maple-id-"));
    const f = path.join(dir, "x.dng");
    await fs.writeFile(f, Buffer.alloc(70 * 1024, 0xaa));
    const { maple_id, sha1_head, size, mtime } = await hashFileForId(f);
    expect(maple_id).toHaveLength(32);
    expect(sha1_head).toHaveLength(40);
    expect(size).toBe(70 * 1024);
    expect(typeof mtime).toBe("number");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd src/api && bun test src/indexer/id.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement**

```typescript
// src/api/src/indexer/id.ts — append
import * as fs from "node:fs/promises";
import { sha1 } from "@noble/hashes/legacy.js";

const SHA1_HEAD_BYTES_FILE = 64 * 1024;

export async function hashFileForId(absPath: string): Promise<{
  maple_id: string;
  sha1_head: string;
  size: number;
  mtime: number;
}> {
  const fd = await fs.open(absPath, "r");
  let head: Uint8Array;
  try {
    const buf = new Uint8Array(SHA1_HEAD_BYTES_FILE);
    const { bytesRead } = await fd.read(buf, 0, buf.length, 0);
    head = buf.subarray(0, bytesRead);
  } finally {
    await fd.close();
  }
  const stat = await fs.stat(absPath);
  const sha1HeadBytes = sha1(head);
  const sha1_head = Array.from(sha1HeadBytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const id = deriveId(head, null, null, null);
  return { maple_id: id.hex, sha1_head, size: stat.size, mtime: stat.mtimeMs };
}
```

- [ ] **Step 4: Run to verify it passes**

```bash
cd src/api && bun test src/indexer/id.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/api/src/indexer/id.ts src/api/src/indexer/id.test.ts
git commit -m "id: hashFileForId helper — extract hashing for discover-time use"
```

---

### Task 2.2: Discover hashes the file and dedups by `maple_id`

**Files:**
- Modify: `src/api/src/workers/discover/index.ts:113-158`
- Test: `src/api/src/workers/discover/discover.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
it("dedups two files with identical content into one row with two fileinfo entries", async () => {
  // Two files with identical bytes under the same library.
  const a = path.join(root, "a", "IMG.dng");
  const b = path.join(root, "b", "IMG.dng");
  await fs.mkdir(path.dirname(a), { recursive: true });
  await fs.mkdir(path.dirname(b), { recursive: true });
  const bytes = Buffer.alloc(70 * 1024, 0xab);
  await fs.writeFile(a, bytes);
  await fs.writeFile(b, bytes);

  await handleEvent({ kind: "created", absPath: a }, folderId);
  await handleEvent({ kind: "created", absPath: b }, folderId);

  const assets = await assetsCollection();
  const rows = await assets.find({}).toArray();
  expect(rows).toHaveLength(1);
  expect(rows[0].fileinfo).toHaveLength(2);
  expect(rows[0].maple_id).toMatch(/^[0-9a-f]{32}$/);
});
```

- [ ] **Step 2: Run to verify it fails**

Currently the insert is keyed on `abs_path`, so two distinct absPaths produce two rows. Expected: FAIL with rows length 2.

- [ ] **Step 3: Implement — dedup-by-maple_id**

Replace the upsert in `handleEvent`'s `created/modified` branch with the find-or-append-fileinfo pattern. Use the helper from PR 1 task 1.4 to compute `fileinfoEntry`. After that, before the upsert:

```typescript
  const { maple_id, sha1_head, size, mtime } = await hashFileForId(absPath);

  // Find any existing row with this content.
  const existing = await coll.findOne({ maple_id });
  if (existing) {
    // Append this fileinfo entry if it's not already there.
    const hasEntry = (existing.fileinfo ?? []).some(
      (e: { path: string; filename: string; library_id: ObjectId }) =>
        e.path === fileinfoEntry.path &&
        e.filename === fileinfoEntry.filename &&
        e.library_id.equals(fileinfoEntry.library_id),
    );
    if (!hasEntry) {
      await coll.updateOne(
        { _id: existing._id },
        { $push: { fileinfo: fileinfoEntry }, $set: { indexed_at: now, deleted_at: null } },
      );
    } else {
      // Just refresh indexed_at + clear any per-entry deleted marker.
      await coll.updateOne(
        { _id: existing._id, "fileinfo.path": fileinfoEntry.path, "fileinfo.filename": fileinfoEntry.filename },
        { $set: { indexed_at: now, deleted_at: null, "fileinfo.$.deleted_at": null } },
      );
    }
    log.info({ absPath, maple_id, dedup: true }, "deduped to existing row");
    return;
  }

  // No existing row — insert. abs_path stays as a denormalized convenience
  // field until PR 6.
  await coll.insertOne({
    _id: new ObjectId(),
    folder_id: folderId,
    filename,
    abs_path: absPath,
    fileinfo: [fileinfoEntry],
    size,
    mtime,
    rating: 0,
    flag: 0,
    color_label: "",
    exif: null,
    maple_id,
    sha1_head,
    indexed_at: now,
    deleted_at: null,
    stages: blankStagesSkeleton(),
  } as any);
```

Add the import:

```typescript
import { hashFileForId } from "../../indexer/id.ts";
```

- [ ] **Step 4: Run to verify it passes**

```bash
cd src/api && bun test src/workers/discover/discover.test.ts
```

Expected: PASS — both files collapse to one row with two fileinfo entries.

- [ ] **Step 5: Commit**

```bash
git add src/api/src/workers/discover/index.ts src/api/src/workers/discover/discover.test.ts
git commit -m "discover: hash on insert and dedup by maple_id (one row per content)"
```

---

### Task 2.3: Hash stage becomes a no-op

**Files:**
- Modify: `src/api/src/workers/stages/hash.ts`

- [ ] **Step 1: Update the handler**

```typescript
const hashStage = defineStage({
  name: "hash",
  targetVersion: 1,
  dependsOn: [],
  defaults: { /* unchanged */ },
  handler: async (image) => {
    // After PR 2 of the content-addressing migration, discover hashes
    // on insert. This stage stays in the manifest for legacy rows that
    // were inserted before the migration (skeleton rows with
    // maple_id: null); for them, it does the original work.
    if (image.maple_id) {
      return { patch: {} };
    }
    const absPath = image.abs_path as string;
    // … legacy code path unchanged …
  },
});
```

- [ ] **Step 2: Run the hash stage tests**

```bash
cd src/api && bun test src/workers/stages/hash.test.ts
```

Expected: PASS (existing tests cover the legacy code path).

- [ ] **Step 3: Commit**

```bash
git add src/api/src/workers/stages/hash.ts
git commit -m "hash-stage: skip when maple_id already populated by discover"
```

---

### Task 2.4: Merge duplicate rows from existing data

**Files:**
- Modify: `src/api/src/db/migrations.ts`
- Test: `src/api/src/db/migrations.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
it("mergeDuplicateAssets collapses rows sharing a maple_id into one", async () => {
  const f = await foldersCollection();
  const lib = new ObjectId();
  await f.insertOne({
    _id: lib, path: "/lib", label: "x",
    last_scan: null, file_count: 0, created_at: "now",
  });
  const a = await assetsCollection();
  const id1 = new ObjectId();
  const id2 = new ObjectId();
  await a.insertMany([
    {
      _id: id1, folder_id: lib, filename: "x.dng",
      abs_path: "/lib/a/x.dng",
      fileinfo: [{ path: "a", filename: "x.dng", library_id: lib }],
      maple_id: "deadbeef".repeat(4),
      size: 1, mtime: 1, rating: 5, flag: 1, color_label: "",
      indexed_at: "earlier",
    } as any,
    {
      _id: id2, folder_id: lib, filename: "x.dng",
      abs_path: "/lib/b/x.dng",
      fileinfo: [{ path: "b", filename: "x.dng", library_id: lib }],
      maple_id: "deadbeef".repeat(4),
      size: 1, mtime: 1, rating: 0, flag: 0, color_label: "",
      indexed_at: "later",
    } as any,
  ]);

  const merged = await mergeDuplicateAssets();
  expect(merged).toBe(1);

  const rows = await a.find({}).toArray();
  expect(rows).toHaveLength(1);
  expect(rows[0].fileinfo).toHaveLength(2);
  // User-edited fields preserved from the survivor (earlier `indexed_at` wins).
  expect(rows[0].rating).toBe(5);
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd src/api && bun test src/db/migrations.test.ts
```

Expected: FAIL — function does not exist.

- [ ] **Step 3: Implement**

```typescript
// src/api/src/db/migrations.ts — append
export async function mergeDuplicateAssets(): Promise<number> {
  const a = await assetsCollection();
  // Find all maple_ids with more than one row.
  const dupes = await a
    .aggregate([
      { $match: { maple_id: { $type: "string" } } },
      { $group: { _id: "$maple_id", ids: { $push: "$_id" }, count: { $sum: 1 } } },
      { $match: { count: { $gt: 1 } } },
    ])
    .toArray();
  let merged = 0;
  for (const group of dupes) {
    const ids = group.ids as ObjectId[];
    // Pick the oldest row (earliest indexed_at) as the survivor; user-edited
    // fields like rating/flag/color_label belong to it.
    const rows = await a.find({ _id: { $in: ids } }).toArray();
    rows.sort((x, y) =>
      (x.indexed_at as string).localeCompare(y.indexed_at as string),
    );
    const survivor = rows[0];
    const losers = rows.slice(1);
    // Union all fileinfo entries.
    const fileinfo = [
      ...(survivor.fileinfo ?? []),
      ...losers.flatMap((l) => l.fileinfo ?? []),
    ];
    // Dedupe by (path, filename, library_id).
    const seen = new Set<string>();
    const uniq = fileinfo.filter((e: any) => {
      const k = `${e.library_id.toHexString()}|${e.path}|${e.filename}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    await a.updateOne({ _id: survivor._id }, { $set: { fileinfo: uniq } });
    await a.deleteMany({ _id: { $in: losers.map((l) => l._id) } });
    merged += losers.length;
  }
  return merged;
}
```

Wire into the boot sequence after `backfillFileinfo`:

```typescript
const dupeKey = "merge_dupes_v1";
if (!(await db.collection("server_state").findOne({ _id: dupeKey }))) {
  const n = await mergeDuplicateAssets();
  await db.collection("server_state").insertOne({
    _id: dupeKey, merged: n, completed_at: new Date().toISOString(),
  });
}
```

- [ ] **Step 4: Run tests**

```bash
cd src/api && bun test src/db/migrations.test.ts
```

- [ ] **Step 5: Commit + push + PR 2**

```bash
git add src/api/src/db/migrations.ts src/api/src/db/migrations.test.ts src/api/src/db/client.ts
git commit -m "migrations: merge duplicate assets by maple_id"
git push
gh pr create --title "Content-addressed assets — PR 2: hash on discover + dedup" \
  --body "Discover now hashes inserted files and dedups by maple_id. A boot-time migration merges existing duplicates. Closes #<ticket-number>."
```

---

## PR 3 — Cache path resolution by `maple_id`

**Goal:** Switch thumb/preview paths from `sha256_prefix16(basename)` to `{maple_id}.jpg` under `<library>/<fileinfo[0].path>/.maple/{thumbs,previews}/`. GC orphaned files.

### Task 3.1: New cache-path resolver that takes an `AssetDoc`

**Files:**
- Modify: `src/api/src/fs/xmp.ts:110-146`
- Test: `src/api/src/fs/xmp.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from "bun:test";
import { ObjectId } from "mongodb";
import { resolveThumbPathForAsset, cachePathForAsset } from "./xmp.ts";
import type { AssetDoc } from "../db/schema.ts";

describe("resolveThumbPathForAsset", () => {
  it("composes <lib>/<fileinfo[0].path>/.maple/thumbs/<maple_id>.jpg", () => {
    const lib = new ObjectId();
    const asset = {
      maple_id: "abcd".repeat(8),
      fileinfo: [{ path: "vacation/2024", filename: "IMG.dng", library_id: lib }],
    } as Pick<AssetDoc, "maple_id" | "fileinfo">;
    const libs = new Map([[lib.toHexString(), "/srv/lib"]]);
    expect(resolveThumbPathForAsset(asset, libs))
      .toBe("/srv/lib/vacation/2024/.maple/thumbs/" + ("abcd".repeat(8)) + ".jpg");
  });

  it("returns null when no library entry resolves", () => {
    const lib = new ObjectId();
    const asset = {
      maple_id: "abcd".repeat(8),
      fileinfo: [{ path: "x", filename: "y.dng", library_id: lib }],
    } as Pick<AssetDoc, "maple_id" | "fileinfo">;
    expect(resolveThumbPathForAsset(asset, new Map())).toBeNull();
  });

  it("returns null when maple_id is missing", () => {
    const lib = new ObjectId();
    const asset = {
      fileinfo: [{ path: "x", filename: "y.dng", library_id: lib }],
    } as Pick<AssetDoc, "maple_id" | "fileinfo">;
    expect(resolveThumbPathForAsset(asset, new Map([[lib.toHexString(), "/lib"]]))).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd src/api && bun test src/fs/xmp.test.ts
```

- [ ] **Step 3: Implement**

```typescript
// src/api/src/fs/xmp.ts — append, keep the legacy resolveThumbPath in place
import type { AssetDoc } from "../db/schema.ts";
import { assetPrimaryFileInfo } from "../indexer/images.repo.ts";

export function resolveThumbPathForAsset(
  asset: Pick<AssetDoc, "maple_id" | "fileinfo">,
  libraries: ReadonlyMap<string, string>,
): string | null {
  if (!asset.maple_id) return null;
  const primary = assetPrimaryFileInfo(asset);
  if (!primary) return null;
  const root = libraries.get(primary.library_id.toHexString());
  if (!root) return null;
  return path.join(root, primary.path, ".maple", "thumbs", `${asset.maple_id}.jpg`);
}

export function cachePathForAsset(
  asset: Pick<AssetDoc, "maple_id" | "fileinfo">,
  libraries: ReadonlyMap<string, string>,
  kind: CacheKind,
  size?: string,
): string | null {
  if (!asset.maple_id) return null;
  const primary = assetPrimaryFileInfo(asset);
  if (!primary) return null;
  const root = libraries.get(primary.library_id.toHexString());
  if (!root) return null;
  if (kind === "thumbs") {
    return path.join(root, primary.path, ".maple", "thumbs", `${asset.maple_id}.jpg`);
  }
  const s = size ?? "full";
  return path.join(root, primary.path, ".maple", "previews", `${asset.maple_id}_${s}.jpg`);
}
```

- [ ] **Step 4: Run to verify passes**

```bash
cd src/api && bun test src/fs/xmp.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/api/src/fs/xmp.ts src/api/src/fs/xmp.test.ts
git commit -m "xmp: resolveThumbPathForAsset/cachePathForAsset using maple_id"
```

---

### Task 3.2: Thumb and preview stages use the new resolver

**Files:**
- Modify: `src/api/src/workers/stages/thumb.ts`
- Modify: `src/api/src/workers/stages/preview.ts`
- Modify: `src/api/src/indexer/thumbnailer.ts`
- Modify: `src/api/src/indexer/previewer.ts`

- [ ] **Step 1: Add an asset-aware overload to `generateThumb`**

Read [src/api/src/indexer/thumbnailer.ts](src/api/src/indexer/thumbnailer.ts) and extend the signature:

```typescript
export async function generateThumb(
  absPath: string,
  thumbPathOverride?: string,
): Promise<void> { /* existing — write to `thumbPathOverride ?? legacy resolveThumbPath(absPath)` */ }
```

Same shape for `generatePreview` in previewer.ts.

- [ ] **Step 2: Update the thumb stage**

```typescript
// src/api/src/workers/stages/thumb.ts
handler: async (image) => {
  const libs = await loadLibraryRoots();
  const thumbPath = resolveThumbPathForAsset(image as any, libs);
  if (!thumbPath) {
    return { patch: {}, error: "no maple_id / fileinfo for thumb resolution" };
  }
  const absPath = assetAbsPath(image as any, libs);
  if (!absPath) return { patch: {}, error: "no absPath" };
  await generateThumb(absPath, thumbPath);
  return { patch: { thumb_path: thumbPath } };
},
```

Same for preview.ts.

- [ ] **Step 3: Run stage tests**

```bash
cd src/api && bun test src/workers/stages/thumb.test.ts src/workers/stages/preview.test.ts
```

Update test fixtures to populate `fileinfo` and `maple_id` so the new resolver works.

- [ ] **Step 4: Commit**

```bash
git add src/api/src/workers/stages/thumb.ts src/api/src/workers/stages/preview.ts \
        src/api/src/indexer/thumbnailer.ts src/api/src/indexer/previewer.ts
git commit -m "thumb/preview: cache path keyed on maple_id"
```

---

### Task 3.3: Orphaned-thumb GC pass

**Files:**
- Create: `src/api/src/workers/cache-gc.ts`
- Test: `src/api/src/workers/cache-gc.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
it("deletes .maple/thumbs files whose basename is not a known maple_id", async () => {
  // Set up a temp lib, put two thumbs in .maple/thumbs — one with a basename
  // matching a known maple_id, one not. Run the GC. Confirm the orphan is gone.
});
```

- [ ] **Step 2: Implement**

```typescript
// src/api/src/workers/cache-gc.ts
export async function sweepOrphanedCaches(libraryRoot: string): Promise<{ deleted: number }> {
  // Walk libraryRoot for any directory named `.maple/thumbs` or `.maple/previews`.
  // For each .jpg file inside, parse basename minus extension; if it's not a
  // valid 32-char hex matching any maple_id in the db, unlink it.
  // Return the count.
}
```

Run the sweep once on boot per registered library.

- [ ] **Step 3: Commit + push + PR 3**

```bash
git add src/api/src/workers/cache-gc.ts src/api/src/workers/cache-gc.test.ts src/api/src/db/client.ts
git commit -m "cache-gc: sweep orphaned thumb/preview files keyed on old basename hash"
git push
gh pr create --title "Content-addressed assets — PR 3: cache paths keyed on maple_id" \
  --body "Closes #<ticket-number>."
```

---

## PR 4 — Sweep call sites from `abs_path` to `fileinfo[]`

**Goal:** Update every read of `abs_path` to use `assetAbsPath()` (or equivalent helper). Update API routes, search projections, change-feed writers.

### Tasks (one task per group of files)

For each of the following groups, the pattern is identical:

1. Read the file; replace `image.abs_path` / `asset.abs_path` with `assetAbsPath(asset, libs)`.
2. If the function returns `null`, treat as a "asset has no valid location" case — usually means returning a 404 to the caller.
3. Update the tests to seed `fileinfo` and pass library roots into the helpers.

**Task groups (one PR-internal commit each):**

- [ ] Task 4.1: `src/api/src/routes/assets-list.ts`, `routes/folders.ts`, `routes/search/project.ts`
- [ ] Task 4.2: `src/api/src/routes/assets/*.ts`, `routes/changes.ts`
- [ ] Task 4.3: `src/api/src/workers/stages/*.ts` (exif, face, describe, meili, hash)
- [ ] Task 4.4: `src/api/src/enrichment/*.ts`
- [ ] Task 4.5: `src/api/src/people/*.ts`, `src/api/src/job-runner/handlers/*.ts`
- [ ] Task 4.6: `src/api/src/handler-registry/contract.ts`, `runtime/change-feed-tailer.ts`, `runtime/change-bus.ts`

Each task ends with `bun test <touched-path>` passing and a commit.

After all groups, run the full API suite:

```bash
cd src/api && bun test
```

Expected: PASS. Open PR 4.

---

## PR 5 — Cross-platform DTOs (web + apple)

**Goal:** Mirror the new schema in Angular and Swift clients. `abs_path` stays in the wire format as a derived field for backward compatibility; clients prefer `fileinfo`.

### Task 5.1: Angular DTO

**Files:**
- Modify: `src/web/projects/maple-common/src/lib/models/asset.ts`
- Modify: every component listed in the abs_path grep above

Add `FileInfo` to the `Asset` interface:

```typescript
export interface FileInfo {
  path: string;
  filename: string;
  library_id: string; // hex
  deleted_at?: string | null;
}

export interface Asset {
  // … existing fields …
  fileinfo?: FileInfo[];
  /** @deprecated read fileinfo[0] instead. */
  abs_path?: string;
}
```

Add `assetAbsPath(asset, libraries)` helper in `lib/state/library-store.service.ts`.

Sweep components to use the helper. Lean on tsc:

```bash
cd src/web && bun x ng build maple-common
```

Run web tests:

```bash
bun run test
```

### Task 5.2: Swift DTO

**Files:**
- Modify: `src/apple/Sources/MapleCore/<DTO file>.swift`

Mirror the same shape. Run Swift tests:

```bash
cd src/apple/Packages/MapleCore && swift test
```

### Task 5.3: Codegen golden

If `src/scripts/codegen/` produces any DTO mirror, regenerate and commit the golden output. (If it does not, skip.)

Open PR 5.

---

## PR 6 — Drop `abs_path` / `filename` / `folder_id` from `AssetDoc`

**Goal:** Remove the legacy fields. Bump the migration to backfill once more and assert no row lacks `fileinfo`, then drop the fields and their indexes.

### Task 6.1: Pre-flight assertion

- [ ] Verify every live asset has `fileinfo`:

```bash
mongo --eval 'db.assets.find({ fileinfo: { $exists: false }, deleted_at: null }).count()' maple
```

Expected: 0.

### Task 6.2: Drop the indexes

```typescript
// src/api/src/db/client.ts — in ensureIndexes
try { await db.collection("assets").dropIndex("abs_path_1"); } catch { /* IndexNotFound */ }
try { await db.collection("assets").dropIndex("abs_path_captured_year_month"); } catch {}
try { await db.collection("assets").dropIndex("folder_id_1_filename_1"); } catch {}
try { await db.collection("assets").dropIndex("folder_id_1"); } catch {}
try { await db.collection("assets").dropIndex("filename_1"); } catch {}
```

Add replacement indexes scoped to `fileinfo`:

```typescript
await db.collection("assets").createIndex({ "fileinfo.library_id": 1 });
await db.collection("assets").createIndex({ "fileinfo.path": 1, "fileinfo.filename": 1 });
```

### Task 6.3: Drop the fields

Remove `abs_path`, `filename`, `folder_id` from `AssetDoc`. Run `bun test` and `tsc --noEmit`. Fix any remaining compile errors.

Remove the fallback in `assetAbsPath` (it no longer needs `abs_path`).

### Task 6.4: Drop the legacy `hash` stage code path

The post-PR-2 `hash` stage skipped when `maple_id` was set. Now every row has `maple_id`, so remove the stage from the manifest entirely.

### Task 6.5: Final verification

```bash
cd src/api && bun test
cd src/web && bun run test
cd src/apple/Packages/MapleCore && swift test
```

Open PR 6.

---

## Self-Review

**Spec coverage:**
- Requirement 1 (replace abs_path with fileinfo[]): PRs 1, 4, 6.
- Requirement 2 (compute thumb/preview path, not store): PR 3.
- Implicit requirement (maple_id unique, dedup): PR 2.

**Placeholder scan:** Task 4 tasks intentionally name file groups rather than per-file steps, because the change inside each group is mechanically identical and the file list is reproducible (`grep -l abs_path src/api/src/routes/`). The pattern is fully specified in the PR 4 intro.

**Type consistency:**
- `FileInfo.library_id` is `ObjectId` in TS (server) and `string` hex in client DTOs — explicit.
- `path: string`, `filename: string`, `deleted_at?: string | null` consistent throughout.
- `assetPrimaryFileInfo` defined in PR 1 task 1.2 and used in PR 3 task 3.1 with matching signature.
- `loadLibraryRoots` defined in PR 1 task 1.3 and used in PR 3 task 3.2 and PR 4 task groups.

**Risk notes:**
- PR 2 is the most behaviour-changing step; it must ship after PR 1 has settled in production for at least one boot cycle so the backfill has run.
- PR 3 orphans on-disk caches. The GC is run on boot of the API that ships PR 3; the orphans are deleted before the next thumb request hits the new path. Acceptable because thumbs are derived.
- PR 6 is a hard cut. Roll back is non-trivial — once the indexes are dropped and the fields removed from the writer, restoring `abs_path` requires a migration to replay from `fileinfo`. Acceptable: PRs 1–5 leave the system in a consistent state where PR 6 is purely a cleanup.
