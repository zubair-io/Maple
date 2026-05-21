# Maple File Provider — Phase 3 (Uploads + Soft-Delete Trash + Restore) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users drag photos *into* a Maple library through Finder (uploads) and drag indexed assets *to the Trash* (soft-delete), with the latter recoverable via a per-library "Trash" virtual folder visible at the root of the File Provider mount. Restore by dragging back; permanent purge by deleting from inside Trash or by the nightly GC after 30 days.

**Architecture:** Three new API endpoints (`POST /api/folders/:id/upload`, `DELETE /api/assets/:id`, `POST /api/assets/:id/restore`) + one new listing (`GET /api/folders/:id/trash`) + a small behavioural tweak to `GET /api/fs/dir` to hide trashed items. Server moves files atomically between the library root and `<root>/.maple/trash/`; sidecars travel with the asset using the Phase 2 conflict-aware filename grammar. The macOS extension implements `createItem` (uploads), wires `deleteItem` to the new DELETE endpoint, recognizes a restore-by-reparent in `modifyItem`, and exposes a new `TrashEnumerator` plus a `trash/<folderID>` identifier case. A new `trash-gc` interval-fired worker purges items where `deleted_at < now − 30d`.

**Tech Stack:** Bun + Elysia + MongoDB on the server, Swift 5.10 + FileProvider on macOS 14+. Reuses Phase 2 helpers (`canonicalBaseFromSidecarFilename`, `conflictCopyPath`, `pickFreeConflictPath`) and Phase 1 infrastructure (`FileProviderIdentifier`, `RemoteCatalog`, `LibraryRootCache`).

## Out of scope (deferred to later phases)

- **Rename / move-between-folders / in-place RAW modification** — Phase 6+.
- **Bulk-empty-trash route or UI** — explicitly excluded from Phase 3. Trash empties via per-item delete-from-trash or the 30-day GC.
- **Upload progress UI in the Maple app** — Finder's built-in status surface is the only progress signal in v1.
- **iOS uploads / deletes** — Phase 4 covers iOS read; iOS write is a Phase 4 follow-up.
- **Push change feed for upload completion** — Phase 5b.

This plan stops at "user drags files in, drags files to Trash, drags files back, sees them GC after 30 days." Phase 3 is the last writable surface before iOS work begins.

---

## Deviations from spec — intentional

Three places the spec is misaligned with the codebase as it landed in commit a4c8ac4. Resolved upfront so the implementer doesn't have to guess:

1. **Upload handler does NOT enqueue an `indexer_queue` row of type `enrich-file`.** That kind doesn't exist (`IndexerTaskDoc.kind = "scan_folder" | "gen_thumb" | "extract_exif"`). The current discover producer pattern (`src/api/src/workers/discover/index.ts` `handleEvent`) inserts the asset doc with `stages: blankStagesSkeleton()`, and the in-process stage controllers (hash → exif → thumb → face → ocr → describe → geocode → meili) poll and process it. The upload handler matches that pattern: insert the asset doc with `blankStagesSkeleton()` and `deleted_at: null`, return the new `_id`, let the stage controllers enrich asynchronously.

2. **`trash-gc` is NOT a `stageManifest` entry.** Stage controllers in `src/api/src/workers/stages/` are per-asset claim-and-process. `trash-gc` is library-wide, interval-fired, idempotent. It lives at `src/api/src/workers/trash-gc.ts` and is started by `index.ts` via `setInterval`, mirroring how `startDiscover` is launched from `startSupervisor`.

3. **`deleted_at` is already in use.** The discover watcher sets `deleted_at` on a `removed` filesystem event (the on-disk file vanished). To disambiguate trash-vs-vanished, the trash path also writes a new `original_path` field. Consumers that currently filter `deleted_at: null` (the Mongo `$text` search predicate, the meilisearch backfill) keep working unchanged — trashed assets stay invisible to search either way. The Trash listing explicitly requires `deleted_at != null` AND `original_path != null` so vanished assets don't accidentally appear in Trash.

The watcher already excludes `.maple/` via its dotfile filter (`src/api/src/indexer/watcher.ts` `ignored:` predicate: `if (base.startsWith(".")) return true`). No watcher changes are needed in this phase.

---

## File structure

**Modified (server):**
- `src/api/src/db/schema.ts` — `AssetDoc` gains optional `deleted_at?: string | null` and `original_path?: string | null` (documented, no runtime change — the fields already exist in practice for `deleted_at`)
- `src/api/src/fs/xmp.ts` — add `listPairedSidecars(rawAbsPath)` helper that returns the absolute paths of the canonical sidecar + every conflict copy + numbered variants
- `src/api/src/fs/browse.ts` — extend `listDirContents` to filter out files whose asset doc has `deleted_at != null` (so trashed RAWs don't appear under their original folder anymore)
- `src/api/src/routes/assets.ts` — add `DELETE /api/assets/:id` and `POST /api/assets/:id/restore`
- `src/api/src/routes/folders.ts` — add `POST /api/folders/:id/upload` and `GET /api/folders/:id/trash`
- `src/api/src/index.ts` — start the trash-gc worker via `setInterval` on boot, stop it on shutdown

**New (server):**
- `src/api/src/fs/trash.ts` — pure file-move logic shared by DELETE and restore (`moveToTrash(absPath, folderRoot)`, `moveOutOfTrash(trashPath, targetPath)`)
- `src/api/src/workers/trash-gc.ts` — interval-fired purge worker

**Modified (Swift core, `MapleCore`):**
- `src/apple/Packages/MapleCore/Sources/MapleCore/FileProvider/FileProviderIdentifier.swift` — add `case trash(folderID: String)` with `trash/<folderID>` encoding
- `src/apple/Packages/MapleCore/Sources/MapleCore/FileProvider/RemoteCatalog.swift` — add `upload(folderID:targetRelativePath:fileURL:mtime:)`, `deleteAsset(assetID:)`, `restoreAsset(assetID:targetRelativePath:)`, `listTrash(folderID:limit:cursor:)`; DTOs for the new response shapes

**New (Swift core, `MapleCore`):**
- *(none — all new client logic fits in existing files)*

**Modified (Swift extension, `MapleFileProvider`):**
- `src/apple/MapleFileProvider/FileProviderExtension.swift` — replace `createItem` body with the upload path; replace `deleteItem` body with the asset-trash path; extend `modifyItem` to recognize restore-by-reparent; extend `enumerator(for:)` to return a `TrashEnumerator` for `trash/<folderID>` identifiers
- `src/apple/MapleFileProvider/MapleEnumerator.swift` — extend `RootEnumerator` to emit a synthetic Trash item per library root; add a `TrashEnumerator` class
- `src/apple/MapleFileProvider/MapleItem.swift` — add a `MapleItem(trashContainer:displayName:)` initializer; add a `MapleItem(trashed:parentTrashIdentifier:)` initializer for items inside Trash

**Tests:**
- `src/api/tests/assets-upload.test.ts` — happy path, allowlist enforcement, path validation, overwrite refusal, concurrent uploads
- `src/api/tests/assets-delete-trash.test.ts` — DELETE moves file + sidecar(s), `deleted_at` set, idempotent on already-trashed, permanent purge on delete-from-trash
- `src/api/tests/assets-restore.test.ts` — restore to original path, restore to custom path, `.restored` suffix on collision
- `src/api/tests/folders-trash-list.test.ts` — paged listing, newest-first ordering
- `src/api/tests/fs-dir-excludes-trash.test.ts` — `GET /api/fs/dir` omits trashed assets
- `src/api/tests/trash-gc.test.ts` — purges only assets where `deleted_at < cutoff`; deletes both file and asset doc
- `src/api/tests/fs-xmp-list-paired-sidecars.test.ts` — `listPairedSidecars` returns canonical + every conflict variant; ignores unrelated files
- `src/apple/Packages/MapleCore/Tests/MapleCoreTests/FileProviderIdentifierTests.swift` — extend with trash/folder round-trip + rejection of `trash/` (empty folder ID)
- `src/apple/Packages/MapleCore/Tests/MapleCoreTests/RemoteCatalogTests.swift` — extend with decode tests for the trash-list and restore-response shapes

---

## Identifier scheme (updated from Phase 1 + 2)

| Conceptual item | Encoded form | Notes |
|---|---|---|
| Domain root | `NSFileProviderItemIdentifier.rootContainer` | Children = library roots **+ trash containers** |
| Library root folder | `folder/<folderID>:` | Unchanged |
| Subdirectory | `folder/<folderID>:<b64url-relpath>` | Unchanged |
| RAW asset (in folder OR in trash) | `asset/<assetID>` | Unchanged — identifier is stable across delete/restore |
| Canonical sidecar | `sidecar/<assetID>` | Phase 2 |
| Conflict-copy sidecar | `sidecar/<assetID>:<b64url-basename>` | Phase 2 |
| **Trash container** | **`trash/<folderID>`** | **New.** One per library root. Children = trashed asset items. |
| Working set | `workingSet` | Phase 5b. Empty in Phase 3. |

`FileProviderIdentifier.trash` round-trips through the existing prefix-strip pattern. Empty folder ID (`trash/`) rejects with `DecodeError.invalidPrefix` (no specific malformed-trash case is needed — the empty folder-ID check inside the asset/sidecar paths already throws `DecodeError.malformedSidecar`; trash will use a parallel `malformedTrash`).

---

## Task 1: Add `original_path` and document `deleted_at` semantics

**Files:**
- Modify: `src/api/src/db/schema.ts`

`deleted_at` is already written by the discover watcher (`workers/discover/index.ts:61`) on a `removed` filesystem event, but it's not declared on `AssetDoc`. Phase 3 introduces `original_path` to distinguish "user trashed via File Provider" from "file vanished from disk." We add both fields to the typed schema so callers stop casting through `unknown`.

- [ ] **Step 1: Add the fields to `AssetDoc`**

Open `src/api/src/db/schema.ts`. Find the `AssetDoc` interface (around line 73) and add these fields immediately after `maple_id`:

```ts
  /**
   * Soft-delete marker. Set by the discover watcher when a file vanishes
   * from disk (in which case `original_path` stays unset), AND by the
   * File Provider DELETE handler when a user drags an asset to Trash
   * (in which case `original_path` is also set). Trashed assets remain
   * indexed but are filtered out of folder listings and search results.
   */
  deleted_at?: string | null;
  /**
   * Pre-trash absolute path. Only set when a File Provider user
   * trashed the asset (distinct from a watcher-driven `removed`).
   * Read by the restore handler to compute the default target path,
   * and by `GET /api/folders/:id/trash` to surface the original
   * relative path to clients. Cleared on restore.
   */
  original_path?: string | null;
```

- [ ] **Step 2: Verify the rest of the codebase still type-checks**

```bash
cd src/api
bun test --bail src/db/schema.test.ts
```

Expected: existing schema tests still pass (the additions are optional fields).

- [ ] **Step 3: Commit**

```bash
git add src/api/src/db/schema.ts
git commit -m "feat(api): document deleted_at + add original_path on AssetDoc"
```

---

## Task 2: `listPairedSidecars` helper

**Files:**
- Modify: `src/api/src/fs/xmp.ts`
- Create: `src/api/tests/fs-xmp-list-paired-sidecars.test.ts`

The DELETE handler must move every sidecar paired to a RAW: the canonical `<base>.xmp`, every `<base> (conflict from <device>).xmp`, and every numbered variant `<base> (conflict from <device>) (N).xmp`. Phase 2 already has the matching regex inside `canonicalBaseFromSidecarFilename`; this helper inverts it.

- [ ] **Step 1: Write the failing test**

Write `src/api/tests/fs-xmp-list-paired-sidecars.test.ts`:

```ts
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { listPairedSidecars } from "../src/fs/xmp.ts";

let tmpRoot: string;

beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "maple-paired-sidecars-"));
  // RAW under test.
  await fs.writeFile(path.join(tmpRoot, "IMG_1.ARW"), "raw");
  // Sidecars to find.
  await fs.writeFile(path.join(tmpRoot, "IMG_1.xmp"), "canon");
  await fs.writeFile(path.join(tmpRoot, "IMG_1 (conflict from Mac-A).xmp"), "ca");
  await fs.writeFile(path.join(tmpRoot, "IMG_1 (conflict from Mac-A) (2).xmp"), "ca2");
  await fs.writeFile(path.join(tmpRoot, "IMG_1 (conflict from iPad).xmp"), "ip");
  // Sidecars that must NOT be picked up.
  await fs.writeFile(path.join(tmpRoot, "IMG_2.xmp"), "other");
  await fs.writeFile(path.join(tmpRoot, "IMG_1.txt"), "not xmp");
  await fs.writeFile(path.join(tmpRoot, "IMG_10.xmp"), "starts-with-IMG_1 but different");
});

afterAll(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe("listPairedSidecars", () => {
  test("returns canonical + all conflict variants for the given RAW", async () => {
    const got = await listPairedSidecars(path.join(tmpRoot, "IMG_1.ARW"));
    const names = got.map((p) => path.basename(p)).sort();
    expect(names).toEqual([
      "IMG_1 (conflict from Mac-A) (2).xmp",
      "IMG_1 (conflict from Mac-A).xmp",
      "IMG_1 (conflict from iPad).xmp",
      "IMG_1.xmp",
    ]);
  });

  test("returns empty when no sidecars exist", async () => {
    const raw = path.join(tmpRoot, "IMG_99.ARW");
    await fs.writeFile(raw, "x");
    const got = await listPairedSidecars(raw);
    expect(got).toEqual([]);
  });

  test("returns empty when the RAW's directory does not exist", async () => {
    const got = await listPairedSidecars("/no/such/dir/IMG_1.ARW");
    expect(got).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd src/api
bun test src/../tests/fs-xmp-list-paired-sidecars.test.ts
```

Expected: import failure — `listPairedSidecars` not exported.

- [ ] **Step 3: Implement `listPairedSidecars`**

Append to `src/api/src/fs/xmp.ts` (after `deleteConflictSidecar`):

```ts
/**
 * Return absolute paths of every XMP sidecar paired to the given RAW —
 * the canonical `<base>.xmp` plus every `<base> (conflict from <device>).xmp`
 * (with optional ` (N)` numeric suffix). Order is unspecified; callers that
 * care about ordering must sort.
 *
 * Reads the RAW's parent directory once and filters by name. Missing
 * directory or read errors return an empty array — the caller is moving
 * sidecars best-effort.
 */
export async function listPairedSidecars(rawAbsPath: string): Promise<string[]> {
  const dir = path.dirname(rawAbsPath);
  const rawBase = path.basename(rawAbsPath, path.extname(rawAbsPath));
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }
  // Anchored: name must START with `<rawBase>` followed by either `.xmp`
  // (canonical) or ` (conflict from <device>)` ... `.xmp` (variant). The
  // character after rawBase must NOT be another filename-char, otherwise
  // `IMG_1` would match `IMG_10.xmp`.
  const escaped = rawBase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(
    `^${escaped}( \\(conflict from [^)]+\\))?( \\(\\d+\\))?\\.xmp$`,
    "i",
  );
  return entries
    .filter((name) => pattern.test(name))
    .map((name) => path.join(dir, name));
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
bun test tests/fs-xmp-list-paired-sidecars.test.ts
```

Expected: 3 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/api/src/fs/xmp.ts src/api/tests/fs-xmp-list-paired-sidecars.test.ts
git commit -m "feat(api): listPairedSidecars helper for trash/restore"
```

---

## Task 3: Pure file-move helpers — `moveToTrash` and `moveOutOfTrash`

**Files:**
- Create: `src/api/src/fs/trash.ts`
- Create: `src/api/tests/fs-trash-move.test.ts`

Both DELETE and restore boil down to the same two-step: atomic-rename the RAW, then atomic-rename every paired sidecar. Pulling the move logic out of the route handlers keeps them readable and exposes a clean unit-test surface.

- [ ] **Step 1: Write the failing test**

Write `src/api/tests/fs-trash-move.test.ts`:

```ts
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { moveToTrash, moveOutOfTrash, computeTrashPath } from "../src/fs/trash.ts";

let tmpRoot: string;

beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "maple-trash-move-"));
});

afterAll(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe("moveToTrash", () => {
  test("moves RAW + sidecars into .maple/trash/<rel>, preserving relative path", async () => {
    const dir = path.join(tmpRoot, "2024", "01-15");
    await fs.mkdir(dir, { recursive: true });
    const raw = path.join(dir, "IMG_1.ARW");
    const xmp = path.join(dir, "IMG_1.xmp");
    const conflict = path.join(dir, "IMG_1 (conflict from Mac).xmp");
    await fs.writeFile(raw, "raw");
    await fs.writeFile(xmp, "canon");
    await fs.writeFile(conflict, "conflict");

    const result = await moveToTrash(raw, tmpRoot);

    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.newAbsPath).toBe(path.join(tmpRoot, ".maple", "trash", "2024", "01-15", "IMG_1.ARW"));

    // RAW + sidecars gone from original.
    await expect(fs.stat(raw)).rejects.toThrow();
    await expect(fs.stat(xmp)).rejects.toThrow();
    await expect(fs.stat(conflict)).rejects.toThrow();

    // RAW + sidecars present in trash.
    await fs.stat(result.newAbsPath);
    await fs.stat(path.join(tmpRoot, ".maple", "trash", "2024", "01-15", "IMG_1.xmp"));
    await fs.stat(path.join(tmpRoot, ".maple", "trash", "2024", "01-15", "IMG_1 (conflict from Mac).xmp"));
  });

  test("appends .N when the trash target already exists", async () => {
    const dir = path.join(tmpRoot, "redelete");
    await fs.mkdir(dir, { recursive: true });
    const raw1 = path.join(dir, "IMG_2.ARW");
    await fs.writeFile(raw1, "first");
    const first = await moveToTrash(raw1, tmpRoot);
    expect(first.kind).toBe("ok");

    // Same name, same relative path — second trash must not clobber first.
    await fs.writeFile(raw1, "second");
    const second = await moveToTrash(raw1, tmpRoot);
    expect(second.kind).toBe("ok");
    if (second.kind !== "ok") return;
    expect(second.newAbsPath).toBe(path.join(tmpRoot, ".maple", "trash", "redelete", "IMG_2.1.ARW"));

    // First file still there, second next to it with .1 suffix.
    expect(await fs.readFile(path.join(tmpRoot, ".maple", "trash", "redelete", "IMG_2.ARW"), "utf-8")).toBe("first");
    expect(await fs.readFile(path.join(tmpRoot, ".maple", "trash", "redelete", "IMG_2.1.ARW"), "utf-8")).toBe("second");
  });
});

describe("moveOutOfTrash", () => {
  test("moves RAW + sidecars back to target, appends .restored on collision", async () => {
    const dir = path.join(tmpRoot, "restore");
    await fs.mkdir(dir, { recursive: true });
    const raw = path.join(dir, "IMG_3.ARW");
    await fs.writeFile(raw, "raw");
    await fs.writeFile(path.join(dir, "IMG_3.xmp"), "x");
    const trashed = await moveToTrash(raw, tmpRoot);
    expect(trashed.kind).toBe("ok");
    if (trashed.kind !== "ok") return;

    // Make the original location collide.
    await fs.writeFile(raw, "newer");

    const result = await moveOutOfTrash(trashed.newAbsPath, raw);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.newAbsPath).toBe(path.join(dir, "IMG_3.restored.ARW"));

    // Both files present at the same level.
    expect(await fs.readFile(raw, "utf-8")).toBe("newer");
    expect(await fs.readFile(path.join(dir, "IMG_3.restored.ARW"), "utf-8")).toBe("raw");
    // Sidecar followed with `.restored` to match new RAW base.
    await fs.stat(path.join(dir, "IMG_3.restored.xmp"));
  });
});

describe("computeTrashPath", () => {
  test("places file under .maple/trash/<rel-to-root>", () => {
    expect(
      computeTrashPath("/library/2024/IMG_1.ARW", "/library"),
    ).toBe("/library/.maple/trash/2024/IMG_1.ARW");
  });

  test("throws when abs path is not under the root", () => {
    expect(() => computeTrashPath("/other/IMG_1.ARW", "/library")).toThrow();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd src/api
bun test tests/fs-trash-move.test.ts
```

Expected: import failure — module does not exist.

- [ ] **Step 3: Implement `src/api/src/fs/trash.ts`**

```ts
/**
 * Trash file-move primitives shared by DELETE and restore.
 *
 * `moveToTrash` and `moveOutOfTrash` are *pure* file-move logic — no
 * Mongo, no auth. The route handlers compose them with asset-doc
 * updates and HTTP plumbing. Both move the RAW first, then every
 * paired sidecar (canonical + conflict variants); sidecar errors are
 * logged but never block the RAW move (originals are sacred but losing
 * a sidecar copy is recoverable from search history).
 *
 * Atomic-rename via `fs.rename`. Path validation: every input must be
 * under the library root; we don't enforce MAPLE_ROOTS here because
 * callers already validated against the registered folder root.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { listPairedSidecars } from "./xmp.ts";
import { child as childLogger } from "../log.ts";

const log = childLogger("fs/trash");

export type MoveResult =
  | { kind: "ok"; newAbsPath: string }
  | { kind: "error"; error: string };

/** Compute the trash-side absolute path for a RAW under a library root. */
export function computeTrashPath(absPath: string, folderRoot: string): string {
  const root = folderRoot.replace(/\/$/, "");
  if (absPath !== root && !absPath.startsWith(root + "/")) {
    throw new Error(`Path "${absPath}" is not under root "${root}"`);
  }
  const rel = absPath === root ? "" : absPath.slice(root.length + 1);
  return path.join(root, ".maple", "trash", rel);
}

/** Append `.N.<ext>` until the path is free. Bounded to 1000 attempts. */
async function pickFreePath(basePath: string): Promise<string> {
  try { await fs.stat(basePath); } catch { return basePath; }
  const ext = path.extname(basePath);
  const stem = basePath.slice(0, -ext.length);
  for (let n = 1; n <= 1000; n++) {
    const cand = `${stem}.${n}${ext}`;
    try { await fs.stat(cand); } catch { return cand; }
  }
  return `${stem}.1000${ext}`;
}

/** Append `.restored[.N]<ext>` until the path is free. Bounded to 1000 attempts. */
async function pickFreeRestoredPath(basePath: string): Promise<string> {
  const ext = path.extname(basePath);
  const stem = basePath.slice(0, -ext.length);
  const first = `${stem}.restored${ext}`;
  try { await fs.stat(first); } catch { return first; }
  for (let n = 1; n <= 1000; n++) {
    const cand = `${stem}.restored.${n}${ext}`;
    try { await fs.stat(cand); } catch { return cand; }
  }
  return `${stem}.restored.1000${ext}`;
}

/**
 * Move `absPath` (a RAW) and every paired sidecar into
 * `<folderRoot>/.maple/trash/<rel>`. Returns the new RAW abs_path.
 *
 * If the trash target already exists (re-delete of a previously restored
 * file with the same name), a numeric suffix `.N` is appended.
 *
 * Sidecar moves are best-effort: a sidecar that fails to move is logged
 * and the operation continues. The trashed sidecar's name is derived
 * from the original sidecar's name with the *same* base-replacement
 * that was applied to the RAW (so `IMG_1 (conflict from Mac).xmp`
 * follows `IMG_1.ARW` → `IMG_1.1.ARW` to `IMG_1.1 (conflict from Mac).xmp`).
 */
export async function moveToTrash(absPath: string, folderRoot: string): Promise<MoveResult> {
  const trashTarget = computeTrashPath(absPath, folderRoot);
  await fs.mkdir(path.dirname(trashTarget), { recursive: true });
  const freeTarget = await pickFreePath(trashTarget);
  try {
    await fs.rename(absPath, freeTarget);
  } catch (err) {
    return { kind: "error", error: err instanceof Error ? err.message : String(err) };
  }
  // Move sidecars. Each conflict sidecar carries the OLD base; the moved
  // name swaps to the NEW base so pairing stays correct in trash.
  const oldBase = path.basename(absPath, path.extname(absPath));
  const newBase = path.basename(freeTarget, path.extname(freeTarget));
  const sidecars = await listPairedSidecars(absPath);
  for (const sidecar of sidecars) {
    const sidecarName = path.basename(sidecar);
    if (!sidecarName.startsWith(oldBase)) continue; // defensive
    const renamed = newBase + sidecarName.slice(oldBase.length);
    const destPath = path.join(path.dirname(freeTarget), renamed);
    try {
      await fs.rename(sidecar, destPath);
    } catch (err) {
      log.warn(
        { sidecar, destPath, err: err instanceof Error ? err.message : err },
        "sidecar move failed — RAW moved, sidecar left in place",
      );
    }
  }
  return { kind: "ok", newAbsPath: freeTarget };
}

/**
 * Move a trashed RAW (and its paired sidecars) from `trashAbsPath` back
 * to `targetAbsPath`. If the target collides, a `.restored[.N]` suffix
 * is appended to the basename. Sidecar names follow the new RAW base.
 */
export async function moveOutOfTrash(trashAbsPath: string, targetAbsPath: string): Promise<MoveResult> {
  await fs.mkdir(path.dirname(targetAbsPath), { recursive: true });
  // If the target is free, use it as-is; otherwise apply .restored[.N].
  let freeTarget = targetAbsPath;
  try {
    await fs.stat(targetAbsPath);
    freeTarget = await pickFreeRestoredPath(targetAbsPath);
  } catch { /* free */ }
  try {
    await fs.rename(trashAbsPath, freeTarget);
  } catch (err) {
    return { kind: "error", error: err instanceof Error ? err.message : String(err) };
  }
  const oldBase = path.basename(trashAbsPath, path.extname(trashAbsPath));
  const newBase = path.basename(freeTarget, path.extname(freeTarget));
  const sidecars = await listPairedSidecars(trashAbsPath);
  for (const sidecar of sidecars) {
    const sidecarName = path.basename(sidecar);
    if (!sidecarName.startsWith(oldBase)) continue;
    const renamed = newBase + sidecarName.slice(oldBase.length);
    const destPath = path.join(path.dirname(freeTarget), renamed);
    try {
      await fs.rename(sidecar, destPath);
    } catch (err) {
      log.warn(
        { sidecar, destPath, err: err instanceof Error ? err.message : err },
        "sidecar restore failed — RAW restored, sidecar left in trash",
      );
    }
  }
  return { kind: "ok", newAbsPath: freeTarget };
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
bun test tests/fs-trash-move.test.ts
```

Expected: 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/api/src/fs/trash.ts src/api/tests/fs-trash-move.test.ts
git commit -m "feat(api): moveToTrash + moveOutOfTrash primitives"
```

---

## Task 4: Upload endpoint — `POST /api/folders/:id/upload`

**Files:**
- Modify: `src/api/src/routes/folders.ts`
- Create: `src/api/tests/assets-upload.test.ts`

The streaming upload writes a temp file in the destination directory, fsyncs, atomic-renames into place, then inserts the asset doc with the full `stages` skeleton so the existing controller pipeline picks it up. Extension allowlist = union of `RAW_EXTENSIONS` + `SHARP_EXTENSIONS`.

- [ ] **Step 1: Write the failing test**

Write `src/api/tests/assets-upload.test.ts`:

```ts
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { MongoClient, ObjectId, type Db } from "mongodb";

const TEST_DB = `maple_test_fp3_upload_${process.pid}`;
const MONGO_URI = process.env.MAPLE_MONGO_URI ?? "mongodb://localhost:27017";

let mongo: MongoClient | null = null;
let mongoReachable = false;
let db: Db | null = null;
let tmpRoot: string;
let realTmpRoot: string;
let folderId: ObjectId;

async function tryConnect(): Promise<MongoClient | null> {
  const c = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 1500, connectTimeoutMS: 1500 });
  try { await c.connect(); await c.db("admin").command({ ping: 1 }); return c; }
  catch { try { await c.close(); } catch {}; return null; }
}

describe("POST /api/folders/:id/upload", () => {
  beforeAll(async () => {
    const { closeDb } = await import("../src/db/client.ts");
    await closeDb();
    process.env.MAPLE_MONGO_DB = TEST_DB;
    mongo = await tryConnect();
    mongoReachable = mongo !== null;
    if (!mongoReachable) return;

    db = mongo!.db(TEST_DB);
    await db.dropDatabase();

    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "maple-fp3-upload-"));
    realTmpRoot = await fs.realpath(tmpRoot);
    process.env.MAPLE_ROOTS = realTmpRoot;

    folderId = new ObjectId();
    await db.collection("folders").insertOne({
      _id: folderId, path: realTmpRoot, label: "test",
      created_at: new Date().toISOString(), file_count: 0,
    } as never);
  });

  afterAll(async () => {
    if (tmpRoot) await fs.rm(tmpRoot, { recursive: true, force: true });
    if (mongo) await mongo.close();
  });

  function upload(body: Buffer, headers: Record<string, string>): Request {
    return new Request(`http://localhost/api/folders/${folderId.toHexString()}/upload`, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream", "Content-Length": String(body.byteLength), ...headers },
      body,
    });
  }

  test("happy path: ARW upload writes file + inserts asset doc with stages skeleton", async () => {
    if (!mongoReachable) return;
    const { app } = await import("../src/index.ts");
    const bytes = Buffer.alloc(64, 7);
    const res = await app.handle(upload(bytes, {
      "X-Maple-Target-Path": "2024/IMG_42.ARW",
    }));
    expect(res.status).toBe(201);
    const body = await res.json() as { asset_id: string; abs_path: string; size: number };
    expect(body.size).toBe(64);
    expect(body.abs_path).toBe(path.join(realTmpRoot, "2024", "IMG_42.ARW"));
    const onDisk = await fs.readFile(body.abs_path);
    expect(onDisk.byteLength).toBe(64);

    const doc = await db!.collection("assets").findOne({ _id: new ObjectId(body.asset_id) });
    expect(doc).toBeTruthy();
    expect((doc as Record<string, unknown>).deleted_at).toBeNull();
    expect((doc as Record<string, unknown>).stages).toBeDefined();
    // Every stage must be initialised pending so controllers pick it up.
    const stages = (doc as Record<string, unknown>).stages as Record<string, { version: number; processed_at: null }>;
    for (const stage of ["hash", "exif", "thumb", "face", "ocr", "describe", "geocode", "meili"]) {
      expect(stages[stage]).toBeDefined();
      expect(stages[stage].version).toBe(0);
      expect(stages[stage].processed_at).toBeNull();
    }
  });

  test("415 on unsupported extension; no file on disk, no asset doc", async () => {
    if (!mongoReachable) return;
    const { app } = await import("../src/index.ts");
    const res = await app.handle(upload(Buffer.from("hello"), {
      "X-Maple-Target-Path": "notes.txt",
    }));
    expect(res.status).toBe(415);
    await expect(fs.stat(path.join(realTmpRoot, "notes.txt"))).rejects.toThrow();
    const doc = await db!.collection("assets").findOne({ abs_path: path.join(realTmpRoot, "notes.txt") });
    expect(doc).toBeNull();
  });

  test("400 on path-escape attempt", async () => {
    if (!mongoReachable) return;
    const { app } = await import("../src/index.ts");
    const res = await app.handle(upload(Buffer.from("x"), {
      "X-Maple-Target-Path": "../../etc/IMG.ARW",
    }));
    expect(res.status).toBe(400);
  });

  test("400 on absolute path", async () => {
    if (!mongoReachable) return;
    const { app } = await import("../src/index.ts");
    const res = await app.handle(upload(Buffer.from("x"), {
      "X-Maple-Target-Path": "/etc/IMG.ARW",
    }));
    expect(res.status).toBe(400);
  });

  test("400 on leading-dot path component (would land in .maple/)", async () => {
    if (!mongoReachable) return;
    const { app } = await import("../src/index.ts");
    const res = await app.handle(upload(Buffer.from("x"), {
      "X-Maple-Target-Path": ".maple/IMG.ARW",
    }));
    expect(res.status).toBe(400);
  });

  test("404 on unknown folder id", async () => {
    if (!mongoReachable) return;
    const { app } = await import("../src/index.ts");
    const otherId = new ObjectId().toHexString();
    const res = await app.handle(new Request(`http://localhost/api/folders/${otherId}/upload`, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream", "Content-Length": "1", "X-Maple-Target-Path": "x.ARW" },
      body: Buffer.from("x"),
    }));
    expect(res.status).toBe(404);
  });

  test("409 when target file already exists", async () => {
    if (!mongoReachable) return;
    const { app } = await import("../src/index.ts");
    const dest = path.join(realTmpRoot, "exists.ARW");
    await fs.writeFile(dest, "old");
    const res = await app.handle(upload(Buffer.from("new"), {
      "X-Maple-Target-Path": "exists.ARW",
    }));
    expect(res.status).toBe(409);
    expect(await fs.readFile(dest, "utf-8")).toBe("old");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd src/api
bun test tests/assets-upload.test.ts
```

Expected: every test 404s — the route doesn't exist yet.

- [ ] **Step 3: Implement the upload route**

Edit `src/api/src/routes/folders.ts`. Add these imports at the top (alongside the existing ones):

```ts
import { randomUUID } from "node:crypto";
import { open, rename, stat, unlink, mkdir } from "node:fs/promises";
import { RAW_EXTENSIONS } from "../fs/browse.ts";
import { SHARP_EXTENSIONS } from "../thumbs/render.ts";
import { blankStagesSkeleton } from "../workers/stages/manifest.ts";
```

Then add this route inside the chained `Elysia` declaration (after `.post("/:id/rescan", ...)`):

```ts
  // Streaming upload: body is raw file bytes, target path in X-Maple-Target-Path.
  .post(
    "/:id/upload",
    async ({ params, body, headers, set }) => {
      let folderId: ObjectId;
      try { folderId = new ObjectId(params.id); }
      catch { set.status = 400; return { error: "Invalid folder id" }; }

      const folders = await foldersCollection();
      const folder = await folders.findOne({ _id: folderId });
      if (!folder) { set.status = 404; return { error: "Folder not found" }; }

      const targetHeader = headers["x-maple-target-path"];
      if (typeof targetHeader !== "string" || targetHeader.length === 0) {
        set.status = 400; return { error: "Missing X-Maple-Target-Path" };
      }
      const target = decodeURIComponent(targetHeader);
      // Path validation: no leading /, no .. component, no leading-dot component
      // (the latter would let a caller write into .maple/).
      if (target.startsWith("/")) { set.status = 400; return { error: "Path must be relative" }; }
      const parts = target.split("/").filter((p) => p.length > 0);
      if (parts.length === 0) { set.status = 400; return { error: "Empty target path" }; }
      for (const part of parts) {
        if (part === ".." || part === ".") { set.status = 400; return { error: "Path traversal not allowed" }; }
        if (part.startsWith(".")) { set.status = 400; return { error: "Hidden path components not allowed" }; }
      }
      const filename = parts[parts.length - 1]!;
      const dot = filename.lastIndexOf(".");
      const ext = dot >= 0 ? filename.slice(dot + 1).toLowerCase() : "";
      const allowed = RAW_EXTENSIONS.has(ext) || SHARP_EXTENSIONS.has(ext);
      if (!allowed) {
        set.status = 415;
        return { error: `Unsupported file extension: "${ext}"` };
      }

      const absPath = path.join(folder.path, target);
      // Refuse overwrite of an existing file.
      try {
        await stat(absPath);
        set.status = 409;
        return { error: "file exists", abs_path: absPath };
      } catch { /* free */ }

      const bytes = body instanceof Uint8Array
        ? body
        : typeof body === "string"
          ? new TextEncoder().encode(body)
          : new Uint8Array();

      const dir = path.dirname(absPath);
      await mkdir(dir, { recursive: true });
      const tmp = path.join(dir, `.upload-${randomUUID()}`);
      try {
        const fh = await open(tmp, "w");
        try {
          await fh.writeFile(bytes);
          await fh.datasync();
        } finally {
          await fh.close();
        }
        await rename(tmp, absPath);
      } catch (err) {
        try { await unlink(tmp); } catch {}
        set.status = 500;
        return { error: `Upload write failed: ${err instanceof Error ? err.message : String(err)}` };
      }

      const st = await stat(absPath);
      const mtimeHeader = headers["x-maple-file-mtime"];
      if (typeof mtimeHeader === "string" && /^\d+$/.test(mtimeHeader)) {
        const { utimes } = await import("node:fs/promises");
        const epoch = parseInt(mtimeHeader, 10);
        try { await utimes(absPath, epoch, epoch); } catch {}
      }

      const assets = await assetsCollection();
      const _id = new ObjectId();
      const nowIso = new Date().toISOString();
      await assets.insertOne({
        _id,
        folder_id: folderId,
        filename,
        abs_path: absPath,
        size: st.size,
        mtime: st.mtimeMs,
        rating: 0,
        flag: 0,
        color_label: "",
        exif: null,
        indexed_at: nowIso,
        deleted_at: null,
        stages: blankStagesSkeleton(),
      } as never);

      set.status = 201;
      return { asset_id: _id.toHexString(), abs_path: absPath, size: st.size, mtime: st.mtimeMs };
    },
    {
      type: "arrayBuffer",
    }
  )
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
bun test tests/assets-upload.test.ts
```

Expected: 7 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/api/src/routes/folders.ts src/api/tests/assets-upload.test.ts
git commit -m "feat(api): POST /api/folders/:id/upload"
```

---

## Task 5: DELETE endpoint — soft-delete + permanent purge

**Files:**
- Modify: `src/api/src/routes/assets.ts`
- Create: `src/api/tests/assets-delete-trash.test.ts`

Two behaviours, one route:
- `deleted_at == null`: move RAW + sidecars to `.maple/trash/<rel>`, set `deleted_at` and `original_path`, return 204.
- `deleted_at != null` (already trashed): permanently delete the file and the asset doc, return 204. This is the "user emptied this single item from Trash" signal.

- [ ] **Step 1: Write the failing test**

Write `src/api/tests/assets-delete-trash.test.ts`:

```ts
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { MongoClient, ObjectId, type Db } from "mongodb";
import { pendingEnrichment } from "../src/db/schema.ts";

const TEST_DB = `maple_test_fp3_delete_${process.pid}`;
const MONGO_URI = process.env.MAPLE_MONGO_URI ?? "mongodb://localhost:27017";

let mongo: MongoClient | null = null;
let mongoReachable = false;
let db: Db | null = null;
let tmpRoot: string;
let realTmpRoot: string;
let folderId: ObjectId;

async function tryConnect(): Promise<MongoClient | null> {
  const c = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 1500, connectTimeoutMS: 1500 });
  try { await c.connect(); await c.db("admin").command({ ping: 1 }); return c; }
  catch { try { await c.close(); } catch {}; return null; }
}

async function makeAsset(filename: string, content: Buffer): Promise<{ assetId: ObjectId; absPath: string }> {
  const absPath = path.join(realTmpRoot, "2024", filename);
  await fs.mkdir(path.dirname(absPath), { recursive: true });
  await fs.writeFile(absPath, content);
  const assetId = new ObjectId();
  await db!.collection("assets").insertOne({
    _id: assetId,
    folder_id: folderId,
    filename,
    abs_path: absPath,
    size: content.byteLength,
    mtime: Date.now(),
    indexed_at: new Date().toISOString(),
    deleted_at: null,
    enrichment: pendingEnrichment(),
  } as never);
  return { assetId, absPath };
}

describe("DELETE /api/assets/:id (trash + permanent purge)", () => {
  beforeAll(async () => {
    const { closeDb } = await import("../src/db/client.ts");
    await closeDb();
    process.env.MAPLE_MONGO_DB = TEST_DB;
    mongo = await tryConnect();
    mongoReachable = mongo !== null;
    if (!mongoReachable) return;

    db = mongo!.db(TEST_DB);
    await db.dropDatabase();

    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "maple-fp3-delete-"));
    realTmpRoot = await fs.realpath(tmpRoot);
    process.env.MAPLE_ROOTS = realTmpRoot;

    folderId = new ObjectId();
    await db.collection("folders").insertOne({
      _id: folderId, path: realTmpRoot, label: "test",
      created_at: new Date().toISOString(), file_count: 0,
    } as never);
  });

  afterAll(async () => {
    if (tmpRoot) await fs.rm(tmpRoot, { recursive: true, force: true });
    if (mongo) await mongo.close();
  });

  test("moves RAW + sidecar to trash; sets deleted_at + original_path", async () => {
    if (!mongoReachable) return;
    const { app } = await import("../src/index.ts");
    const { assetId, absPath } = await makeAsset("IMG_1.ARW", Buffer.from("raw"));
    await fs.writeFile(absPath.replace(/\.ARW$/, ".xmp"), "canon");
    await fs.writeFile(absPath.replace(/\.ARW$/, " (conflict from Mac).xmp"), "conflict");

    const res = await app.handle(new Request(`http://localhost/api/assets/${assetId.toHexString()}`, { method: "DELETE" }));
    expect(res.status).toBe(204);

    // Files gone from original.
    await expect(fs.stat(absPath)).rejects.toThrow();
    await expect(fs.stat(absPath.replace(/\.ARW$/, ".xmp"))).rejects.toThrow();
    await expect(fs.stat(absPath.replace(/\.ARW$/, " (conflict from Mac).xmp"))).rejects.toThrow();

    // Files present in trash, mirrored relative path.
    const trashRaw = path.join(realTmpRoot, ".maple", "trash", "2024", "IMG_1.ARW");
    const trashCanon = path.join(realTmpRoot, ".maple", "trash", "2024", "IMG_1.xmp");
    const trashConflict = path.join(realTmpRoot, ".maple", "trash", "2024", "IMG_1 (conflict from Mac).xmp");
    await fs.stat(trashRaw);
    await fs.stat(trashCanon);
    await fs.stat(trashConflict);

    // Asset doc flipped.
    const doc = await db!.collection("assets").findOne({ _id: assetId }) as Record<string, unknown>;
    expect(doc.deleted_at).toBeTruthy();
    expect(doc.original_path).toBe(absPath);
    expect(doc.abs_path).toBe(trashRaw);
  });

  test("DELETE on already-trashed asset permanently purges file + doc", async () => {
    if (!mongoReachable) return;
    const { app } = await import("../src/index.ts");
    const { assetId, absPath } = await makeAsset("IMG_2.ARW", Buffer.from("raw"));
    await app.handle(new Request(`http://localhost/api/assets/${assetId.toHexString()}`, { method: "DELETE" }));

    const trashed = await db!.collection("assets").findOne({ _id: assetId }) as Record<string, unknown>;
    const trashRaw = trashed.abs_path as string;
    await fs.stat(trashRaw);

    const res = await app.handle(new Request(`http://localhost/api/assets/${assetId.toHexString()}`, { method: "DELETE" }));
    expect(res.status).toBe(204);

    await expect(fs.stat(trashRaw)).rejects.toThrow();
    const doc = await db!.collection("assets").findOne({ _id: assetId });
    expect(doc).toBeNull();
    void absPath; // assertion is on the post-trash path
  });

  test("404 on unknown asset id", async () => {
    if (!mongoReachable) return;
    const { app } = await import("../src/index.ts");
    const otherId = new ObjectId().toHexString();
    const res = await app.handle(new Request(`http://localhost/api/assets/${otherId}`, { method: "DELETE" }));
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
bun test tests/assets-delete-trash.test.ts
```

Expected: tests fail because the route doesn't accept DELETE.

- [ ] **Step 3: Implement the DELETE route**

Edit `src/api/src/routes/assets.ts`. Add these imports at the top:

```ts
import { unlink } from "node:fs/promises";
import { foldersCollection } from "../db/client.ts";
import { moveToTrash } from "../fs/trash.ts";
import { listPairedSidecars } from "../fs/xmp.ts";
```

Then add this route inside the chained `Elysia` declaration (after `.delete("/:id/xmp", ...)`):

```ts
  // Soft-delete (trash) on first call; permanent purge on second call.
  // The OS sends DELETE for any drag-to-Trash; the client sends DELETE
  // for any "permanently delete from Trash" action — same route, server
  // distinguishes via the existing `deleted_at` field.
  .delete("/:id", async ({ params, set }) => {
    let id: ObjectId;
    try { id = new ObjectId(params.id); }
    catch { set.status = 400; return { error: "Invalid asset id" }; }

    const coll = await assetsCollection();
    const doc = await coll.findOne({ _id: id });
    if (!doc) { set.status = 404; return { error: "Asset not found" }; }

    // Already trashed → permanent purge.
    const docAny = doc as unknown as Record<string, unknown>;
    if (docAny.deleted_at) {
      const absPath = doc.abs_path;
      try { await unlink(absPath); } catch { /* file may already be gone */ }
      const sidecars = await listPairedSidecars(absPath);
      for (const sidecar of sidecars) {
        try { await unlink(sidecar); } catch {}
      }
      await coll.deleteOne({ _id: id });
      set.status = 204;
      return;
    }

    // Locate the owning folder root.
    const folders = await foldersCollection();
    const folder = await folders.findOne({ _id: doc.folder_id });
    if (!folder) {
      set.status = 500;
      return { error: "Asset's folder is missing — refusing to trash" };
    }

    const result = await moveToTrash(doc.abs_path, folder.path);
    if (result.kind !== "ok") {
      set.status = 500;
      return { error: result.error };
    }

    await coll.updateOne(
      { _id: id },
      { $set: {
          abs_path: result.newAbsPath,
          deleted_at: new Date().toISOString(),
          original_path: doc.abs_path,
        } },
    );
    set.status = 204;
    return;
  })
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
bun test tests/assets-delete-trash.test.ts
```

Expected: 3 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/api/src/routes/assets.ts src/api/tests/assets-delete-trash.test.ts
git commit -m "feat(api): DELETE /api/assets/:id (trash + permanent purge)"
```

---

## Task 6: Restore endpoint — `POST /api/assets/:id/restore`

**Files:**
- Modify: `src/api/src/routes/assets.ts`
- Create: `src/api/tests/assets-restore.test.ts`

Reads `original_path` (or the body-supplied `target_relative_path`) and undoes the trash move, appending `.restored[.N]` on collision.

- [ ] **Step 1: Write the failing test**

Write `src/api/tests/assets-restore.test.ts`:

```ts
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { MongoClient, ObjectId, type Db } from "mongodb";
import { pendingEnrichment } from "../src/db/schema.ts";

const TEST_DB = `maple_test_fp3_restore_${process.pid}`;
const MONGO_URI = process.env.MAPLE_MONGO_URI ?? "mongodb://localhost:27017";

let mongo: MongoClient | null = null;
let mongoReachable = false;
let db: Db | null = null;
let tmpRoot: string;
let realTmpRoot: string;
let folderId: ObjectId;

async function tryConnect(): Promise<MongoClient | null> {
  const c = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 1500, connectTimeoutMS: 1500 });
  try { await c.connect(); await c.db("admin").command({ ping: 1 }); return c; }
  catch { try { await c.close(); } catch {}; return null; }
}

async function trashedAsset(filename: string): Promise<{ assetId: ObjectId; originalPath: string; trashPath: string }> {
  const originalPath = path.join(realTmpRoot, "2024", filename);
  const trashPath = path.join(realTmpRoot, ".maple", "trash", "2024", filename);
  await fs.mkdir(path.dirname(originalPath), { recursive: true });
  await fs.mkdir(path.dirname(trashPath), { recursive: true });
  await fs.writeFile(trashPath, "raw");
  const assetId = new ObjectId();
  await db!.collection("assets").insertOne({
    _id: assetId,
    folder_id: folderId,
    filename,
    abs_path: trashPath,
    size: 3,
    mtime: Date.now(),
    indexed_at: new Date().toISOString(),
    deleted_at: new Date().toISOString(),
    original_path: originalPath,
    enrichment: pendingEnrichment(),
  } as never);
  return { assetId, originalPath, trashPath };
}

describe("POST /api/assets/:id/restore", () => {
  beforeAll(async () => {
    const { closeDb } = await import("../src/db/client.ts");
    await closeDb();
    process.env.MAPLE_MONGO_DB = TEST_DB;
    mongo = await tryConnect();
    mongoReachable = mongo !== null;
    if (!mongoReachable) return;
    db = mongo!.db(TEST_DB);
    await db.dropDatabase();
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "maple-fp3-restore-"));
    realTmpRoot = await fs.realpath(tmpRoot);
    process.env.MAPLE_ROOTS = realTmpRoot;
    folderId = new ObjectId();
    await db.collection("folders").insertOne({
      _id: folderId, path: realTmpRoot, label: "test",
      created_at: new Date().toISOString(), file_count: 0,
    } as never);
  });

  afterAll(async () => {
    if (tmpRoot) await fs.rm(tmpRoot, { recursive: true, force: true });
    if (mongo) await mongo.close();
  });

  test("restores to original_path; clears deleted_at + original_path", async () => {
    if (!mongoReachable) return;
    const { app } = await import("../src/index.ts");
    const { assetId, originalPath, trashPath } = await trashedAsset("IMG_R1.ARW");

    const res = await app.handle(new Request(`http://localhost/api/assets/${assetId.toHexString()}/restore`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}),
    }));
    expect(res.status).toBe(200);
    const body = await res.json() as { abs_path: string };
    expect(body.abs_path).toBe(originalPath);

    await fs.stat(originalPath);
    await expect(fs.stat(trashPath)).rejects.toThrow();
    const doc = await db!.collection("assets").findOne({ _id: assetId }) as Record<string, unknown>;
    expect(doc.deleted_at).toBeNull();
    expect(doc.original_path).toBeNull();
    expect(doc.abs_path).toBe(originalPath);
  });

  test("restores to body-supplied target_relative_path", async () => {
    if (!mongoReachable) return;
    const { app } = await import("../src/index.ts");
    const { assetId } = await trashedAsset("IMG_R2.ARW");
    const target = "elsewhere/IMG_R2.ARW";
    const res = await app.handle(new Request(`http://localhost/api/assets/${assetId.toHexString()}/restore`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target_relative_path: target }),
    }));
    expect(res.status).toBe(200);
    const body = await res.json() as { abs_path: string };
    expect(body.abs_path).toBe(path.join(realTmpRoot, target));
    await fs.stat(body.abs_path);
  });

  test(".restored suffix appended on collision", async () => {
    if (!mongoReachable) return;
    const { app } = await import("../src/index.ts");
    const { assetId, originalPath } = await trashedAsset("IMG_R3.ARW");
    // Create a new file at the original path so restore must rename.
    await fs.writeFile(originalPath, "occupier");

    const res = await app.handle(new Request(`http://localhost/api/assets/${assetId.toHexString()}/restore`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}),
    }));
    expect(res.status).toBe(200);
    const body = await res.json() as { abs_path: string };
    expect(body.abs_path).toBe(path.join(path.dirname(originalPath), "IMG_R3.restored.ARW"));
    expect(await fs.readFile(originalPath, "utf-8")).toBe("occupier");
    expect(await fs.readFile(body.abs_path, "utf-8")).toBe("raw");
  });

  test("409 when asset is not trashed", async () => {
    if (!mongoReachable) return;
    const { app } = await import("../src/index.ts");
    const assetId = new ObjectId();
    await db!.collection("assets").insertOne({
      _id: assetId, folder_id: folderId, filename: "live.ARW",
      abs_path: path.join(realTmpRoot, "live.ARW"), size: 0, mtime: 0,
      indexed_at: new Date().toISOString(), deleted_at: null,
    } as never);
    const res = await app.handle(new Request(`http://localhost/api/assets/${assetId.toHexString()}/restore`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}),
    }));
    expect(res.status).toBe(409);
  });

  test("404 on unknown asset id", async () => {
    if (!mongoReachable) return;
    const { app } = await import("../src/index.ts");
    const otherId = new ObjectId().toHexString();
    const res = await app.handle(new Request(`http://localhost/api/assets/${otherId}/restore`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}),
    }));
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
bun test tests/assets-restore.test.ts
```

Expected: 5 tests fail with 404.

- [ ] **Step 3: Implement the restore route**

Edit `src/api/src/routes/assets.ts`. Add to the imports:

```ts
import { moveOutOfTrash, moveToTrash } from "../fs/trash.ts";
```

(replace the prior `moveToTrash` import if you previously added it solo). Add the route after the new DELETE handler:

```ts
  .post(
    "/:id/restore",
    async ({ params, body, set }) => {
      let id: ObjectId;
      try { id = new ObjectId(params.id); }
      catch { set.status = 400; return { error: "Invalid asset id" }; }

      const coll = await assetsCollection();
      const doc = await coll.findOne({ _id: id });
      if (!doc) { set.status = 404; return { error: "Asset not found" }; }
      const docAny = doc as unknown as Record<string, unknown>;
      if (!docAny.deleted_at) { set.status = 409; return { error: "Asset is not trashed" }; }

      const folders = await foldersCollection();
      const folder = await folders.findOne({ _id: doc.folder_id });
      if (!folder) { set.status = 500; return { error: "Asset's folder is missing" }; }

      const targetRel = (body as { target_relative_path?: string } | null)?.target_relative_path;
      let targetAbs: string;
      if (typeof targetRel === "string" && targetRel.length > 0) {
        if (targetRel.startsWith("/")) { set.status = 400; return { error: "Target must be relative" }; }
        const parts = targetRel.split("/").filter((p) => p.length > 0);
        for (const part of parts) {
          if (part === ".." || part === ".") { set.status = 400; return { error: "Path traversal not allowed" }; }
          if (part.startsWith(".")) { set.status = 400; return { error: "Hidden path components not allowed" }; }
        }
        targetAbs = path.join(folder.path, targetRel);
      } else {
        const orig = docAny.original_path;
        if (typeof orig !== "string" || orig.length === 0) {
          set.status = 500;
          return { error: "Asset has no original_path; supply target_relative_path" };
        }
        targetAbs = orig;
      }

      const result = await moveOutOfTrash(doc.abs_path, targetAbs);
      if (result.kind !== "ok") {
        set.status = 500;
        return { error: result.error };
      }
      await coll.updateOne(
        { _id: id },
        { $set: {
            abs_path: result.newAbsPath,
            deleted_at: null,
            original_path: null,
          } },
      );
      set.status = 200;
      return { asset_id: id.toHexString(), abs_path: result.newAbsPath };
    },
    {
      body: t.Object({
        target_relative_path: t.Optional(t.String()),
      }),
    }
  )
```

Make sure `path` is imported in `assets.ts` (add `import * as path from "node:path";` at the top if absent).

- [ ] **Step 4: Run the test to verify it passes**

```bash
bun test tests/assets-restore.test.ts
```

Expected: 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/api/src/routes/assets.ts src/api/tests/assets-restore.test.ts
git commit -m "feat(api): POST /api/assets/:id/restore"
```

---

## Task 7: Trash listing — `GET /api/folders/:id/trash`

**Files:**
- Modify: `src/api/src/routes/folders.ts`
- Create: `src/api/tests/folders-trash-list.test.ts`

Paged list of trashed assets for one library, newest-deletion-first. Pagination uses an opaque cursor (the `deleted_at` ISO string + `_id`) so concurrent deletes don't shift the page window.

- [ ] **Step 1: Write the failing test**

Write `src/api/tests/folders-trash-list.test.ts`:

```ts
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { MongoClient, ObjectId, type Db } from "mongodb";

const TEST_DB = `maple_test_fp3_trash_list_${process.pid}`;
const MONGO_URI = process.env.MAPLE_MONGO_URI ?? "mongodb://localhost:27017";

let mongo: MongoClient | null = null;
let mongoReachable = false;
let db: Db | null = null;
let tmpRoot: string;
let realTmpRoot: string;
let folderId: ObjectId;

async function tryConnect(): Promise<MongoClient | null> {
  const c = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 1500, connectTimeoutMS: 1500 });
  try { await c.connect(); await c.db("admin").command({ ping: 1 }); return c; }
  catch { try { await c.close(); } catch {}; return null; }
}

describe("GET /api/folders/:id/trash", () => {
  beforeAll(async () => {
    const { closeDb } = await import("../src/db/client.ts");
    await closeDb();
    process.env.MAPLE_MONGO_DB = TEST_DB;
    mongo = await tryConnect();
    mongoReachable = mongo !== null;
    if (!mongoReachable) return;
    db = mongo!.db(TEST_DB);
    await db.dropDatabase();
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "maple-fp3-tlist-"));
    realTmpRoot = await fs.realpath(tmpRoot);
    process.env.MAPLE_ROOTS = realTmpRoot;
    folderId = new ObjectId();
    await db.collection("folders").insertOne({
      _id: folderId, path: realTmpRoot, label: "t",
      created_at: new Date().toISOString(), file_count: 0,
    } as never);
    // Three trashed assets at different times.
    const now = Date.now();
    for (let i = 0; i < 3; i++) {
      const filename = `T${i}.ARW`;
      const trash = path.join(realTmpRoot, ".maple", "trash", filename);
      await fs.mkdir(path.dirname(trash), { recursive: true });
      await fs.writeFile(trash, `r${i}`);
      await db.collection("assets").insertOne({
        _id: new ObjectId(),
        folder_id: folderId,
        filename, abs_path: trash, size: 2, mtime: now,
        indexed_at: new Date().toISOString(),
        deleted_at: new Date(now - i * 1000).toISOString(),
        original_path: path.join(realTmpRoot, filename),
      } as never);
    }
    // One vanished (watcher-removed) asset — deleted_at set, original_path absent.
    await db.collection("assets").insertOne({
      _id: new ObjectId(),
      folder_id: folderId,
      filename: "vanished.ARW",
      abs_path: path.join(realTmpRoot, "vanished.ARW"),
      size: 0, mtime: now, indexed_at: new Date().toISOString(),
      deleted_at: new Date().toISOString(),
    } as never);
  });

  afterAll(async () => {
    if (tmpRoot) await fs.rm(tmpRoot, { recursive: true, force: true });
    if (mongo) await mongo.close();
  });

  test("returns trashed assets newest-first, excludes vanished (no original_path)", async () => {
    if (!mongoReachable) return;
    const { app } = await import("../src/index.ts");
    const res = await app.handle(new Request(`http://localhost/api/folders/${folderId.toHexString()}/trash`));
    expect(res.status).toBe(200);
    const body = await res.json() as { items: Array<{ filename: string; original_relative_path: string; deleted_at: string }>; next_cursor: string | null };
    expect(body.items).toHaveLength(3);
    expect(body.items[0].filename).toBe("T0.ARW");
    expect(body.items[2].filename).toBe("T2.ARW");
    expect(body.items[0].original_relative_path).toBe("T0.ARW");
  });

  test("pagination via limit + cursor returns subsequent page", async () => {
    if (!mongoReachable) return;
    const { app } = await import("../src/index.ts");
    const first = await app.handle(new Request(`http://localhost/api/folders/${folderId.toHexString()}/trash?limit=2`));
    const firstBody = await first.json() as { items: Array<{ filename: string }>; next_cursor: string | null };
    expect(firstBody.items).toHaveLength(2);
    expect(firstBody.next_cursor).toBeTruthy();
    const second = await app.handle(new Request(`http://localhost/api/folders/${folderId.toHexString()}/trash?limit=2&cursor=${encodeURIComponent(firstBody.next_cursor!)}`));
    const secondBody = await second.json() as { items: Array<{ filename: string }>; next_cursor: string | null };
    expect(secondBody.items).toHaveLength(1);
    expect(secondBody.items[0].filename).toBe("T2.ARW");
    expect(secondBody.next_cursor).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
bun test tests/folders-trash-list.test.ts
```

Expected: tests 404.

- [ ] **Step 3: Implement the route**

Edit `src/api/src/routes/folders.ts`. Add this route after the upload route:

```ts
  .get(
    "/:id/trash",
    async ({ params, query, set }) => {
      let folderId: ObjectId;
      try { folderId = new ObjectId(params.id); }
      catch { set.status = 400; return { error: "Invalid folder id" }; }

      const folders = await foldersCollection();
      const folder = await folders.findOne({ _id: folderId });
      if (!folder) { set.status = 404; return { error: "Folder not found" }; }

      const limit = Math.min(500, Math.max(1, Number(query.limit ?? 100)));
      const filter: Record<string, unknown> = {
        folder_id: folderId,
        deleted_at: { $ne: null },
        original_path: { $ne: null },
      };
      const cursor = typeof query.cursor === "string" && query.cursor.length > 0
        ? query.cursor
        : null;
      if (cursor) {
        // Cursor is "<iso>|<hex_id>": page where deleted_at < iso, or (== iso and _id < hex_id).
        const sepIdx = cursor.lastIndexOf("|");
        if (sepIdx > 0) {
          const iso = cursor.slice(0, sepIdx);
          const hex = cursor.slice(sepIdx + 1);
          try {
            filter.$or = [
              { deleted_at: { $lt: iso } },
              { deleted_at: iso, _id: { $lt: new ObjectId(hex) } },
            ];
          } catch { /* malformed cursor → ignore */ }
        }
      }

      const assets = await assetsCollection();
      const docs = await assets
        .find(filter)
        .sort({ deleted_at: -1, _id: -1 })
        .limit(limit + 1)
        .toArray();
      const hasMore = docs.length > limit;
      const pageDocs = hasMore ? docs.slice(0, limit) : docs;
      const last = pageDocs[pageDocs.length - 1];
      const nextCursor = hasMore && last
        ? `${(last as unknown as { deleted_at: string }).deleted_at}|${last._id.toHexString()}`
        : null;

      const rootPrefix = folder.path.endsWith("/") ? folder.path : folder.path + "/";
      return {
        items: pageDocs.map((d) => {
          const doc = d as unknown as { _id: ObjectId; filename: string; abs_path: string; size: number; mtime: number; deleted_at: string; original_path: string };
          const orig = doc.original_path;
          const originalRel = orig.startsWith(rootPrefix) ? orig.slice(rootPrefix.length) : orig;
          const trashRel = doc.abs_path.startsWith(rootPrefix) ? doc.abs_path.slice(rootPrefix.length) : doc.abs_path;
          return {
            asset_id: doc._id.toHexString(),
            filename: doc.filename,
            original_relative_path: originalRel,
            trash_relative_path: trashRel,
            size: doc.size,
            mtime: doc.mtime,
            deleted_at: doc.deleted_at,
          };
        }),
        next_cursor: nextCursor,
      };
    },
    {
      query: t.Object({
        limit: t.Optional(t.String()),
        cursor: t.Optional(t.String()),
      }),
    }
  )
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
bun test tests/folders-trash-list.test.ts
```

Expected: 2 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/api/src/routes/folders.ts src/api/tests/folders-trash-list.test.ts
git commit -m "feat(api): GET /api/folders/:id/trash"
```

---

## Task 8: `GET /api/fs/dir` excludes trashed assets

**Files:**
- Modify: `src/api/src/fs/browse.ts`
- Create: `src/api/tests/fs-dir-excludes-trash.test.ts`

Right now `listDirContents` enumerates the directory and bulk-attaches indexed metadata. Trashed assets live in `.maple/trash/...`, so the directory listing won't physically include them. The remaining concern is the rare case where a trashed asset's `abs_path` is still pointing at the old location (e.g., race during DELETE). Defensively, when bulk-attaching metadata, drop any matched asset whose `deleted_at != null`.

- [ ] **Step 1: Write the failing test**

Write `src/api/tests/fs-dir-excludes-trash.test.ts`:

```ts
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { MongoClient, ObjectId, type Db } from "mongodb";

const TEST_DB = `maple_test_fp3_dir_excl_${process.pid}`;
const MONGO_URI = process.env.MAPLE_MONGO_URI ?? "mongodb://localhost:27017";

let mongo: MongoClient | null = null;
let mongoReachable = false;
let db: Db | null = null;
let tmpRoot: string;
let realTmpRoot: string;
let folderId: ObjectId;

async function tryConnect(): Promise<MongoClient | null> {
  const c = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 1500, connectTimeoutMS: 1500 });
  try { await c.connect(); await c.db("admin").command({ ping: 1 }); return c; }
  catch { try { await c.close(); } catch {}; return null; }
}

describe("GET /api/fs/dir excludes trashed assets", () => {
  beforeAll(async () => {
    const { closeDb } = await import("../src/db/client.ts");
    await closeDb();
    process.env.MAPLE_MONGO_DB = TEST_DB;
    mongo = await tryConnect();
    mongoReachable = mongo !== null;
    if (!mongoReachable) return;
    db = mongo!.db(TEST_DB);
    await db.dropDatabase();
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "maple-fp3-dirx-"));
    realTmpRoot = await fs.realpath(tmpRoot);
    process.env.MAPLE_ROOTS = realTmpRoot;
    folderId = new ObjectId();
    await db.collection("folders").insertOne({
      _id: folderId, path: realTmpRoot, label: "t",
      created_at: new Date().toISOString(), file_count: 0,
    } as never);
  });

  afterAll(async () => {
    if (tmpRoot) await fs.rm(tmpRoot, { recursive: true, force: true });
    if (mongo) await mongo.close();
  });

  test("if an indexed file is trashed but somehow still on disk, listing omits it", async () => {
    if (!mongoReachable) return;
    const live = path.join(realTmpRoot, "live.ARW");
    const ghost = path.join(realTmpRoot, "ghost.ARW");
    await fs.writeFile(live, "live");
    await fs.writeFile(ghost, "ghost");
    await db!.collection("assets").insertMany([
      { _id: new ObjectId(), folder_id: folderId, filename: "live.ARW", abs_path: live, size: 4, mtime: Date.now(), indexed_at: new Date().toISOString(), deleted_at: null } as never,
      { _id: new ObjectId(), folder_id: folderId, filename: "ghost.ARW", abs_path: ghost, size: 5, mtime: Date.now(), indexed_at: new Date().toISOString(), deleted_at: new Date().toISOString(), original_path: ghost } as never,
    ]);

    const { app } = await import("../src/index.ts");
    const res = await app.handle(new Request(`http://localhost/api/fs/dir?path=${encodeURIComponent(realTmpRoot)}`));
    expect(res.status).toBe(200);
    const body = await res.json() as { images: Array<{ name: string }> };
    const names = body.images.map((i) => i.name).sort();
    expect(names).toEqual(["live.ARW"]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
bun test tests/fs-dir-excludes-trash.test.ts
```

Expected: fails — both files appear in the listing.

- [ ] **Step 3: Filter trashed assets in `listDirContents`**

Edit `src/api/src/fs/browse.ts`. Find the bulk-attach block inside `listDirContents` (the loop that does `coll.find({ abs_path: { $in: ... } })`). Change the projection to include `deleted_at`, and inside the `for await` loop skip docs where `deleted_at` is non-null. Also remove that image from the `images` array entirely so the listing matches what a non-indexed file would look like (i.e. omit it, don't just clear its id).

Replace the existing block:

```ts
  const indexedPaths = new Set<string>();
  if (images.length > 0) {
    try {
      const coll = await assetsCollection();
      const cursor = coll.find(
        { abs_path: { $in: images.map((i) => i.path) } },
        { projection: { _id: 1, abs_path: 1, exif: 1 } },
      );
      const byPath = new Map<string, { id: string; exif: AssetExif | null | undefined }>();
      for await (const doc of cursor) {
        byPath.set(doc.abs_path, { id: doc._id.toHexString(), exif: doc.exif });
        indexedPaths.add(doc.abs_path);
      }
      for (const img of images) {
        const hit = byPath.get(img.path);
        if (hit) {
          img.id = hit.id;
          img.exif = hit.exif;
        }
      }
    } catch (err) {
      log.error(
        { real, err: err instanceof Error ? err.message : err },
        "exif lookup failed",
      );
    }
  }
```

with:

```ts
  const indexedPaths = new Set<string>();
  const trashedPaths = new Set<string>();
  if (images.length > 0) {
    try {
      const coll = await assetsCollection();
      const cursor = coll.find(
        { abs_path: { $in: images.map((i) => i.path) } },
        { projection: { _id: 1, abs_path: 1, exif: 1, deleted_at: 1 } },
      );
      const byPath = new Map<string, { id: string; exif: AssetExif | null | undefined }>();
      for await (const doc of cursor) {
        const raw = doc as unknown as Record<string, unknown>;
        if (raw.deleted_at != null) {
          trashedPaths.add(doc.abs_path);
          continue;
        }
        byPath.set(doc.abs_path, { id: doc._id.toHexString(), exif: doc.exif });
        indexedPaths.add(doc.abs_path);
      }
      for (const img of images) {
        const hit = byPath.get(img.path);
        if (hit) {
          img.id = hit.id;
          img.exif = hit.exif;
        }
      }
    } catch (err) {
      log.error(
        { real, err: err instanceof Error ? err.message : err },
        "exif lookup failed",
      );
    }
  }
  // Drop trashed-on-disk files so they don't appear in the listing.
  if (trashedPaths.size > 0) {
    for (let i = images.length - 1; i >= 0; i--) {
      if (trashedPaths.has(images[i]!.path)) images.splice(i, 1);
    }
  }
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
bun test tests/fs-dir-excludes-trash.test.ts
```

Expected: 1 test passes. Also run the existing fs-dir tests to confirm nothing else regressed:

```bash
bun test tests/fs-dir-route.test.ts tests/fs-dir-sidecars.test.ts tests/fs-dir-asset-link.test.ts
```

Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add src/api/src/fs/browse.ts src/api/tests/fs-dir-excludes-trash.test.ts
git commit -m "feat(api): GET /api/fs/dir filters trashed assets"
```

---

## Task 9: Trash-GC worker

**Files:**
- Create: `src/api/src/workers/trash-gc.ts`
- Create: `src/api/tests/trash-gc.test.ts`
- Modify: `src/api/src/index.ts` (start/stop the worker)

Interval-fired purge: every 24h, for each asset where `deleted_at` is older than 30 days, unlink the file + its paired sidecars and delete the asset doc.

- [ ] **Step 1: Write the failing test**

Write `src/api/tests/trash-gc.test.ts`:

```ts
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { MongoClient, ObjectId, type Db } from "mongodb";
import { runTrashGcOnce } from "../src/workers/trash-gc.ts";

const TEST_DB = `maple_test_fp3_trash_gc_${process.pid}`;
const MONGO_URI = process.env.MAPLE_MONGO_URI ?? "mongodb://localhost:27017";

let mongo: MongoClient | null = null;
let mongoReachable = false;
let db: Db | null = null;
let tmpRoot: string;
let realTmpRoot: string;

async function tryConnect(): Promise<MongoClient | null> {
  const c = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 1500, connectTimeoutMS: 1500 });
  try { await c.connect(); await c.db("admin").command({ ping: 1 }); return c; }
  catch { try { await c.close(); } catch {}; return null; }
}

describe("trash-gc", () => {
  beforeAll(async () => {
    const { closeDb } = await import("../src/db/client.ts");
    await closeDb();
    process.env.MAPLE_MONGO_DB = TEST_DB;
    mongo = await tryConnect();
    mongoReachable = mongo !== null;
    if (!mongoReachable) return;
    db = mongo!.db(TEST_DB);
    await db.dropDatabase();
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "maple-fp3-gc-"));
    realTmpRoot = await fs.realpath(tmpRoot);
    process.env.MAPLE_ROOTS = realTmpRoot;
  });

  afterAll(async () => {
    if (tmpRoot) await fs.rm(tmpRoot, { recursive: true, force: true });
    if (mongo) await mongo.close();
  });

  test("purges files + docs older than the retention window; preserves fresh", async () => {
    if (!mongoReachable) return;
    const old = path.join(realTmpRoot, ".maple", "trash", "old.ARW");
    const oldXmp = path.join(realTmpRoot, ".maple", "trash", "old.xmp");
    const fresh = path.join(realTmpRoot, ".maple", "trash", "fresh.ARW");
    await fs.mkdir(path.dirname(old), { recursive: true });
    await fs.writeFile(old, "o"); await fs.writeFile(oldXmp, "ox"); await fs.writeFile(fresh, "f");

    const oldId = new ObjectId(); const freshId = new ObjectId(); const liveId = new ObjectId();
    const days = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();
    await db!.collection("assets").insertMany([
      { _id: oldId, folder_id: new ObjectId(), filename: "old.ARW", abs_path: old, size: 1, mtime: 0, indexed_at: days(60), deleted_at: days(31), original_path: "/x/old.ARW" } as never,
      { _id: freshId, folder_id: new ObjectId(), filename: "fresh.ARW", abs_path: fresh, size: 1, mtime: 0, indexed_at: days(60), deleted_at: days(7), original_path: "/x/fresh.ARW" } as never,
      { _id: liveId, folder_id: new ObjectId(), filename: "live.ARW", abs_path: path.join(realTmpRoot, "live.ARW"), size: 1, mtime: 0, indexed_at: days(1), deleted_at: null } as never,
    ]);

    const summary = await runTrashGcOnce({ retentionDays: 30 });
    expect(summary.purged).toBe(1);

    await expect(fs.stat(old)).rejects.toThrow();
    await expect(fs.stat(oldXmp)).rejects.toThrow();
    await fs.stat(fresh);
    expect(await db!.collection("assets").findOne({ _id: oldId })).toBeNull();
    expect(await db!.collection("assets").findOne({ _id: freshId })).not.toBeNull();
    expect(await db!.collection("assets").findOne({ _id: liveId })).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
bun test tests/trash-gc.test.ts
```

Expected: import failure.

- [ ] **Step 3: Implement the worker**

Write `src/api/src/workers/trash-gc.ts`:

```ts
/**
 * Trash garbage collector — purges trashed assets older than the
 * retention window. Per asset where `deleted_at < now - retentionDays`:
 *   1. Unlink the file at `abs_path` (already in .maple/trash/...).
 *   2. Unlink every paired sidecar.
 *   3. Delete the asset doc from Mongo.
 *
 * Idempotent. Best-effort on per-file failures: a failed unlink is logged
 * and the asset doc is still deleted so subsequent runs don't keep
 * retrying the same broken row.
 *
 * NOT a stage controller — this is a library-wide, interval-fired job.
 * Started from `src/api/src/index.ts` via setInterval.
 */

import { unlink } from "node:fs/promises";
import { assetsCollection } from "../db/client.ts";
import { listPairedSidecars } from "../fs/xmp.ts";
import { child as childLogger } from "../log.ts";

const log = childLogger("trash-gc");
const DAY_MS = 86_400_000;
const DEFAULT_RETENTION_DAYS = 30;
const DEFAULT_INTERVAL_MS = DAY_MS;

export interface TrashGcOptions {
  retentionDays?: number;
}

export interface TrashGcSummary {
  scanned: number;
  purged: number;
  errors: number;
}

/** One pass. Exported for tests + callable from setInterval. */
export async function runTrashGcOnce(opts: TrashGcOptions = {}): Promise<TrashGcSummary> {
  const retentionDays = opts.retentionDays ?? DEFAULT_RETENTION_DAYS;
  const cutoffIso = new Date(Date.now() - retentionDays * DAY_MS).toISOString();
  const coll = await assetsCollection();
  const cursor = coll.find(
    { deleted_at: { $lt: cutoffIso, $ne: null } },
    { projection: { _id: 1, abs_path: 1 } },
  );
  let scanned = 0;
  let purged = 0;
  let errors = 0;
  for await (const doc of cursor) {
    scanned++;
    const absPath = doc.abs_path;
    try { await unlink(absPath); } catch (err) {
      // ENOENT is fine — file might already be gone.
      const code = (err as { code?: string } | null)?.code;
      if (code !== "ENOENT") {
        errors++;
        log.warn({ absPath, err: err instanceof Error ? err.message : err }, "purge unlink failed");
      }
    }
    const sidecars = await listPairedSidecars(absPath);
    for (const sidecar of sidecars) {
      try { await unlink(sidecar); } catch (err) {
        const code = (err as { code?: string } | null)?.code;
        if (code !== "ENOENT") {
          errors++;
          log.warn({ sidecar, err: err instanceof Error ? err.message : err }, "purge sidecar unlink failed");
        }
      }
    }
    await coll.deleteOne({ _id: doc._id });
    purged++;
  }
  if (scanned > 0) log.info({ scanned, purged, errors }, "trash-gc pass complete");
  return { scanned, purged, errors };
}

export interface TrashGcHandle { stop: () => void }

/** Start a background loop. Returns a handle whose `stop()` cancels it. */
export function startTrashGc(opts: TrashGcOptions & { intervalMs?: number } = {}): TrashGcHandle {
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  let stopped = false;
  const tick = async () => {
    if (stopped) return;
    try { await runTrashGcOnce(opts); }
    catch (err) {
      log.error({ err: err instanceof Error ? err.message : err }, "trash-gc pass crashed");
    }
  };
  const timer = setInterval(() => { void tick(); }, intervalMs);
  // Fire once on startup so a freshly-booted server doesn't wait 24h
  // before its first sweep. Errors are swallowed by tick() so a stray
  // failure doesn't crash boot.
  void tick();
  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
}
```

- [ ] **Step 4: Wire the worker into `index.ts`**

Edit `src/api/src/index.ts`. Add `startTrashGc` to the import alongside the existing worker imports. Inside the existing boot flow (after the supervisor starts, in the same scope where you have a top-level `await ensureIndexes()` and worker startup), add:

```ts
const trashGc = startTrashGc({});
```

And inside whatever shutdown / `stopSupervisor()` block exists, call `trashGc.stop()` before exit.

If the boot flow is wrapped in a function (`run()` / similar), put the `startTrashGc` call there and the `stop()` call in the corresponding teardown. Search for `stopSupervisor` to find the exact handler.

- [ ] **Step 5: Run the test to verify it passes**

```bash
bun test tests/trash-gc.test.ts
```

Expected: 1 test passes.

- [ ] **Step 6: Commit**

```bash
git add src/api/src/workers/trash-gc.ts src/api/tests/trash-gc.test.ts src/api/src/index.ts
git commit -m "feat(api): trash-gc worker — 30-day retention"
```

---

## Task 10: Extend `FileProviderIdentifier` with `trash/<folderID>`

**Files:**
- Modify: `src/apple/Packages/MapleCore/Sources/MapleCore/FileProvider/FileProviderIdentifier.swift`
- Modify: `src/apple/Packages/MapleCore/Tests/MapleCoreTests/FileProviderIdentifierTests.swift`

- [ ] **Step 1: Add the failing tests**

Open `src/apple/Packages/MapleCore/Tests/MapleCoreTests/FileProviderIdentifierTests.swift` and add the following tests inside the existing test class:

```swift
    func testTrashRoundTrip() throws {
        let id = FileProviderIdentifier.trash(folderID: "650a1b2c3d4e5f6071829304")
        XCTAssertEqual(id.rawValue, "trash/650a1b2c3d4e5f6071829304")
        XCTAssertEqual(try FileProviderIdentifier(rawValue: id.rawValue), id)
    }

    func testTrashWithoutFolderIDRejected() {
        XCTAssertThrowsError(try FileProviderIdentifier(rawValue: "trash/"))
    }
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd src/apple/Packages/MapleCore
swift test --filter FileProviderIdentifierTests
```

Expected: build fails — `.trash` case missing.

- [ ] **Step 3: Add the case**

Open `src/apple/Packages/MapleCore/Sources/MapleCore/FileProvider/FileProviderIdentifier.swift`. Replace the entire `enum FileProviderIdentifier` body so it reads:

```swift
public enum FileProviderIdentifier: Equatable, Hashable, Sendable {
    case asset(String)
    case folder(folderID: String, relativePath: String)
    /// XMP sidecar paired to an asset. `conflictBasename` is nil for the
    /// canonical `<base>.xmp` and non-nil for conflict copies
    /// (`<base> (conflict from <device>).xmp`). The basename excludes the
    /// `.xmp` extension.
    case sidecar(assetID: String, conflictBasename: String?)
    /// Per-library Trash virtual container. Children = trashed asset items.
    case trash(folderID: String)

    public enum DecodeError: Error {
        case invalidPrefix, malformedFolder, malformedSidecar, malformedTrash, badBase64
    }

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
        case .trash(let folderID):
            return "trash/\(folderID)"
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
        if let body = rawValue.dropPrefixIfPresent("trash/") {
            let folderID = String(body)
            if folderID.isEmpty { throw DecodeError.malformedTrash }
            self = .trash(folderID: folderID)
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
```

The `private extension String { ... dropPrefixIfPresent ... }` block at the bottom of the file is unchanged.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
swift test --filter FileProviderIdentifierTests
```

Expected: all tests pass (existing + 2 new).

- [ ] **Step 5: Confirm the Apple build still works**

```bash
cd ../../   # back to src/apple
xcodebuild -project Maple.xcodeproj -scheme Maple -destination 'platform=macOS,arch=arm64' -quiet build 2>&1 | tail -5
```

Expected: `** BUILD SUCCEEDED **`.

- [ ] **Step 6: Commit**

```bash
git add src/apple/Packages/MapleCore/Sources/MapleCore/FileProvider/FileProviderIdentifier.swift \
        src/apple/Packages/MapleCore/Tests/MapleCoreTests/FileProviderIdentifierTests.swift
git commit -m "feat(core): FileProviderIdentifier.trash(folderID:)"
```

---

## Task 11: `RemoteCatalog` — upload, delete, restore, listTrash

**Files:**
- Modify: `src/apple/Packages/MapleCore/Sources/MapleCore/FileProvider/RemoteCatalog.swift`
- Modify: `src/apple/Packages/MapleCore/Tests/MapleCoreTests/RemoteCatalogTests.swift`

- [ ] **Step 1: Add failing decode tests**

Open `src/apple/Packages/MapleCore/Tests/MapleCoreTests/RemoteCatalogTests.swift` and add the following test methods inside the existing test class:

```swift
    func testDecodeTrashList() throws {
        let json = """
        {"items":[
          {"asset_id":"a1","filename":"IMG_1.ARW","original_relative_path":"2024/IMG_1.ARW",
           "trash_relative_path":".maple/trash/2024/IMG_1.ARW","size":40000000,
           "mtime":1700000000000,"deleted_at":"2026-05-15T10:00:00Z"}
        ],"next_cursor":null}
        """.data(using: .utf8)!
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        let resp = try decoder.decode(TrashListResponse.self, from: json)
        XCTAssertEqual(resp.items.count, 1)
        XCTAssertEqual(resp.items[0].assetID, "a1")
        XCTAssertEqual(resp.items[0].originalRelativePath, "2024/IMG_1.ARW")
        XCTAssertNil(resp.nextCursor)
    }

    func testDecodeRestoreResponse() throws {
        let json = """
        {"asset_id":"a1","abs_path":"/library/2024/IMG_1.restored.ARW"}
        """.data(using: .utf8)!
        let resp = try JSONDecoder().decode(RestoreResponse.self, from: json)
        XCTAssertEqual(resp.assetID, "a1")
        XCTAssertEqual(resp.absPath, "/library/2024/IMG_1.restored.ARW")
    }

    func testDecodeUploadResponse() throws {
        let json = """
        {"asset_id":"a1","abs_path":"/library/2024/IMG_2.ARW","size":12345,"mtime":1700000000000}
        """.data(using: .utf8)!
        let resp = try JSONDecoder().decode(UploadResponse.self, from: json)
        XCTAssertEqual(resp.assetID, "a1")
        XCTAssertEqual(resp.size, 12345)
    }
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd src/apple/Packages/MapleCore
swift test --filter RemoteCatalogTests
```

Expected: build fails — types missing.

- [ ] **Step 3: Add DTOs and methods to `RemoteCatalog`**

Open `src/apple/Packages/MapleCore/Sources/MapleCore/FileProvider/RemoteCatalog.swift`.

Add these public types above the `public actor RemoteCatalog` declaration:

```swift
public struct UploadResponse: Codable, Equatable, Sendable {
    public let assetID: String
    public let absPath: String
    public let size: Int64
    public let mtime: Int64

    enum CodingKeys: String, CodingKey {
        case absPath = "abs_path"
        case size, mtime
        case assetID = "asset_id"
    }
}

public struct TrashItem: Codable, Equatable, Sendable {
    public let assetID: String
    public let filename: String
    public let originalRelativePath: String
    public let trashRelativePath: String
    public let size: Int64
    public let mtime: Int64
    public let deletedAt: Date

    enum CodingKeys: String, CodingKey {
        case filename, size, mtime
        case assetID = "asset_id"
        case originalRelativePath = "original_relative_path"
        case trashRelativePath = "trash_relative_path"
        case deletedAt = "deleted_at"
    }
}

public struct TrashListResponse: Codable, Equatable, Sendable {
    public let items: [TrashItem]
    public let nextCursor: String?

    enum CodingKeys: String, CodingKey {
        case items
        case nextCursor = "next_cursor"
    }
}

public struct RestoreResponse: Codable, Equatable, Sendable {
    public let assetID: String
    public let absPath: String

    enum CodingKeys: String, CodingKey {
        case assetID = "asset_id"
        case absPath = "abs_path"
    }
}

public enum UploadOutcome: Equatable, Sendable {
    case ok(UploadResponse)
    case conflict
    case unsupported
}
```

Add these methods inside the `public actor RemoteCatalog` body:

```swift
    /// Upload a file to the given folder. Streams `fileURL` via
    /// `URLSession.uploadTask(with:fromFile:)`. Returns `.ok` on 201,
    /// `.conflict` on 409, `.unsupported` on 415; throws on anything else.
    public func uploadFile(
        folderID: String,
        targetRelativePath: String,
        fileURL: URL,
        mtime: Date?
    ) async throws -> UploadOutcome {
        var req = URLRequest(url: server.appending(path: "/api/folders/\(folderID)/upload"))
        req.httpMethod = "POST"
        req.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
        let encoded = targetRelativePath.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? targetRelativePath
        req.setValue(encoded, forHTTPHeaderField: "X-Maple-Target-Path")
        if let mtime {
            req.setValue(String(Int(mtime.timeIntervalSince1970)), forHTTPHeaderField: "X-Maple-File-Mtime")
        }
        let attrs = try FileManager.default.attributesOfItem(atPath: fileURL.path)
        let size = (attrs[.size] as? NSNumber)?.intValue ?? 0
        req.setValue(String(size), forHTTPHeaderField: "Content-Length")
        let (data, resp) = try await http.upload(for: req, fromFile: fileURL)
        let status = (resp as? HTTPURLResponse)?.statusCode ?? -1
        if status == 201 {
            return .ok(try decoder.decode(UploadResponse.self, from: data))
        }
        if status == 409 { return .conflict }
        if status == 415 { return .unsupported }
        throw URLError(.badServerResponse)
    }

    /// DELETE /api/assets/<id>. 204 = success; everything else throws.
    public func deleteAsset(assetID: String) async throws {
        var req = URLRequest(url: server.appending(path: "/api/assets/\(assetID)"))
        req.httpMethod = "DELETE"
        let (_, resp) = try await http.data(for: req)
        try Self.check2xx(resp)
    }

    /// POST /api/assets/<id>/restore. `targetRelativePath` is sent in the
    /// body when non-nil; server defaults to `original_path` otherwise.
    public func restoreAsset(assetID: String, targetRelativePath: String?) async throws -> RestoreResponse {
        var req = URLRequest(url: server.appending(path: "/api/assets/\(assetID)/restore"))
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let body: [String: String] = targetRelativePath != nil
            ? ["target_relative_path": targetRelativePath!]
            : [:]
        req.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (data, resp) = try await http.data(for: req)
        try Self.check2xx(resp)
        return try decoder.decode(RestoreResponse.self, from: data)
    }

    /// GET /api/folders/<id>/trash. `cursor` and `limit` are optional.
    public func listTrash(folderID: String, limit: Int? = nil, cursor: String? = nil) async throws -> TrashListResponse {
        var comps = URLComponents(url: server.appending(path: "/api/folders/\(folderID)/trash"),
                                  resolvingAgainstBaseURL: false)!
        var qi: [URLQueryItem] = []
        if let limit { qi.append(.init(name: "limit", value: String(limit))) }
        if let cursor { qi.append(.init(name: "cursor", value: cursor)) }
        if !qi.isEmpty { comps.queryItems = qi }
        let req = URLRequest(url: comps.url!)
        let (data, resp) = try await http.data(for: req)
        try Self.check2xx(resp)
        return try decoder.decode(TrashListResponse.self, from: data)
    }
```

If `AuthenticatedHTTPClient` doesn't have an `upload(for:fromFile:)` method, add a thin pass-through next to the existing `data(for:)` method. Look at the existing `AuthenticatedHTTPClient` (find with `grep -rln 'final.*class.*AuthenticatedHTTPClient' src/apple/Packages/MapleCore/Sources`) and add:

```swift
public func upload(for request: URLRequest, fromFile fileURL: URL) async throws -> (Data, URLResponse) {
    var attempted = false
    while true {
        var signed = request
        if let tokens = tokensProvider() {
            signed.setValue("Bearer \(tokens.accessToken)", forHTTPHeaderField: "Authorization")
        }
        let (data, resp) = try await urlSession.upload(for: signed, fromFile: fileURL)
        if let http = resp as? HTTPURLResponse, http.statusCode == 401, !attempted {
            attempted = true
            try await refreshTokensIfPossible()
            continue
        }
        return (data, resp)
    }
}
```

Match the existing refresh-on-401 logic in `data(for:)` — copy the exact retry shape so behaviour is consistent. (If the existing client uses a different pattern, follow that pattern instead.)

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd src/apple/Packages/MapleCore
swift test --filter RemoteCatalogTests
```

Expected: existing + 3 new tests pass.

- [ ] **Step 5: Confirm the Apple build still works**

```bash
cd ../../
xcodebuild -project Maple.xcodeproj -scheme Maple -destination 'platform=macOS,arch=arm64' -quiet build 2>&1 | tail -5
```

Expected: `** BUILD SUCCEEDED **`.

- [ ] **Step 6: Commit**

```bash
git add src/apple/Packages/MapleCore/Sources/MapleCore/FileProvider/RemoteCatalog.swift \
        src/apple/Packages/MapleCore/Tests/MapleCoreTests/RemoteCatalogTests.swift
git commit -m "feat(core): RemoteCatalog upload + delete + restore + listTrash"
```

If you had to modify `AuthenticatedHTTPClient`, include its file in the commit too.

---

## Task 12: `MapleItem` — trash container + trashed-asset initializers

**Files:**
- Modify: `src/apple/MapleFileProvider/MapleItem.swift`

Two new initializers:
- `MapleItem(trashContainer:displayName:)` — the synthetic `Trash` folder under each library root.
- `MapleItem(trashed:parentTrashIdentifier:)` — an asset inside Trash. Identifier stays `asset/<id>` so identity is stable across delete/restore.

- [ ] **Step 1: Add the initializers**

Open `src/apple/MapleFileProvider/MapleItem.swift`. Append these initializers inside the `final class MapleItem` definition:

```swift
    /// Synthetic Trash container shown at the root of each library.
    /// The identifier is `trash/<folderID>` so the extension can route
    /// `enumerator(for:)` to a `TrashEnumerator` and decide capabilities.
    init(trashContainer folderID: String, displayName: String) {
        self.identifier = .trash(folderID: folderID)
        self.displayName = displayName
        self.isDirectory = true
        self.size = nil
        self.modified = nil
        self.utType = .folder
        // Trash itself is read-only as a container — items inside it can be
        // moved out (restore) or deleted (permanent purge). Allowing
        // content enumeration is needed so Finder will fetch children.
        self.writeCapabilities = [.allowsReading]
        self.itemIdentifier = NSFileProviderItemIdentifier(self.identifier.rawValue)
        self.parentItemIdentifier = .rootContainer
        self.filename = displayName
    }

    /// Trashed asset surfaced inside the Trash container. Keeps the same
    /// `asset/<id>` identifier as the live item so identity is stable
    /// across delete/restore (per spec — server-side identifiers).
    /// Capabilities allow reading (lazy materialization still works on
    /// trashed files), reparenting (drag back out of Trash to restore),
    /// and deleting (drag inside trash → permanent purge).
    init(trashed item: TrashItem, parentTrashIdentifier: NSFileProviderItemIdentifier) {
        self.identifier = .asset(item.assetID)
        self.displayName = item.filename
        self.isDirectory = false
        self.size = NSNumber(value: item.size)
        self.modified = item.deletedAt
        self.utType = UTType(filenameExtension: (item.filename as NSString).pathExtension) ?? .data
        self.writeCapabilities = [.allowsReading, .allowsReparenting, .allowsDeleting]
        self.itemIdentifier = NSFileProviderItemIdentifier(self.identifier.rawValue)
        self.parentItemIdentifier = parentTrashIdentifier
        self.filename = item.filename
    }
```

- [ ] **Step 2: Confirm the Apple build still works**

```bash
cd src/apple
xcodebuild -project Maple.xcodeproj -scheme Maple -destination 'platform=macOS,arch=arm64' -quiet build 2>&1 | tail -5
```

Expected: `** BUILD SUCCEEDED **`.

- [ ] **Step 3: Commit**

```bash
git add src/apple/MapleFileProvider/MapleItem.swift
git commit -m "feat(fileprovider): MapleItem trash + trashed-asset initializers"
```

---

## Task 13: `TrashEnumerator` + root-enumerator surfaces a Trash item per library

**Files:**
- Modify: `src/apple/MapleFileProvider/MapleEnumerator.swift`

- [ ] **Step 1: Extend `RootEnumerator` and add `TrashEnumerator`**

Open `src/apple/MapleFileProvider/MapleEnumerator.swift`. Inside `RootEnumerator.enumerateItems`, after the existing `let items = roots.map { MapleItem(libraryRoot: $0) }`, append one Trash item per library root:

```swift
                var items: [NSFileProviderItem] = roots.map { MapleItem(libraryRoot: $0) }
                items.append(contentsOf: roots.map {
                    MapleItem(trashContainer: $0.id, displayName: "\($0.label) Trash")
                })
                observer.didEnumerate(items)
                observer.finishEnumerating(upTo: nil)
```

(Replace the existing `let items = ...` and `observer.didEnumerate(items)` lines with the four lines above.)

Then add this new enumerator class to the bottom of the file:

```swift
/// Per-library Trash enumerator. Paginates through `GET /api/folders/:id/trash`
/// and emits one `MapleItem(trashed:)` per row. The trashed items keep their
/// asset/<id> identifiers so the OS recognises them as the same item that
/// disappeared from a folder enumeration.
final class TrashEnumerator: NSObject, NSFileProviderEnumerator {
    private let catalog: RemoteCatalog
    private let folderID: String
    private let containerIdentifier: NSFileProviderItemIdentifier
    private let log = Logger(subsystem: "app.justmaple.aperture.fileprovider", category: "enumerator")

    init(catalog: RemoteCatalog, folderID: String, containerIdentifier: NSFileProviderItemIdentifier) {
        self.catalog = catalog
        self.folderID = folderID
        self.containerIdentifier = containerIdentifier
    }

    func invalidate() {}

    func enumerateItems(for observer: NSFileProviderEnumerationObserver, startingAt page: NSFileProviderPage) {
        Task {
            do {
                // Cursor encoded as the page bytes when present; nil for first page.
                let cursor: String? = {
                    guard let s = String(data: page.rawValue, encoding: .utf8), !s.isEmpty, s != "0" else { return nil }
                    return s
                }()
                let resp = try await catalog.listTrash(folderID: folderID, limit: 200, cursor: cursor)
                let items = resp.items.map { MapleItem(trashed: $0, parentTrashIdentifier: containerIdentifier) }
                observer.didEnumerate(items)
                if let nextCursor = resp.nextCursor {
                    observer.finishEnumerating(upTo: NSFileProviderPage(Data(nextCursor.utf8)))
                } else {
                    observer.finishEnumerating(upTo: nil)
                }
            } catch {
                log.error("trash enumerate failed: \(error.localizedDescription, privacy: .public)")
                observer.finishEnumeratingWithError(error)
            }
        }
    }

    func enumerateChanges(for observer: NSFileProviderChangeObserver, from anchor: NSFileProviderSyncAnchor) {
        observer.finishEnumeratingChanges(upTo: anchor, moreComing: false)
    }

    func currentSyncAnchor(completionHandler: @escaping (NSFileProviderSyncAnchor?) -> Void) {
        completionHandler(NSFileProviderSyncAnchor(Data("0".utf8)))
    }
}
```

- [ ] **Step 2: Confirm the Apple build still works**

```bash
cd src/apple
xcodebuild -project Maple.xcodeproj -scheme Maple -destination 'platform=macOS,arch=arm64' -quiet build 2>&1 | tail -5
```

Expected: `** BUILD SUCCEEDED **`.

- [ ] **Step 3: Commit**

```bash
git add src/apple/MapleFileProvider/MapleEnumerator.swift
git commit -m "feat(fileprovider): TrashEnumerator + root emits Trash containers"
```

---

## Task 14: Wire `enumerator(for:)` to route trash containers + handle `.trash` in `item(for:)`

**Files:**
- Modify: `src/apple/MapleFileProvider/FileProviderExtension.swift`

- [ ] **Step 1: Route `trash/<folderID>` in `enumerator(for:)`**

Find the `enumerator(for containerItemIdentifier:request:)` method. After the existing `if containerItemIdentifier == .workingSet || containerItemIdentifier == .trashContainer` early-return, the next block parses the identifier in a `switch parsed`. Extend it so the `.trash` case is handled:

Replace:

```swift
        let parsed = try FileProviderIdentifier(rawValue: containerItemIdentifier.rawValue)
        switch parsed {
        case .folder(let folderID, let relativePath):
            return DeferredFolderEnumerator(catalog: catalog,
                                            rootCache: rootCache,
                                            folderID: folderID,
                                            relativePath: relativePath,
                                            containerIdentifier: containerItemIdentifier)
        case .asset:
            throw NSError(domain: NSFileProviderErrorDomain,
                          code: NSFileProviderError.noSuchItem.rawValue)
        case .sidecar:
            // Sidecars are leaf items, not containers — cannot be enumerated.
            throw NSError(domain: NSFileProviderErrorDomain,
                          code: NSFileProviderError.noSuchItem.rawValue)
        }
```

with:

```swift
        let parsed = try FileProviderIdentifier(rawValue: containerItemIdentifier.rawValue)
        switch parsed {
        case .folder(let folderID, let relativePath):
            return DeferredFolderEnumerator(catalog: catalog,
                                            rootCache: rootCache,
                                            folderID: folderID,
                                            relativePath: relativePath,
                                            containerIdentifier: containerItemIdentifier)
        case .trash(let folderID):
            return TrashEnumerator(catalog: catalog,
                                   folderID: folderID,
                                   containerIdentifier: containerItemIdentifier)
        case .asset:
            throw NSError(domain: NSFileProviderErrorDomain,
                          code: NSFileProviderError.noSuchItem.rawValue)
        case .sidecar:
            throw NSError(domain: NSFileProviderErrorDomain,
                          code: NSFileProviderError.noSuchItem.rawValue)
        }
```

- [ ] **Step 2: Handle `.trash` in `item(for:)`**

Find the `item(for identifier:request:completionHandler:)` method. Inside its `switch parsed` (which currently has `.folder / .asset / .sidecar` cases), add a `.trash` case that synthesizes a `MapleItem(trashContainer:displayName:)` using the cached library-root label:

```swift
                case .trash(let folderID):
                    let roots = try await rootCache.roots()
                    guard let root = roots.first(where: { $0.id == folderID }) else {
                        completionHandler(nil, NSError(domain: NSFileProviderErrorDomain,
                                                       code: NSFileProviderError.noSuchItem.rawValue))
                        return
                    }
                    completionHandler(MapleItem(trashContainer: folderID, displayName: "\(root.label) Trash"), nil)
                    return
```

Place this case alongside the existing `.folder / .asset / .sidecar` cases inside that switch.

- [ ] **Step 3: Confirm the Apple build still works**

```bash
cd src/apple
xcodebuild -project Maple.xcodeproj -scheme Maple -destination 'platform=macOS,arch=arm64' -quiet build 2>&1 | tail -5
```

Expected: `** BUILD SUCCEEDED **`.

- [ ] **Step 4: Commit**

```bash
git add src/apple/MapleFileProvider/FileProviderExtension.swift
git commit -m "feat(fileprovider): route trash containers in enumerator + item lookup"
```

---

## Task 15: Implement `createItem` for uploads

**Files:**
- Modify: `src/apple/MapleFileProvider/FileProviderExtension.swift`

The current `createItem` is XMP-only. Extend it: when the parent is a normal folder AND the filename's extension is in the upload allowlist (RAW + bitmap), upload the bytes; XMP path stays as-is.

- [ ] **Step 1: Add an upload-allowlist constant**

Inside the `FileProviderExtension` class (near the top, after the stored properties), add:

```swift
    private static let uploadableExtensions: Set<String> = [
        // RAW formats (match server `RAW_EXTENSIONS`).
        "cr2", "cr3", "nef", "arw", "dng", "raf", "orf", "rw2", "pef", "srw",
        // Bitmap formats (match server `SHARP_EXTENSIONS`).
        "jpg", "jpeg", "png", "webp", "gif", "tif", "tiff", "heic", "heif", "avif",
    ]
```

- [ ] **Step 2: Replace `createItem` with an extension-aware dispatcher**

Replace the entire body of `createItem(basedOn:fields:contents:options:request:completionHandler:)` with:

```swift
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
        let filename = itemTemplate.filename
        let dot = filename.lastIndex(of: ".")
        let ext = dot.map { String(filename[filename.index(after: $0)...]).lowercased() } ?? ""

        // Phase 2 path: XMP sidecar create.
        if ext == "xmp" {
            return createXMPItem(basedOn: itemTemplate, contents: url, catalog: catalog, completionHandler: completionHandler)
        }

        // Phase 3 path: drag-in upload.
        if Self.uploadableExtensions.contains(ext) {
            return uploadItem(basedOn: itemTemplate, contents: url, catalog: catalog, completionHandler: completionHandler)
        }

        completionHandler(nil, [], false,
            NSError(domain: NSCocoaErrorDomain, code: NSFeatureUnsupportedError))
        return Progress()
    }

    /// XMP sidecar create — preserved from Phase 2.
    private func createXMPItem(basedOn itemTemplate: NSFileProviderItem,
                               contents url: URL?,
                               catalog: RemoteCatalog,
                               completionHandler: @escaping (NSFileProviderItem?, NSFileProviderItemFields, Bool, Error?) -> Void) -> Progress {
        guard let contentsURL = url else {
            completionHandler(nil, [], false,
                NSError(domain: NSCocoaErrorDomain, code: NSFeatureUnsupportedError))
            return Progress()
        }
        let progress = Progress(totalUnitCount: 1)
        let filename = itemTemplate.filename
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
                        name: filename, path: filename, mtime: mtime,
                        size: Int64(xmpBytes.count), assetID: assetID,
                    )
                    let baseFromFilename = Self.canonicalBase(forSidecarFilename: filename)
                    let item = MapleItem(sidecar: synthesized,
                                         parentImageBase: baseFromFilename,
                                         parentIdentifier: parentID)
                    completionHandler(item, [], false, nil)
                case .conflict(let conflictPath, let conflictMtime):
                    self.log.notice("createItem XMP conflict — \(conflictPath, privacy: .public)")
                    let conflictName = (conflictPath as NSString).lastPathComponent
                    let synthesized = SidecarChild(
                        name: conflictName, path: conflictPath, mtime: conflictMtime,
                        size: Int64(xmpBytes.count), assetID: assetID,
                    )
                    let baseFromFilename = Self.canonicalBase(forSidecarFilename: filename)
                    let collidingItem = MapleItem(sidecar: synthesized,
                                                  parentImageBase: baseFromFilename,
                                                  parentIdentifier: parentID)
                    completionHandler(nil, [], false,
                        NSError(domain: NSFileProviderErrorDomain,
                                code: NSFileProviderError.filenameCollision.rawValue,
                                userInfo: [NSFileProviderErrorItemKey: collidingItem]))
                    await self.signalEnumeratorReload(parent: parentID)
                }
            } catch {
                self.log.error("createItem XMP failed: \(error.localizedDescription, privacy: .public)")
                completionHandler(nil, [], false, error)
            }
        }
        return progress
    }

    /// Drag-in upload — Phase 3. Parent must be a normal folder under a
    /// library root; trash containers reject uploads with featureUnsupported.
    private func uploadItem(basedOn itemTemplate: NSFileProviderItem,
                            contents url: URL?,
                            catalog: RemoteCatalog,
                            completionHandler: @escaping (NSFileProviderItem?, NSFileProviderItemFields, Bool, Error?) -> Void) -> Progress {
        guard let contentsURL = url else {
            completionHandler(nil, [], false,
                NSError(domain: NSCocoaErrorDomain, code: NSFileWriteUnknownError))
            return Progress()
        }
        let parentID = itemTemplate.parentItemIdentifier
        let parsed: FileProviderIdentifier
        do { parsed = try FileProviderIdentifier(rawValue: parentID.rawValue) }
        catch {
            completionHandler(nil, [], false,
                NSError(domain: NSFileProviderErrorDomain,
                        code: NSFileProviderError.noSuchItem.rawValue))
            return Progress()
        }
        // Reject uploads into the root container or into a trash container.
        guard case .folder(let folderID, let parentRelative) = parsed else {
            completionHandler(nil, [], false,
                NSError(domain: NSCocoaErrorDomain, code: NSFeatureUnsupportedError))
            return Progress()
        }
        let filename = itemTemplate.filename
        let targetRel = parentRelative.isEmpty ? filename : "\(parentRelative)/\(filename)"
        let progress = Progress(totalUnitCount: 1)
        Task {
            defer { progress.completedUnitCount = 1 }
            do {
                let outcome = try await catalog.uploadFile(
                    folderID: folderID,
                    targetRelativePath: targetRel,
                    fileURL: contentsURL,
                    mtime: itemTemplate.contentModificationDate ?? nil,
                )
                switch outcome {
                case .ok(let resp):
                    let attrs = try? FileManager.default.attributesOfItem(atPath: contentsURL.path)
                    let size = Int64((attrs?[.size] as? NSNumber)?.intValue ?? Int(resp.size))
                    let modified = Date(timeIntervalSince1970: TimeInterval(resp.mtime) / 1000)
                    let ext = (filename as NSString).pathExtension.lowercased()
                    let image = ImageChild(
                        name: filename,
                        path: resp.absPath,
                        mtime: modified,
                        size: size,
                        ext: ext,
                        assetID: resp.assetID,
                    )
                    if let item = MapleItem(image: image, parentIdentifier: parentID) {
                        completionHandler(item, [], false, nil)
                    } else {
                        completionHandler(nil, [], false,
                            NSError(domain: NSFileProviderErrorDomain,
                                    code: NSFileProviderError.noSuchItem.rawValue))
                    }
                    await self.signalEnumeratorReload(parent: parentID)
                case .conflict:
                    completionHandler(nil, [], false,
                        NSError(domain: NSFileProviderErrorDomain,
                                code: NSFileProviderError.filenameCollision.rawValue))
                case .unsupported:
                    completionHandler(nil, [], false,
                        NSError(domain: NSCocoaErrorDomain, code: NSFileWriteUnknownError))
                }
            } catch {
                self.log.error("upload failed: \(error.localizedDescription, privacy: .public)")
                completionHandler(nil, [], false, error)
            }
        }
        return progress
    }
```

- [ ] **Step 2: Confirm the Apple build still works**

```bash
cd src/apple
xcodebuild -project Maple.xcodeproj -scheme Maple -destination 'platform=macOS,arch=arm64' -quiet build 2>&1 | tail -5
```

Expected: `** BUILD SUCCEEDED **`.

- [ ] **Step 3: Commit**

```bash
git add src/apple/MapleFileProvider/FileProviderExtension.swift
git commit -m "feat(fileprovider): createItem dispatches XMP create + drag-in upload"
```

---

## Task 16: Rewrite `deleteItem` to handle assets (trash) AND XMPs (existing behaviour)

**Files:**
- Modify: `src/apple/MapleFileProvider/FileProviderExtension.swift`

Currently `deleteItem` rejects every identifier that isn't a sidecar. Extend it: `.asset(id)` → `catalog.deleteAsset(assetID:)`; `.sidecar(...)` keeps its existing path; folder + trash containers reject with `featureUnsupported`.

- [ ] **Step 1: Replace the body**

Replace `deleteItem(identifier:baseVersion:options:request:completionHandler:)` with:

```swift
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
        let progress = Progress(totalUnitCount: 1)
        Task {
            defer { progress.completedUnitCount = 1 }
            do {
                switch parsed {
                case .sidecar(let assetID, let conflictBasename):
                    try await catalog.deleteXMP(assetID: assetID, conflictBasename: conflictBasename)
                    completionHandler(nil)
                case .asset(let assetID):
                    // Server distinguishes trash-vs-purge based on the current
                    // doc state; we just call DELETE. Idempotent.
                    try await catalog.deleteAsset(assetID: assetID)
                    completionHandler(nil)
                case .folder, .trash:
                    completionHandler(NSError(domain: NSCocoaErrorDomain, code: NSFeatureUnsupportedError))
                }
            } catch {
                self.log.error("deleteItem failed: \(error.localizedDescription, privacy: .public)")
                completionHandler(error)
            }
        }
        return progress
    }
```

- [ ] **Step 2: Confirm the Apple build still works**

```bash
cd src/apple
xcodebuild -project Maple.xcodeproj -scheme Maple -destination 'platform=macOS,arch=arm64' -quiet build 2>&1 | tail -5
```

Expected: `** BUILD SUCCEEDED **`.

- [ ] **Step 3: Commit**

```bash
git add src/apple/MapleFileProvider/FileProviderExtension.swift
git commit -m "feat(fileprovider): deleteItem handles asset trash + XMP delete"
```

---

## Task 17: Recognise restore in `modifyItem` (reparent from trash → folder)

**Files:**
- Modify: `src/apple/MapleFileProvider/FileProviderExtension.swift`

When the OS calls `modifyItem` with `changedFields` containing `.parentItemIdentifier`, the new parent is a `folder/...`, and the old parent (from the item passed in) was a `trash/...` — treat this as a restore. Compute the target relative path from the new parent + the item's current filename, call `restoreAsset`.

- [ ] **Step 1: Extend `modifyItem` with the restore branch**

Find `modifyItem(_:baseVersion:changedFields:contents:options:request:completionHandler:)`. Currently it only handles `.sidecar`. Add a restore branch ahead of the sidecar path:

Replace the top of the method (up through the `let parsed` decode) with:

```swift
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
        let parsed: FileProviderIdentifier
        do { parsed = try FileProviderIdentifier(rawValue: item.itemIdentifier.rawValue) }
        catch {
            completionHandler(nil, [], false,
                NSError(domain: NSCocoaErrorDomain, code: NSFeatureUnsupportedError))
            return Progress()
        }

        // Restore: the only `modifyItem` shape Phase 3 understands for assets
        // is reparent FROM a trash container TO a folder, with no other
        // changes. Anything else (rename, in-place modify) is rejected.
        if case .asset(let assetID) = parsed,
           changedFields.contains(.parentItemIdentifier) {
            let newParentID = item.parentItemIdentifier
            let newParentParsed: FileProviderIdentifier
            do { newParentParsed = try FileProviderIdentifier(rawValue: newParentID.rawValue) }
            catch {
                completionHandler(nil, [], false,
                    NSError(domain: NSCocoaErrorDomain, code: NSFeatureUnsupportedError))
                return Progress()
            }
            // Phase 3 only restores into a normal folder under the SAME library.
            // Cross-library moves and renames-during-restore are deferred.
            guard case .folder(let newFolderID, let newRelative) = newParentParsed else {
                completionHandler(nil, [], false,
                    NSError(domain: NSCocoaErrorDomain, code: NSFeatureUnsupportedError))
                return Progress()
            }
            let progress = Progress(totalUnitCount: 1)
            Task {
                defer { progress.completedUnitCount = 1 }
                do {
                    let filename = item.filename
                    let targetRel = newRelative.isEmpty ? filename : "\(newRelative)/\(filename)"
                    let resp = try await catalog.restoreAsset(assetID: assetID, targetRelativePath: targetRel)
                    // Synthesize a fresh asset item at the new location.
                    let attrs = try? FileManager.default.attributesOfItem(atPath: resp.absPath)
                    let size = Int64((attrs?[.size] as? NSNumber)?.intValue ?? 0)
                    let modified = (attrs?[.modificationDate] as? Date) ?? Date()
                    let restoredName = (resp.absPath as NSString).lastPathComponent
                    let ext = (restoredName as NSString).pathExtension.lowercased()
                    let image = ImageChild(
                        name: restoredName,
                        path: resp.absPath,
                        mtime: modified,
                        size: size,
                        ext: ext,
                        assetID: resp.assetID,
                    )
                    if let restored = MapleItem(image: image, parentIdentifier: newParentID) {
                        completionHandler(restored, [], false, nil)
                    } else {
                        completionHandler(nil, [], false,
                            NSError(domain: NSFileProviderErrorDomain,
                                    code: NSFileProviderError.noSuchItem.rawValue))
                    }
                    await self.signalEnumeratorReload(parent: newParentID)
                    void(newFolderID) // silence unused-let warning; identity already validated
                } catch {
                    self.log.error("restore failed: \(error.localizedDescription, privacy: .public)")
                    completionHandler(nil, [], false, error)
                }
            }
            return progress
        }

        // Phase 2 path: XMP sidecar modify (unchanged).
        guard case .sidecar(let assetID, let conflictBasename) = parsed,
              let contentsURL = newContents else {
            completionHandler(nil, [], false,
                NSError(domain: NSCocoaErrorDomain, code: NSFeatureUnsupportedError))
            return Progress()
        }
```

(Continue with the existing sidecar `priorMtime` decode + write logic — leave that untouched.)

Add a tiny `func void(_: Any) {}` near the bottom of the file if the compiler still complains about `newFolderID`, OR replace the `void(newFolderID)` line with `_ = newFolderID`.

- [ ] **Step 2: Confirm the Apple build still works**

```bash
cd src/apple
xcodebuild -project Maple.xcodeproj -scheme Maple -destination 'platform=macOS,arch=arm64' -quiet build 2>&1 | tail -5
```

Expected: `** BUILD SUCCEEDED **`.

- [ ] **Step 3: Commit**

```bash
git add src/apple/MapleFileProvider/FileProviderExtension.swift
git commit -m "feat(fileprovider): modifyItem routes reparent-from-trash to restore"
```

---

## Task 18: Final API + Apple integration verification

**Files:** none (verification only)

- [ ] **Step 1: Run the full API test suite**

```bash
cd src/api
bun test 2>&1 | tail -40
```

Expected: every test green. If anything regressed, fix before continuing.

- [ ] **Step 2: Run the full MapleCore Swift test suite**

```bash
cd src/apple/Packages/MapleCore
swift test 2>&1 | tail -20
```

Expected: every test green.

- [ ] **Step 3: Final Apple build**

```bash
cd src/apple
xcodebuild -project Maple.xcodeproj -scheme Maple -destination 'platform=macOS,arch=arm64' -quiet build 2>&1 | tail -10
```

Expected: `** BUILD SUCCEEDED **`.

- [ ] **Step 4: Smoke-test the Bun server can boot**

```bash
cd src/api
bun -e "import('./src/index.ts').then(() => console.log('OK'))" 2>&1 | tail -5
```

Expected: prints `OK` (or starts the listener — that's fine, kill it with ^C). No imports throw.

---

## Manual verification (one-time, requires a running server + Maple-app sign-in)

Phase 3 is not done until this works end-to-end. Same pattern as Phase 1's manual section.

1. **Start the API** with a folder registered:
   ```bash
   cd src/api && MAPLE_ROOTS=/tmp/maple-test-lib bun run dev
   ```
   Register `/tmp/maple-test-lib` via the existing settings UI or admin route.

2. **Sign in to Maple** so an `AuthTokens` entry lands in the shared Keychain.

3. **Open Settings → Server**, enable the Finder integration for the local server.

4. **Drag a JPEG and a CR3 from `~/Downloads` into the Maple folder.**
   Confirm both upload (Finder shows progress, files appear in the target folder), and that the Maple app's browse view picks them up within a few seconds.

5. **Drag a `.txt` file into the Maple folder.**
   Expected: Finder shows an error dialog ("operation can't be completed"). No file on the server.

6. **Drag one of the uploaded files to the Trash.**
   Confirm the file disappears from the Maple folder in Finder.

7. **Open the per-library Trash folder** (visible at the root of the library, sibling of the library root).
   Confirm the deleted file is listed with its deletion timestamp.

8. **Drag it back from Trash to the Maple folder.**
   Confirm it reappears in the original location. Verify in the Maple app that `deleted_at` is cleared.

9. **Pre-stage a collision: drag a file in, delete it, drag a new file with the same name in, then restore the trashed one.**
   Expected: the restored file gets a `.restored` suffix.

10. **From inside Trash, delete an item.**
    Expected: file permanently disappears from disk and from the Maple app's browse view.

11. **Inspect the watcher logs (`bun run dev` console).** Confirm no `removed` events were processed for files under `.maple/trash/...` (the dotfile filter excludes them).

If any step fails, debug before declaring Phase 3 done. Common failure modes:
- **Restore lands in the wrong place:** `original_path` wasn't written by DELETE, or the restore handler isn't reading it.
- **`.maple/trash/` shows up in regular Finder views:** the root enumerator is emitting the wrong parent identifier for the Trash container, or the dotfile filter regressed in `listDirContents`.
- **Upload succeeds but the asset never indexes:** the upload handler isn't seeding `stages: blankStagesSkeleton()`, or the stage controllers aren't polling. Check `db.assets.findOne({ ... }).stages` — every entry should have `version: 0, processed_at: null`.

---

## What ships at the end of Phase 3

A user can:
1. Drag a JPEG, PNG, HEIC, TIFF, or RAW file from anywhere on their Mac into any folder in the Maple Finder mount. The file uploads to the server and indexes via the existing stage controllers.
2. Drag any indexed asset to the Trash. The file moves to `<root>/.maple/trash/<rel>`, paired sidecars travel with it, the asset doc is flagged with `deleted_at` and `original_path`, and the asset disappears from normal folder views in both Finder and the Maple app's browse view.
3. Open the per-library "Trash" virtual folder at the root of each library, see what's been deleted and when.
4. Drag a file from Trash back to any folder under that library root. Server moves it back, collisions resolve with a `.restored[.N]` suffix.
5. Delete a file from inside the Trash folder — file and asset doc are purged immediately, irreversibly.
6. Wait 30 days for un-restored trash to GC automatically (worker fires once at boot then every 24h).

The RAW bytes themselves are never modified in place. Uploads write new files; trash/restore atomic-rename existing ones; the GC unlinks long-trashed files. No Phase 3 code path mutates a RAW.

---

## Self-review checklist

- ✅ **Spec coverage** — every scope item from `.archived-plans/specs/2026-05-16-file-provider-phase3-design.md` is covered:
  - upload endpoint (Task 4), DELETE endpoint with trash + purge (Task 5), restore endpoint (Task 6), trash listing (Task 7), `fs/dir` excludes trash (Task 8), trash-gc (Task 9), `.trash` identifier (Task 10), `RemoteCatalog` methods (Task 11), trash container + trashed-item `MapleItem` (Task 12), `TrashEnumerator` + root surfaces trash (Task 13), `enumerator(for:)` + `item(for:)` route trash (Task 14), `createItem` upload (Task 15), `deleteItem` asset path (Task 16), `modifyItem` restore (Task 17).
  - Sidecar travel-with-asset: implemented via `listPairedSidecars` (Task 2) reused by `moveToTrash` / `moveOutOfTrash` (Task 3) and `runTrashGcOnce` (Task 9).
- ✅ **Placeholder scan** — every task has runnable code; no `TODO`, no "add error handling," no skeletons.
- ✅ **Type consistency** — `FileProviderIdentifier.trash`, `TrashItem`, `TrashListResponse`, `RestoreResponse`, `UploadResponse`, `UploadOutcome`, `moveToTrash`, `moveOutOfTrash`, `runTrashGcOnce`, `listPairedSidecars` — same spellings across all tasks.
- ✅ **Phase boundary** — no rename, no cross-folder move, no in-place RAW modify, no bulk-empty-trash route, no iOS write paths, no push channel.
- ✅ **Deviations from spec called out at the top** — `indexer_queue` row replaced with `stages: blankStagesSkeleton()`; `trash-gc` placed as a standalone interval worker rather than a `stageManifest` entry; `original_path` field added to disambiguate trash-vs-vanished assets.
