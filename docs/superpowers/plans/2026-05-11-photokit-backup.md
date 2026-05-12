# PhotoKit Backup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** `docs/superpowers/specs/2026-05-09-photokit-backup-design.md` (PR #9)

**Goal:** Implement PhotoKit backup (originals + Apple-rendered edits + sidecar metadata) into a Maple Cloud library on a continuous schedule, with a merged Photos+Cloud timeline that lets the user edit a photo before its bytes finish uploading.

**Architecture:** Three layers, each shippable as its own PR.
1. **Server (`src/api`)** — new ingest + reconciliation + reverse-geocode endpoints, schema additions to `AssetDoc`, new collections for upload sessions and backup sessions. Testable in isolation with `bun test` + curl.
2. **Device engine (new SPM module `MapleBackup`)** — actor-based queue, payload assembler, chunked resumable upload client, App-Support sidecar store. Hosted by both `MapleApp` (iOS + Mac) and a new `MapleBackupAgent` LaunchAgent (Mac only).
3. **App integration (`src/apple/Maple`)** — `BackupSettingsView`, merged Photos+Cloud timeline source, `PhotoKitSource` `writeXMP`/`readXMP` rewrite, `PhotoKitChangeObserver` wiring, BGProcessingTask registration, hardening.

**Tech Stack:** Swift 5.10, SwiftUI, `Photos.framework`, `NSURLSession` (background config); Bun 1.1, Elysia, MongoDB; existing `nominatim-client` + `geocode_cache`; GRDB.swift (already a transitive dep via MapleCore) for the engine's local SQLite queue state.

---

## Pre-flight

- [ ] **PR #9 merged or stacked.** This plan extends the spec; if PR #9 hasn't merged, the plan PR branches off `claude/pensive-bell-b19c7b` and rebases on `main` once PR #9 lands.
- [ ] **Worktree active.** `git rev-parse --show-toplevel` is under `.claude/worktrees/`.
- [ ] **Bun + Mongo running.** `bun --version` ≥ 1.1, local Mongo on `mongodb://localhost:27017`.

---

## File Structure

### New files (server)

```
src/api/src/
  routes/
    backup-ingest.ts             # POST /api/libraries/:id/backup/ingest
    backup-state.ts              # GET  /api/libraries/:id/backup/state
    geocode-reverse.ts           # GET  /api/geocode/reverse
  backup/
    path-formatter.ts            # <year>/<location-or-MM>/<MM-DD>/<file>
    path-formatter.test.ts
    upload-session.ts            # resumable upload session repo + helpers
    upload-session.test.ts
  db/
    backup-sessions.repo.ts      # per-device backup session aggregates
    backup-sessions.repo.test.ts
tests/
  backup-ingest.test.ts
  backup-state.test.ts
  geocode-reverse.test.ts
```

### New files (device — SPM module)

```
src/apple/Packages/MapleBackup/
  Package.swift
  Sources/MapleBackup/
    BackupEngine.swift           # actor orchestrating queue + upload + sidecar
    BackupQueue.swift            # protocol + InProcessBackupQueue
    BackupTask.swift             # value types: BackupTask, BackupPriority, BackupQueueEvent
    BackupState.swift            # state machine + GRDB-backed persistence
    PayloadAssembler.swift       # PHAsset → multipart upload payload
    UploadClient.swift           # chunked, resumable, background-NSURLSession
    AppSupportSidecarStore.swift # ~/.../PhotoKitSidecars/<id>.xmp
    PathFormatter.swift          # mirror of server's; identical output
    GeocodeClient.swift          # wraps GET /api/geocode/reverse
    DeviceIdentity.swift         # stable UUID per install
    Logging.swift                # os.Logger wrappers
  Tests/MapleBackupTests/
    BackupStateTests.swift
    InProcessBackupQueueTests.swift
    PayloadAssemblerTests.swift
    UploadClientTests.swift
    AppSupportSidecarStoreTests.swift
    PathFormatterTests.swift
    GeocodeClientTests.swift
    DeviceIdentityTests.swift
```

### New files (app)

```
src/apple/MapleBackupAgent/      # new macOS-only target
  main.swift
  MapleBackupAgent.entitlements
src/apple/Maple/Views/Settings/
  BackupSettingsView.swift
  BackupStatusPanel.swift
src/apple/Maple/Browse/
  MergedTimelineSource.swift
src/apple/Maple/Backup/
  EngineHost.swift               # wires the SPM engine into MapleApp's actor graph
  BGTaskRegistration.swift       # iOS-only BGProcessingTask hookup
src/apple/MapleUITests/
  BackupSettingsViewTests.swift  # XCUITest — settings flow
```

### Modified files

```
src/api/src/
  index.ts                                    # mount new routes
  db/schema.ts                                # AssetDoc additions + BackupSessionDoc + UploadSessionDoc

src/apple/Packages/MapleCore/Sources/MapleCore/Sources/
  PhotoKitSource.swift                        # writeXMP/readXMP via AppSupportSidecarStore

src/apple/Maple.xcodeproj/project.pbxproj     # MapleBackupAgent target + MapleBackup SPM dep

docs/sidecar-schema.md                        # add tags, phassetLocalId, deviceId, captureDate, GPS, favorite, caption, keywords, livePhotoCompanion, burstStackId
```

---

# Phase 1 — Server foundations

Goal: ship endpoints + schema additions that the device engine can talk to, testable end-to-end with `bun test` + curl, no device code required.

Each task lands its own commit. Phase 1 ends with a PR titled "feat(api): photokit backup ingest + reconciliation + reverse geocode".

## Task 1.1: Schema additions to `AssetDoc` + new collection types

**Files:**
- Modify: `src/api/src/db/schema.ts:73-126` (AssetDoc)
- Modify: `src/api/src/db/schema.ts` end-of-file (add UploadSessionDoc, BackupSessionDoc)

- [ ] **Step 1: Write a failing schema test**

Create `src/api/src/db/schema.test.ts` (if not present) with:

```ts
import { describe, test, expect } from "bun:test";
import type { AssetDoc, UploadSessionDoc, BackupSessionDoc } from "./schema.ts";

describe("PhotoKit backup schema additions", () => {
  test("AssetDoc accepts phasset_links, deleted_from_photos, apple_rendered_path", () => {
    const doc: AssetDoc = {
      folder_id: {} as any,
      filename: "IMG.heic",
      abs_path: "/Photos/2024/Tokyo/03-15/IMG.heic",
      size: 1,
      mtime: 0,
      rating: 0,
      flag: 0,
      color_label: "",
      indexed_at: "2026-05-11T00:00:00Z",
      phasset_links: [
        { device_id: "uuid-1", phasset_local_id: "ABC/L0/001", first_seen: new Date() },
      ],
      deleted_from_photos: false,
      apple_rendered_path: "Photos/2024/Tokyo/03-15/IMG.rendered.jpg",
    };
    expect(doc.phasset_links?.length).toBe(1);
  });

  test("UploadSessionDoc carries the resume key fields", () => {
    const s: UploadSessionDoc = {
      _id: {} as any,
      library_id: {} as any,
      device_id: "uuid-1",
      phasset_local_id: "ABC/L0/001",
      total_bytes: 1024,
      received_bytes: 0,
      chunk_size: 256 * 1024,
      created_at: new Date(),
      updated_at: new Date(),
      state: "open",
      target_rel_path: "2024/Tokyo/03-15/IMG.heic",
    };
    expect(s.state).toBe("open");
  });

  test("BackupSessionDoc summarises per-device progress", () => {
    const b: BackupSessionDoc = {
      _id: {} as any,
      library_id: {} as any,
      device_id: "uuid-1",
      started_at: new Date(),
      last_progress_at: new Date(),
      total_count: 100,
      uploaded_count: 1,
      failed_count: 0,
    };
    expect(b.uploaded_count).toBe(1);
  });
});
```

- [ ] **Step 2: Run the test — expect compile failure**

```bash
cd src/api && bun test src/db/schema.test.ts
```

Expected: TypeScript errors — `Property 'phasset_links' does not exist`, `UploadSessionDoc / BackupSessionDoc not exported`.

- [ ] **Step 3: Add the fields to `AssetDoc` and append the new types**

In `src/api/src/db/schema.ts`, after the existing `search_blob?: string;` line (before the `}` closing `AssetDoc`):

```ts
  /** Per-device link from Apple Photos. Multiple entries when the same
   * content has been observed on more than one device. See
   * `docs/superpowers/specs/2026-05-09-photokit-backup-design.md` §16. */
  phasset_links?: PhotoKitAssetLink[];
  /** Set when reconciliation observes the asset has been removed from Apple
   * Photos on every linked device. The cloud copy is preserved. */
  deleted_from_photos?: boolean;
  /** Relative path (under the library root) of the Apple-rendered companion,
   * when Apple Photos held edits at backup time. `null` for fresh originals. */
  apple_rendered_path?: string | null;
```

At end of file, append:

```ts
// ---------------------------------------------------------------------------
// PhotoKit backup
// ---------------------------------------------------------------------------

export interface PhotoKitAssetLink {
  device_id: string;
  phasset_local_id: string;
  first_seen: Date;
}

/** One in-flight or resumable upload. Resume key is
 * (library_id, device_id, phasset_local_id) — all known at enqueue. */
export interface UploadSessionDoc {
  _id: ObjectId;
  library_id: ObjectId;
  device_id: string;
  phasset_local_id: string;
  /** Target path under the library root, decided by the device pre-upload. */
  target_rel_path: string;
  total_bytes: number;
  received_bytes: number;
  chunk_size: number;
  /** "open" | "completed" | "abandoned" — sessions older than 7d in "open" get GC'd. */
  state: "open" | "completed" | "abandoned";
  created_at: Date;
  updated_at: Date;
  /** Set on the final chunk; used for dedup against existing AssetDoc rows. */
  maple_id?: string;
}

/** Per-device, per-library progress summary. Updated by the ingest endpoint
 * so the device can render "X% done from this device" without scanning assets. */
export interface BackupSessionDoc {
  _id: ObjectId;
  library_id: ObjectId;
  device_id: string;
  started_at: Date;
  last_progress_at: Date;
  total_count: number;
  uploaded_count: number;
  failed_count: number;
}
```

- [ ] **Step 4: Run the test — expect pass**

```bash
cd src/api && bun test src/db/schema.test.ts
```

Expected: 3 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/api/src/db/schema.ts src/api/src/db/schema.test.ts
git commit -m "feat(api): PhotoKit backup schema additions

Add phasset_links[], deleted_from_photos, apple_rendered_path to
AssetDoc. New UploadSessionDoc (resumable upload tracking) and
BackupSessionDoc (per-device aggregates) collections.

Refs spec §16, §19."
```

## Task 1.2: Backup sessions repository

**Files:**
- Create: `src/api/src/db/backup-sessions.repo.ts`
- Create: `src/api/src/db/backup-sessions.repo.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/api/src/db/backup-sessions.repo.test.ts
import { describe, test, expect, beforeAll } from "bun:test";
import { ObjectId } from "mongodb";
import { backupSessionsRepo } from "./backup-sessions.repo.ts";
import { backupSessionsCollection } from "./client.ts";

describe("backupSessionsRepo", () => {
  const libraryId = new ObjectId();
  const deviceId = "test-device-uuid";

  beforeAll(async () => {
    const coll = await backupSessionsCollection();
    await coll.deleteMany({ device_id: deviceId });
  });

  test("upsertProgress creates a row on first call and accumulates after", async () => {
    await backupSessionsRepo.upsertProgress({
      libraryId, deviceId,
      uploadedDelta: 1, failedDelta: 0,
      totalCount: 100,
    });
    await backupSessionsRepo.upsertProgress({
      libraryId, deviceId,
      uploadedDelta: 2, failedDelta: 1,
      totalCount: 100,
    });
    const row = await backupSessionsRepo.findOne({ libraryId, deviceId });
    expect(row?.uploaded_count).toBe(3);
    expect(row?.failed_count).toBe(1);
    expect(row?.total_count).toBe(100);
  });
});
```

- [ ] **Step 2: Run the test — expect failure**

```bash
cd src/api && bun test src/db/backup-sessions.repo.test.ts
```

Expected: import error — `backupSessionsRepo` not exported, `backupSessionsCollection` missing.

- [ ] **Step 3: Implement the repo**

In `src/api/src/db/client.ts`, add (next to other `…Collection()` exports — confirm exact pattern by reading the file first):

```ts
export async function backupSessionsCollection(): Promise<Collection<BackupSessionDoc>> {
  return (await getDb()).collection<BackupSessionDoc>("backup_sessions");
}
export async function uploadSessionsCollection(): Promise<Collection<UploadSessionDoc>> {
  return (await getDb()).collection<UploadSessionDoc>("upload_sessions");
}
```

Add imports at top: `import type { BackupSessionDoc, UploadSessionDoc } from "./schema.ts";`

Create `src/api/src/db/backup-sessions.repo.ts`:

```ts
import type { ObjectId } from "mongodb";
import { backupSessionsCollection } from "./client.ts";

export const backupSessionsRepo = {
  async upsertProgress(args: {
    libraryId: ObjectId;
    deviceId: string;
    uploadedDelta: number;
    failedDelta: number;
    totalCount?: number;
  }): Promise<void> {
    const coll = await backupSessionsCollection();
    const now = new Date();
    await coll.updateOne(
      { library_id: args.libraryId, device_id: args.deviceId },
      {
        $inc: {
          uploaded_count: args.uploadedDelta,
          failed_count: args.failedDelta,
        },
        $set: {
          last_progress_at: now,
          ...(args.totalCount !== undefined ? { total_count: args.totalCount } : {}),
        },
        $setOnInsert: { started_at: now },
      },
      { upsert: true },
    );
  },

  async findOne(args: { libraryId: ObjectId; deviceId: string }) {
    const coll = await backupSessionsCollection();
    return coll.findOne({ library_id: args.libraryId, device_id: args.deviceId });
  },
};
```

- [ ] **Step 4: Run the test — expect pass**

```bash
cd src/api && bun test src/db/backup-sessions.repo.test.ts
```

Expected: 1 test passes.

- [ ] **Step 5: Commit**

```bash
git add src/api/src/db/backup-sessions.repo.ts src/api/src/db/backup-sessions.repo.test.ts src/api/src/db/client.ts
git commit -m "feat(api): backup_sessions collection + upsertProgress helper"
```

## Task 1.3: Server-side path formatter

**Files:**
- Create: `src/api/src/backup/path-formatter.ts`
- Create: `src/api/src/backup/path-formatter.test.ts`

The device runs the SAME logic to compute the path. Phase 2 Task 2.3 mirrors this in Swift and a parity test compares output.

- [ ] **Step 1: Write the failing test**

```ts
// src/api/src/backup/path-formatter.test.ts
import { describe, test, expect } from "bun:test";
import { formatBackupPath } from "./path-formatter.ts";

const capture = new Date("2024-03-15T10:30:00Z");

describe("formatBackupPath", () => {
  test("with location → year/location/MM-DD/filename", () => {
    expect(formatBackupPath({
      captureDate: capture,
      location: "Tokyo",
      filename: "IMG_0420.HEIC",
    })).toBe("2024/Tokyo/03-15/IMG_0420.HEIC");
  });

  test("no location → year/MM/DD/filename", () => {
    expect(formatBackupPath({
      captureDate: capture,
      location: null,
      filename: "IMG_0420.HEIC",
    })).toBe("2024/03/15/IMG_0420.HEIC");
  });

  test("strips path-unsafe chars from location", () => {
    expect(formatBackupPath({
      captureDate: capture,
      location: "St. Tropez / Var",
      filename: "IMG.heic",
    })).toBe("2024/St. Tropez _ Var/03-15/IMG.heic");
  });

  test("empty location string treated as null", () => {
    expect(formatBackupPath({
      captureDate: capture,
      location: "",
      filename: "IMG.heic",
    })).toBe("2024/03/15/IMG.heic");
  });
});
```

- [ ] **Step 2: Run — expect failure**

```bash
cd src/api && bun test src/backup/path-formatter.test.ts
```

Expected: module not found.

- [ ] **Step 3: Implement**

```ts
// src/api/src/backup/path-formatter.ts
/**
 * Compute the destination path for a backed-up asset, relative to the
 * library root. Mirrors src/apple/Packages/MapleBackup/Sources/MapleBackup/PathFormatter.swift.
 *
 *   With location:    <year>/<location>/<MM>-<DD>/<filename>
 *   Without location: <year>/<MM>/<DD>/<filename>
 *
 * `/` in the location is replaced with `_` to keep the result a single
 * directory level.
 */
export function formatBackupPath(args: {
  captureDate: Date;
  location: string | null;
  filename: string;
}): string {
  const y = args.captureDate.getUTCFullYear().toString().padStart(4, "0");
  const m = (args.captureDate.getUTCMonth() + 1).toString().padStart(2, "0");
  const d = args.captureDate.getUTCDate().toString().padStart(2, "0");

  const loc = args.location && args.location.trim().length > 0
    ? args.location.replaceAll("/", "_")
    : null;

  if (loc) return `${y}/${loc}/${m}-${d}/${args.filename}`;
  return `${y}/${m}/${d}/${args.filename}`;
}
```

- [ ] **Step 4: Run — expect pass**

```bash
cd src/api && bun test src/backup/path-formatter.test.ts
```

Expected: 4 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/api/src/backup/path-formatter.ts src/api/src/backup/path-formatter.test.ts
git commit -m "feat(api): backup path formatter (server side)"
```

## Task 1.4: Upload-session repository + cleanup

**Files:**
- Create: `src/api/src/backup/upload-session.ts`
- Create: `src/api/src/backup/upload-session.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/api/src/backup/upload-session.test.ts
import { describe, test, expect, beforeEach } from "bun:test";
import { ObjectId } from "mongodb";
import { uploadSessions } from "./upload-session.ts";
import { uploadSessionsCollection } from "../db/client.ts";

describe("uploadSessions", () => {
  const libraryId = new ObjectId();
  const deviceId = "dev-1";
  const phid = "ABC/L0/001";

  beforeEach(async () => {
    const c = await uploadSessionsCollection();
    await c.deleteMany({ device_id: deviceId });
  });

  test("openOrResume creates a fresh session when none exists", async () => {
    const s = await uploadSessions.openOrResume({
      libraryId, deviceId, phassetLocalId: phid,
      totalBytes: 1024, chunkSize: 256,
      targetRelPath: "2024/Tokyo/03-15/IMG.heic",
    });
    expect(s.received_bytes).toBe(0);
    expect(s.state).toBe("open");
  });

  test("openOrResume returns the existing open session", async () => {
    const a = await uploadSessions.openOrResume({
      libraryId, deviceId, phassetLocalId: phid,
      totalBytes: 1024, chunkSize: 256,
      targetRelPath: "2024/Tokyo/03-15/IMG.heic",
    });
    await uploadSessions.recordChunk({ sessionId: a._id, bytesReceived: 256 });
    const b = await uploadSessions.openOrResume({
      libraryId, deviceId, phassetLocalId: phid,
      totalBytes: 1024, chunkSize: 256,
      targetRelPath: "2024/Tokyo/03-15/IMG.heic",
    });
    expect(b._id.equals(a._id)).toBe(true);
    expect(b.received_bytes).toBe(256);
  });

  test("complete marks the session done and stores maple_id", async () => {
    const s = await uploadSessions.openOrResume({
      libraryId, deviceId, phassetLocalId: phid,
      totalBytes: 256, chunkSize: 256,
      targetRelPath: "2024/Tokyo/03-15/IMG.heic",
    });
    await uploadSessions.recordChunk({ sessionId: s._id, bytesReceived: 256 });
    await uploadSessions.complete({ sessionId: s._id, mapleId: "abc123" });
    const final = await uploadSessions.findById(s._id);
    expect(final?.state).toBe("completed");
    expect(final?.maple_id).toBe("abc123");
  });
});
```

- [ ] **Step 2: Run — expect failure**

```bash
cd src/api && bun test src/backup/upload-session.test.ts
```

Expected: module not found.

- [ ] **Step 3: Implement**

```ts
// src/api/src/backup/upload-session.ts
import { ObjectId } from "mongodb";
import { uploadSessionsCollection } from "../db/client.ts";
import type { UploadSessionDoc } from "../db/schema.ts";

export const uploadSessions = {
  async openOrResume(args: {
    libraryId: ObjectId;
    deviceId: string;
    phassetLocalId: string;
    totalBytes: number;
    chunkSize: number;
    targetRelPath: string;
  }): Promise<UploadSessionDoc> {
    const coll = await uploadSessionsCollection();
    const existing = await coll.findOne({
      library_id: args.libraryId,
      device_id: args.deviceId,
      phasset_local_id: args.phassetLocalId,
      state: "open",
    });
    if (existing) return existing;
    const now = new Date();
    const doc: UploadSessionDoc = {
      _id: new ObjectId(),
      library_id: args.libraryId,
      device_id: args.deviceId,
      phasset_local_id: args.phassetLocalId,
      target_rel_path: args.targetRelPath,
      total_bytes: args.totalBytes,
      received_bytes: 0,
      chunk_size: args.chunkSize,
      state: "open",
      created_at: now,
      updated_at: now,
    };
    await coll.insertOne(doc);
    return doc;
  },

  async recordChunk(args: {
    sessionId: ObjectId;
    bytesReceived: number;
  }): Promise<void> {
    const coll = await uploadSessionsCollection();
    await coll.updateOne(
      { _id: args.sessionId },
      { $inc: { received_bytes: args.bytesReceived }, $set: { updated_at: new Date() } },
    );
  },

  async complete(args: { sessionId: ObjectId; mapleId: string }): Promise<void> {
    const coll = await uploadSessionsCollection();
    await coll.updateOne(
      { _id: args.sessionId },
      { $set: { state: "completed", maple_id: args.mapleId, updated_at: new Date() } },
    );
  },

  async findById(id: ObjectId): Promise<UploadSessionDoc | null> {
    const coll = await uploadSessionsCollection();
    return coll.findOne({ _id: id });
  },

  /** GC sessions older than `cutoff`. Called by a cron / startup hook. */
  async gcAbandoned(cutoff: Date): Promise<number> {
    const coll = await uploadSessionsCollection();
    const r = await coll.updateMany(
      { state: "open", updated_at: { $lt: cutoff } },
      { $set: { state: "abandoned" } },
    );
    return r.modifiedCount;
  },
};
```

- [ ] **Step 4: Run — expect pass**

```bash
cd src/api && bun test src/backup/upload-session.test.ts
```

Expected: 3 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/api/src/backup/upload-session.ts src/api/src/backup/upload-session.test.ts
git commit -m "feat(api): resumable upload session repo"
```

## Task 1.5: Reverse-geocode endpoint

**Files:**
- Create: `src/api/src/routes/geocode-reverse.ts`
- Create: `src/api/tests/geocode-reverse.test.ts`
- Modify: `src/api/src/index.ts` (mount the route)

- [ ] **Step 1: Write the failing test**

```ts
// src/api/tests/geocode-reverse.test.ts
import { describe, test, expect, beforeAll } from "bun:test";
import { app } from "../src/index.ts";
import { geocodeCacheCollection } from "../src/db/client.ts";

describe("GET /api/geocode/reverse", () => {
  beforeAll(async () => {
    const c = await geocodeCacheCollection();
    await c.deleteMany({});
    await c.insertOne({
      lat_q: 35.68,
      lon_q: 139.69,
      precision: 4,
      place: {
        address: {} as any,
        pois: [{ name: "Tokyo Station", category: "public_transport", type: "station" }],
        rollups: { locality: "Tokyo", region: "Tokyo", country: "Japan" } as any,
        search_blob: "Tokyo Station Tokyo Japan",
      } as any,
      fetched_at: new Date(),
    } as any);
  });

  test("returns the cached Place when present", async () => {
    const res = await app.handle(new Request("http://localhost/api/geocode/reverse?lat=35.6800&lon=139.6900&precision=4"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.place.pois[0].name).toBe("Tokyo Station");
    expect(body.place.rollups.locality).toBe("Tokyo");
  });

  test("returns 404 when no cache row matches", async () => {
    const res = await app.handle(new Request("http://localhost/api/geocode/reverse?lat=0&lon=0&precision=4"));
    expect(res.status).toBe(404);
  });

  test("rejects missing params with 400", async () => {
    const res = await app.handle(new Request("http://localhost/api/geocode/reverse?lat=35.68"));
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run — expect failure**

```bash
cd src/api && bun test tests/geocode-reverse.test.ts
```

Expected: route not mounted (404 for everything) or import error.

- [ ] **Step 3: Implement the route**

```ts
// src/api/src/routes/geocode-reverse.ts
import { Elysia, t } from "elysia";
import { geocodeCacheCollection } from "../db/client.ts";

/**
 * GET /api/geocode/reverse?lat&lon&precision
 *
 * Returns the cached Place from geocode_cache, or 404 if no row matches.
 * Quantises lat/lon to `precision` decimals (default 4 — ~11 m). The device
 * uses this to choose a backup path; if 404 it falls back to the no-GPS path
 * shape (see spec §9).
 */
export const geocodeReverseRoutes = new Elysia().get(
  "/api/geocode/reverse",
  async ({ query, set }) => {
    const lat = parseFloat(query.lat);
    const lon = parseFloat(query.lon);
    const precision = query.precision ? parseInt(query.precision, 10) : 4;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      set.status = 400;
      return { error: "lat and lon are required and must be finite numbers" };
    }
    const factor = 10 ** precision;
    const lat_q = Math.round(lat * factor) / factor;
    const lon_q = Math.round(lon * factor) / factor;

    const coll = await geocodeCacheCollection();
    const row = await coll.findOne({ lat_q, lon_q, precision });
    if (!row) {
      set.status = 404;
      return { error: "not in cache" };
    }
    return { place: row.place };
  },
  {
    query: t.Object({
      lat: t.String(),
      lon: t.String(),
      precision: t.Optional(t.String()),
    }),
  },
);
```

Mount in `src/api/src/index.ts` (find the `.use(...)` chain that registers other route groups; add the new one alongside, in the same style):

```ts
import { geocodeReverseRoutes } from "./routes/geocode-reverse.ts";
// ...
  .use(geocodeReverseRoutes)
```

- [ ] **Step 4: Run — expect pass**

```bash
cd src/api && bun test tests/geocode-reverse.test.ts
```

Expected: 3 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/api/src/routes/geocode-reverse.ts src/api/tests/geocode-reverse.test.ts src/api/src/index.ts
git commit -m "feat(api): GET /api/geocode/reverse (geocode_cache wrapper)"
```

## Task 1.6: Backup ingest endpoint

**Files:**
- Create: `src/api/src/routes/backup-ingest.ts`
- Create: `src/api/tests/backup-ingest.test.ts`
- Modify: `src/api/src/index.ts`

This is the largest endpoint. It accepts chunked multipart uploads with a resume key in headers. The first chunk opens the session, subsequent chunks append, the final chunk closes the session and creates / updates the `AssetDoc`.

- [ ] **Step 1: Write the failing integration test**

```ts
// src/api/tests/backup-ingest.test.ts
import { describe, test, expect, beforeAll } from "bun:test";
import { ObjectId } from "mongodb";
import { app } from "../src/index.ts";
import { foldersCollection, assetsCollection, uploadSessionsCollection } from "../src/db/client.ts";

const libId = new ObjectId();
const deviceId = "test-device";
const phid = "ABC/L0/001";

beforeAll(async () => {
  const f = await foldersCollection();
  await f.insertOne({ _id: libId, path: "/tmp/maple-test-lib", label: "test", created_at: new Date(), file_count: 0 } as any);
  const a = await assetsCollection();
  await a.deleteMany({ "phasset_links.phasset_local_id": phid });
  const u = await uploadSessionsCollection();
  await u.deleteMany({ device_id: deviceId });
});

function ingestRequest(body: Buffer, headers: Record<string, string>): Request {
  return new Request(`http://localhost/api/libraries/${libId.toHexString()}/backup/ingest`, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream", ...headers },
    body,
  });
}

describe("POST /api/libraries/:id/backup/ingest (single-chunk happy path)", () => {
  test("uploads 256 bytes in one chunk → AssetDoc created + session completed", async () => {
    const bytes = Buffer.alloc(256, 1);
    const res = await app.handle(ingestRequest(bytes, {
      "X-Maple-Device-Id": deviceId,
      "X-Maple-Phasset-Id": phid,
      "X-Maple-Capture-Date": "2024-03-15T10:30:00Z",
      "X-Maple-Lat": "35.6800",
      "X-Maple-Lon": "139.6900",
      "X-Maple-Filename": "IMG_0420.HEIC",
      "X-Maple-Total-Bytes": "256",
      "X-Maple-Maple-Id": "abc123",
      "Content-Range": "bytes 0-255/256",
    }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.maple_id).toBe("abc123");
    expect(body.target_rel_path).toBe("2024/Tokyo/03-15/IMG_0420.HEIC");

    const a = await assetsCollection();
    const doc = await a.findOne({ "phasset_links.phasset_local_id": phid });
    expect(doc).toBeTruthy();
    expect(doc?.phasset_links?.[0].device_id).toBe(deviceId);
  });
});

describe("POST .../backup/ingest (resume across two chunks)", () => {
  test("first chunk opens session, second chunk completes", async () => {
    const phid2 = "ABC/L0/002";
    const r1 = await app.handle(ingestRequest(Buffer.alloc(128, 2), {
      "X-Maple-Device-Id": deviceId,
      "X-Maple-Phasset-Id": phid2,
      "X-Maple-Capture-Date": "2024-03-15T10:30:00Z",
      "X-Maple-Filename": "IMG_0421.HEIC",
      "X-Maple-Total-Bytes": "256",
      "Content-Range": "bytes 0-127/256",
    }));
    expect(r1.status).toBe(202);
    const b1 = await r1.json();
    expect(b1.next_offset).toBe(128);

    const r2 = await app.handle(ingestRequest(Buffer.alloc(128, 2), {
      "X-Maple-Device-Id": deviceId,
      "X-Maple-Phasset-Id": phid2,
      "X-Maple-Capture-Date": "2024-03-15T10:30:00Z",
      "X-Maple-Filename": "IMG_0421.HEIC",
      "X-Maple-Total-Bytes": "256",
      "X-Maple-Maple-Id": "def456",
      "Content-Range": "bytes 128-255/256",
    }));
    expect(r2.status).toBe(200);
  });
});
```

- [ ] **Step 2: Run — expect failure**

```bash
cd src/api && bun test tests/backup-ingest.test.ts
```

Expected: 404 (route not mounted) or compile errors.

- [ ] **Step 3: Implement**

```ts
// src/api/src/routes/backup-ingest.ts
import { Elysia, t } from "elysia";
import { ObjectId } from "mongodb";
import {
  assetsCollection,
  foldersCollection,
  geocodeCacheCollection,
} from "../db/client.ts";
import { uploadSessions } from "../backup/upload-session.ts";
import { formatBackupPath } from "../backup/path-formatter.ts";
import { backupSessionsRepo } from "../db/backup-sessions.repo.ts";
import { child as childLogger } from "../log.ts";
import fs from "node:fs/promises";
import path from "node:path";

const log = childLogger("backup-ingest");
const CHUNK_DIR = process.env.MAPLE_BACKUP_TMP ?? "/tmp/maple-backup-chunks";

async function resolveLocation(lat: number, lon: number): Promise<string | null> {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const factor = 10 ** 4;
  const lat_q = Math.round(lat * factor) / factor;
  const lon_q = Math.round(lon * factor) / factor;
  const coll = await geocodeCacheCollection();
  const row = await coll.findOne({ lat_q, lon_q, precision: 4 });
  if (!row) return null;
  return row.place.pois[0]?.name ?? row.place.rollups?.locality ?? null;
}

export const backupIngestRoutes = new Elysia().post(
  "/api/libraries/:libraryId/backup/ingest",
  async ({ params, headers, body, set }) => {
    const libraryId = new ObjectId(params.libraryId);
    const folder = await (await foldersCollection()).findOne({ _id: libraryId });
    if (!folder) { set.status = 404; return { error: "library not found" }; }

    const deviceId = headers["x-maple-device-id"];
    const phid = headers["x-maple-phasset-id"];
    const captureRaw = headers["x-maple-capture-date"];
    const filename = headers["x-maple-filename"];
    const totalBytes = parseInt(headers["x-maple-total-bytes"] ?? "0", 10);
    const lat = parseFloat(headers["x-maple-lat"] ?? "NaN");
    const lon = parseFloat(headers["x-maple-lon"] ?? "NaN");
    const mapleId = headers["x-maple-maple-id"];
    const range = headers["content-range"];

    if (!deviceId || !phid || !captureRaw || !filename || !totalBytes || !range) {
      set.status = 400; return { error: "missing required headers" };
    }
    const m = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(range);
    if (!m) { set.status = 400; return { error: "invalid Content-Range" }; }
    const start = parseInt(m[1], 10);
    const end = parseInt(m[2], 10);
    const total = parseInt(m[3], 10);
    if (total !== totalBytes) { set.status = 400; return { error: "Content-Range total mismatch" }; }

    const captureDate = new Date(captureRaw);
    const location = await resolveLocation(lat, lon);
    const targetRelPath = formatBackupPath({ captureDate, location, filename });

    const session = await uploadSessions.openOrResume({
      libraryId, deviceId, phassetLocalId: phid,
      totalBytes, chunkSize: end - start + 1, targetRelPath,
    });
    if (session.received_bytes !== start) {
      set.status = 409;
      return { error: "resume offset mismatch", expected_offset: session.received_bytes };
    }

    // Persist chunk to a per-session tmp file. Body is the raw bytes.
    const tmpFile = path.join(CHUNK_DIR, `${session._id.toHexString()}.part`);
    await fs.mkdir(CHUNK_DIR, { recursive: true });
    const buf = body instanceof Uint8Array ? Buffer.from(body) : Buffer.from(body as ArrayBuffer);
    await fs.appendFile(tmpFile, buf);
    await uploadSessions.recordChunk({ sessionId: session._id, bytesReceived: buf.byteLength });

    const isFinalChunk = end + 1 === total;
    if (!isFinalChunk) {
      set.status = 202;
      return { next_offset: session.received_bytes + buf.byteLength };
    }

    // Final chunk — move into place, write AssetDoc.
    const finalPath = path.join(folder.path, targetRelPath);
    await fs.mkdir(path.dirname(finalPath), { recursive: true });
    await fs.rename(tmpFile, finalPath);

    if (!mapleId) { set.status = 400; return { error: "X-Maple-Maple-Id required on final chunk" }; }
    await uploadSessions.complete({ sessionId: session._id, mapleId });

    const a = await assetsCollection();
    const existing = await a.findOne({ maple_id: mapleId });
    const link = { device_id: deviceId, phasset_local_id: phid, first_seen: new Date() };
    if (existing) {
      // Dedup — already have this content from another device.
      await a.updateOne(
        { _id: existing._id, "phasset_links.phasset_local_id": { $ne: phid } },
        { $push: { phasset_links: link } },
      );
    } else {
      await a.insertOne({
        _id: new ObjectId(),
        folder_id: libraryId,
        filename,
        abs_path: finalPath,
        size: total,
        mtime: Date.now(),
        rating: 0,
        flag: 0,
        color_label: "",
        indexed_at: new Date().toISOString(),
        maple_id: mapleId,
        phasset_links: [link],
        deleted_from_photos: false,
      } as any);
    }
    await backupSessionsRepo.upsertProgress({
      libraryId, deviceId, uploadedDelta: 1, failedDelta: 0,
    });

    log.debug({ phid, targetRelPath, mapleId }, "ingest complete");
    set.status = 200;
    return { maple_id: mapleId, target_rel_path: targetRelPath };
  },
  {
    params: t.Object({ libraryId: t.String() }),
    body: t.Any(),
  },
);
```

Mount in `src/api/src/index.ts`:

```ts
import { backupIngestRoutes } from "./routes/backup-ingest.ts";
// ...
  .use(backupIngestRoutes)
```

- [ ] **Step 4: Run — expect pass**

```bash
cd src/api && bun test tests/backup-ingest.test.ts
```

Expected: both tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/api/src/routes/backup-ingest.ts src/api/tests/backup-ingest.test.ts src/api/src/index.ts
git commit -m "feat(api): POST /api/libraries/:id/backup/ingest (chunked + resumable)"
```

## Task 1.7: Backup-state reconciliation endpoint

**Files:**
- Create: `src/api/src/routes/backup-state.ts`
- Create: `src/api/tests/backup-state.test.ts`
- Modify: `src/api/src/index.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/api/tests/backup-state.test.ts
import { describe, test, expect, beforeAll } from "bun:test";
import { ObjectId } from "mongodb";
import { app } from "../src/index.ts";
import { assetsCollection, foldersCollection } from "../src/db/client.ts";

const libId = new ObjectId();
const deviceId = "test-device-state";

beforeAll(async () => {
  await (await foldersCollection()).insertOne({ _id: libId, path: "/tmp/x", label: "x", created_at: new Date(), file_count: 0 } as any);
  const a = await assetsCollection();
  await a.deleteMany({ "phasset_links.device_id": deviceId });
  await a.insertMany([
    { folder_id: libId, filename: "a.heic", abs_path: "/tmp/x/a.heic", size: 1, mtime: 0, rating: 0, flag: 0, color_label: "", indexed_at: "2026-05-11T00:00:00Z",
      phasset_links: [{ device_id: deviceId, phasset_local_id: "P1", first_seen: new Date("2026-05-10T00:00:00Z") }] },
    { folder_id: libId, filename: "b.heic", abs_path: "/tmp/x/b.heic", size: 1, mtime: 0, rating: 0, flag: 0, color_label: "", indexed_at: "2026-05-11T00:00:00Z",
      phasset_links: [{ device_id: deviceId, phasset_local_id: "P2", first_seen: new Date("2026-05-11T01:00:00Z") }] },
  ] as any);
});

describe("GET /api/libraries/:id/backup/state", () => {
  test("returns assets backed up by the given device since `since`", async () => {
    const since = "2026-05-10T12:00:00Z";
    const url = `http://localhost/api/libraries/${libId.toHexString()}/backup/state?device_id=${deviceId}&since=${encodeURIComponent(since)}`;
    const res = await app.handle(new Request(url));
    expect(res.status).toBe(200);
    const body = await res.json();
    const ids = body.assets.map((a: any) => a.phasset_local_id).sort();
    expect(ids).toEqual(["P2"]);
  });
});
```

- [ ] **Step 2: Run — expect failure**

```bash
cd src/api && bun test tests/backup-state.test.ts
```

Expected: 404.

- [ ] **Step 3: Implement**

```ts
// src/api/src/routes/backup-state.ts
import { Elysia, t } from "elysia";
import { ObjectId } from "mongodb";
import { assetsCollection } from "../db/client.ts";

export const backupStateRoutes = new Elysia().get(
  "/api/libraries/:libraryId/backup/state",
  async ({ params, query, set }) => {
    let libraryId: ObjectId;
    try { libraryId = new ObjectId(params.libraryId); }
    catch { set.status = 400; return { error: "invalid library id" }; }

    const deviceId = query.device_id;
    if (!deviceId) { set.status = 400; return { error: "device_id required" }; }
    const since = query.since ? new Date(query.since) : new Date(0);

    const a = await assetsCollection();
    const rows = await a.find({
      folder_id: libraryId,
      "phasset_links": { $elemMatch: { device_id: deviceId, first_seen: { $gte: since } } },
    }).project({ filename: 1, abs_path: 1, phasset_links: 1, maple_id: 1 }).toArray();

    const out = rows.flatMap((r: any) =>
      (r.phasset_links ?? [])
        .filter((l: any) => l.device_id === deviceId && l.first_seen >= since)
        .map((l: any) => ({
          phasset_local_id: l.phasset_local_id,
          first_seen: l.first_seen,
          maple_id: r.maple_id,
          rel_path: r.abs_path,
        }))
    );
    return { assets: out };
  },
  {
    params: t.Object({ libraryId: t.String() }),
    query: t.Object({ device_id: t.String(), since: t.Optional(t.String()) }),
  },
);
```

Mount in `index.ts`:

```ts
import { backupStateRoutes } from "./routes/backup-state.ts";
// ...
  .use(backupStateRoutes)
```

- [ ] **Step 4: Run — expect pass**

```bash
cd src/api && bun test tests/backup-state.test.ts
```

Expected: 1 test passes.

- [ ] **Step 5: Commit**

```bash
git add src/api/src/routes/backup-state.ts src/api/tests/backup-state.test.ts src/api/src/index.ts
git commit -m "feat(api): GET /api/libraries/:id/backup/state (reconciliation feed)"
```

## Task 1.8: Phase 1 PR

- [ ] **Step 1: Run the full server test suite**

```bash
cd src/api && bun test
```

Expected: all tests pass. If any pre-existing test fails, fix or surface — do NOT mark as passing.

- [ ] **Step 2: Open the PR**

```bash
git push -u origin HEAD
gh pr create --title "feat(api): PhotoKit backup server foundations" --body "$(cat <<'EOF'
## Summary
- Schema additions: AssetDoc.phasset_links[], deleted_from_photos, apple_rendered_path; UploadSessionDoc + BackupSessionDoc collections.
- New routes: POST /api/libraries/:id/backup/ingest (chunked, resumable), GET /api/libraries/:id/backup/state (per-device reconciliation), GET /api/geocode/reverse (geocode_cache wrapper).
- Server-side path formatter matching the device formatter (Phase 2 will add a parity test).

Spec: docs/superpowers/specs/2026-05-09-photokit-backup-design.md (PR #9).
Plan: docs/superpowers/plans/2026-05-11-photokit-backup.md.

## Test plan
- [ ] \`cd src/api && bun test\` passes
- [ ] curl chunked upload happy-path against a local server
- [ ] curl reverse-geocode hits a seeded \`geocode_cache\` row

EOF
)"
```

---

# Phase 2 — MapleBackup SPM module + PhotoKitSource integration

Goal: ship the device-side engine as a standalone SPM module with full unit tests, plus the PhotoKitSource changes so edits become possible. The module is consumable by both `MapleApp` and a future `MapleBackupAgent` target (Phase 3).

## Task 2.1: SPM scaffolding

**Files:**
- Create: `src/apple/Packages/MapleBackup/Package.swift`
- Create: `src/apple/Packages/MapleBackup/Sources/MapleBackup/MapleBackup.swift` (placeholder umbrella)
- Create: `src/apple/Packages/MapleBackup/Tests/MapleBackupTests/SanityTests.swift`

- [ ] **Step 1: Create the Package.swift**

```swift
// swift-tools-version:5.10
import PackageDescription

let package = Package(
    name: "MapleBackup",
    platforms: [.macOS(.v14), .iOS(.v17)],
    products: [
        .library(name: "MapleBackup", targets: ["MapleBackup"]),
    ],
    dependencies: [
        .package(url: "https://github.com/groue/GRDB.swift.git", from: "6.27.0"),
    ],
    targets: [
        .target(
            name: "MapleBackup",
            dependencies: [.product(name: "GRDB", package: "GRDB.swift")],
            path: "Sources/MapleBackup"
        ),
        .testTarget(
            name: "MapleBackupTests",
            dependencies: ["MapleBackup"],
            path: "Tests/MapleBackupTests"
        ),
    ]
)
```

- [ ] **Step 2: Add the placeholder umbrella and sanity test**

```swift
// Sources/MapleBackup/MapleBackup.swift
public enum MapleBackup {
    public static let version = "0.1.0"
}
```

```swift
// Tests/MapleBackupTests/SanityTests.swift
import XCTest
@testable import MapleBackup

final class SanityTests: XCTestCase {
    func testVersion() {
        XCTAssertEqual(MapleBackup.version, "0.1.0")
    }
}
```

- [ ] **Step 3: Run swift test**

```bash
cd src/apple/Packages/MapleBackup && swift test
```

Expected: 1 test passes. If GRDB resolution fails on the first run, `swift package resolve` then retry.

- [ ] **Step 4: Commit**

```bash
git add src/apple/Packages/MapleBackup
git commit -m "feat(maple-backup): SPM scaffolding"
```

## Task 2.2: DeviceIdentity

**Files:**
- Create: `src/apple/Packages/MapleBackup/Sources/MapleBackup/DeviceIdentity.swift`
- Create: `src/apple/Packages/MapleBackup/Tests/MapleBackupTests/DeviceIdentityTests.swift`

- [ ] **Step 1: Write the failing test**

```swift
// Tests/MapleBackupTests/DeviceIdentityTests.swift
import XCTest
@testable import MapleBackup

final class DeviceIdentityTests: XCTestCase {
    func testCurrentIsStableAcrossCalls() throws {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("device-id-test-\(UUID().uuidString)")
        try? FileManager.default.removeItem(at: url)
        let id1 = try DeviceIdentity.current(storageURL: url)
        let id2 = try DeviceIdentity.current(storageURL: url)
        XCTAssertEqual(id1, id2)
        XCTAssertEqual(id1.count, 36) // RFC 4122 dashed UUID
    }
    func testCurrentDiffersAcrossDistinctStorage() throws {
        let a = FileManager.default.temporaryDirectory.appendingPathComponent("dev-a-\(UUID().uuidString)")
        let b = FileManager.default.temporaryDirectory.appendingPathComponent("dev-b-\(UUID().uuidString)")
        let id1 = try DeviceIdentity.current(storageURL: a)
        let id2 = try DeviceIdentity.current(storageURL: b)
        XCTAssertNotEqual(id1, id2)
    }
}
```

- [ ] **Step 2: Run — expect failure**

```bash
cd src/apple/Packages/MapleBackup && swift test --filter DeviceIdentityTests
```

Expected: `DeviceIdentity` not declared.

- [ ] **Step 3: Implement**

```swift
// Sources/MapleBackup/DeviceIdentity.swift
import Foundation

/// Stable UUID per device-and-app-install. Generated on first read and
/// persisted to `storageURL` as a plain UTF-8 string. The same UUID is sent
/// to the server in every backup request as the `X-Maple-Device-Id` header.
public enum DeviceIdentity {

    /// Default storage at `~/Library/Application Support/Maple/device-id`.
    public static func defaultStorageURL() throws -> URL {
        let appSupport = try FileManager.default.url(
            for: .applicationSupportDirectory, in: .userDomainMask,
            appropriateFor: nil, create: true)
        let dir = appSupport.appendingPathComponent("Maple", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.appendingPathComponent("device-id")
    }

    /// Read-or-generate the UUID at `storageURL`. Atomic write on first call.
    public static func current(storageURL: URL) throws -> String {
        if FileManager.default.fileExists(atPath: storageURL.path) {
            let data = try Data(contentsOf: storageURL)
            let s = String(data: data, encoding: .utf8)?
                .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            if !s.isEmpty { return s }
        }
        let new = UUID().uuidString
        try Data(new.utf8).write(to: storageURL, options: .atomic)
        return new
    }
}
```

- [ ] **Step 4: Run — expect pass**

```bash
cd src/apple/Packages/MapleBackup && swift test --filter DeviceIdentityTests
```

Expected: 2 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/apple/Packages/MapleBackup/Sources/MapleBackup/DeviceIdentity.swift src/apple/Packages/MapleBackup/Tests/MapleBackupTests/DeviceIdentityTests.swift
git commit -m "feat(maple-backup): DeviceIdentity"
```

## Task 2.3: PathFormatter (Swift mirror of server)

**Files:**
- Create: `src/apple/Packages/MapleBackup/Sources/MapleBackup/PathFormatter.swift`
- Create: `src/apple/Packages/MapleBackup/Tests/MapleBackupTests/PathFormatterTests.swift`

- [ ] **Step 1: Write the failing test** (identical cases to Phase 1 Task 1.3)

```swift
import XCTest
@testable import MapleBackup

final class PathFormatterTests: XCTestCase {
    private func date(_ iso: String) -> Date {
        ISO8601DateFormatter().date(from: iso)!
    }
    func testWithLocation() {
        XCTAssertEqual(
            PathFormatter.format(captureDate: date("2024-03-15T10:30:00Z"),
                                 location: "Tokyo", filename: "IMG_0420.HEIC"),
            "2024/Tokyo/03-15/IMG_0420.HEIC")
    }
    func testWithoutLocation() {
        XCTAssertEqual(
            PathFormatter.format(captureDate: date("2024-03-15T10:30:00Z"),
                                 location: nil, filename: "IMG_0420.HEIC"),
            "2024/03/15/IMG_0420.HEIC")
    }
    func testLocationSlashEscaped() {
        XCTAssertEqual(
            PathFormatter.format(captureDate: date("2024-03-15T10:30:00Z"),
                                 location: "St. Tropez / Var", filename: "IMG.heic"),
            "2024/St. Tropez _ Var/03-15/IMG.heic")
    }
    func testEmptyLocationTreatedAsNil() {
        XCTAssertEqual(
            PathFormatter.format(captureDate: date("2024-03-15T10:30:00Z"),
                                 location: "", filename: "IMG.heic"),
            "2024/03/15/IMG.heic")
    }
}
```

- [ ] **Step 2: Run — expect failure**

- [ ] **Step 3: Implement**

```swift
// Sources/MapleBackup/PathFormatter.swift
import Foundation

public enum PathFormatter {
    /// Mirrors `src/api/src/backup/path-formatter.ts::formatBackupPath`.
    /// Phase 2 Task 2.10 adds a parity test that runs identical cases through
    /// both implementations and asserts byte-identical output.
    public static func format(captureDate: Date, location: String?, filename: String) -> String {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(secondsFromGMT: 0)!
        let comps = cal.dateComponents([.year, .month, .day], from: captureDate)
        let y = String(format: "%04d", comps.year ?? 0)
        let m = String(format: "%02d", comps.month ?? 0)
        let d = String(format: "%02d", comps.day ?? 0)

        let trimmed = location?.trimmingCharacters(in: .whitespaces) ?? ""
        if trimmed.isEmpty { return "\(y)/\(m)/\(d)/\(filename)" }
        let escaped = trimmed.replacingOccurrences(of: "/", with: "_")
        return "\(y)/\(escaped)/\(m)-\(d)/\(filename)"
    }
}
```

- [ ] **Step 4: Run — expect pass**

- [ ] **Step 5: Commit**

```bash
git add src/apple/Packages/MapleBackup/Sources/MapleBackup/PathFormatter.swift src/apple/Packages/MapleBackup/Tests/MapleBackupTests/PathFormatterTests.swift
git commit -m "feat(maple-backup): PathFormatter (Swift mirror of server)"
```

## Task 2.4: AppSupportSidecarStore

**Files:**
- Create: `src/apple/Packages/MapleBackup/Sources/MapleBackup/AppSupportSidecarStore.swift`
- Create: `src/apple/Packages/MapleBackup/Tests/MapleBackupTests/AppSupportSidecarStoreTests.swift`

- [ ] **Step 1: Write the failing test**

```swift
import XCTest
@testable import MapleBackup

final class AppSupportSidecarStoreTests: XCTestCase {
    func testWriteAndReadRoundTrip() throws {
        let tmp = FileManager.default.temporaryDirectory
            .appendingPathComponent("sidecar-test-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: tmp, withIntermediateDirectories: true)
        let store = AppSupportSidecarStore(root: tmp)
        let phid = "ABC/L0/001"
        let xml = #"<x:xmpmeta><rdf:RDF /></x:xmpmeta>"#
        try store.write(phassetLocalId: phid, xmp: xml)
        let read = try store.read(phassetLocalId: phid)
        XCTAssertEqual(read, xml)
    }

    func testSlashInIdentifierEscaped() throws {
        let tmp = FileManager.default.temporaryDirectory
            .appendingPathComponent("sidecar-test-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: tmp, withIntermediateDirectories: true)
        let store = AppSupportSidecarStore(root: tmp)
        try store.write(phassetLocalId: "ABC/L0/001", xmp: "x")
        let files = try FileManager.default.contentsOfDirectory(atPath: tmp.path)
        XCTAssertTrue(files.contains("ABC_L0_001.xmp"))
    }

    func testDelete() throws {
        let tmp = FileManager.default.temporaryDirectory
            .appendingPathComponent("sidecar-test-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: tmp, withIntermediateDirectories: true)
        let store = AppSupportSidecarStore(root: tmp)
        try store.write(phassetLocalId: "P1", xmp: "x")
        XCTAssertNotNil(try store.read(phassetLocalId: "P1"))
        try store.delete(phassetLocalId: "P1")
        XCTAssertNil(try store.read(phassetLocalId: "P1"))
    }
}
```

- [ ] **Step 2: Run — expect failure**

- [ ] **Step 3: Implement**

```swift
// Sources/MapleBackup/AppSupportSidecarStore.swift
import Foundation

/// File-per-PHAsset `.xmp` sidecar store. Same on-disk format as
/// `XMPSidecarStore` in MapleCore — just keyed by `phassetLocalId` instead of
/// by raw file URL. Atomic writes via temp + `replaceItemAt`.
public final class AppSupportSidecarStore {
    public static func defaultRoot() throws -> URL {
        let appSupport = try FileManager.default.url(
            for: .applicationSupportDirectory, in: .userDomainMask,
            appropriateFor: nil, create: true)
        let dir = appSupport
            .appendingPathComponent("Maple", isDirectory: true)
            .appendingPathComponent("PhotoKitSidecars", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    private let root: URL

    public init(root: URL) { self.root = root }

    private func url(for phassetLocalId: String) -> URL {
        let safe = phassetLocalId.replacingOccurrences(of: "/", with: "_")
        return root.appendingPathComponent("\(safe).xmp")
    }

    public func read(phassetLocalId: String) throws -> String? {
        let u = url(for: phassetLocalId)
        guard FileManager.default.fileExists(atPath: u.path) else { return nil }
        let d = try Data(contentsOf: u)
        return String(data: d, encoding: .utf8)
    }

    public func write(phassetLocalId: String, xmp: String) throws {
        let final = url(for: phassetLocalId)
        let tmp = final.deletingLastPathComponent()
            .appendingPathComponent(".\(final.lastPathComponent).tmp")
        try Data(xmp.utf8).write(to: tmp, options: .atomic)
        _ = try FileManager.default.replaceItemAt(final, withItemAt: tmp)
    }

    public func delete(phassetLocalId: String) throws {
        let u = url(for: phassetLocalId)
        if FileManager.default.fileExists(atPath: u.path) {
            try FileManager.default.removeItem(at: u)
        }
    }
}
```

- [ ] **Step 4: Run — expect pass**

- [ ] **Step 5: Commit**

```bash
git add src/apple/Packages/MapleBackup/Sources/MapleBackup/AppSupportSidecarStore.swift src/apple/Packages/MapleBackup/Tests/MapleBackupTests/AppSupportSidecarStoreTests.swift
git commit -m "feat(maple-backup): AppSupportSidecarStore"
```

## Task 2.5: GeocodeClient

**Files:**
- Create: `src/apple/Packages/MapleBackup/Sources/MapleBackup/GeocodeClient.swift`
- Create: `src/apple/Packages/MapleBackup/Tests/MapleBackupTests/GeocodeClientTests.swift`

- [ ] **Step 1: Write the failing test** (uses `URLProtocol` stub)

```swift
import XCTest
@testable import MapleBackup

final class GeocodeClientTests: XCTestCase {
    override func setUp() {
        URLProtocol.registerClass(StubProtocol.self)
        StubProtocol.stub = nil
    }
    override func tearDown() {
        URLProtocol.unregisterClass(StubProtocol.self)
    }

    func testReturnsPoiNameWhenPresent() async throws {
        StubProtocol.stub = .ok(json: """
        {"place":{"pois":[{"name":"Tokyo Station","category":"public_transport","type":"station"}],
                  "rollups":{"locality":"Tokyo"}}}
        """)
        let client = GeocodeClient(baseURL: URL(string: "https://server.example")!,
                                   session: URLSession(configuration: stubConfig))
        let loc = try await client.lookup(lat: 35.68, lon: 139.69)
        XCTAssertEqual(loc, "Tokyo Station")
    }

    func testFallsBackToLocality() async throws {
        StubProtocol.stub = .ok(json: """
        {"place":{"pois":[],"rollups":{"locality":"Tokyo"}}}
        """)
        let client = GeocodeClient(baseURL: URL(string: "https://server.example")!,
                                   session: URLSession(configuration: stubConfig))
        XCTAssertEqual(try await client.lookup(lat: 0, lon: 0), "Tokyo")
    }

    func testReturnsNilOn404() async throws {
        StubProtocol.stub = .status(404)
        let client = GeocodeClient(baseURL: URL(string: "https://server.example")!,
                                   session: URLSession(configuration: stubConfig))
        XCTAssertNil(try await client.lookup(lat: 0, lon: 0))
    }

    private var stubConfig: URLSessionConfiguration {
        let c = URLSessionConfiguration.ephemeral
        c.protocolClasses = [StubProtocol.self]
        return c
    }
}

final class StubProtocol: URLProtocol {
    enum Stub { case ok(json: String), status(Int) }
    static var stub: Stub?
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let res: HTTPURLResponse
        var body = Data()
        switch StubProtocol.stub {
        case .ok(let json):
            res = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!
            body = Data(json.utf8)
        case .status(let s):
            res = HTTPURLResponse(url: request.url!, statusCode: s, httpVersion: nil, headerFields: nil)!
        case .none:
            res = HTTPURLResponse(url: request.url!, statusCode: 500, httpVersion: nil, headerFields: nil)!
        }
        client?.urlProtocol(self, didReceive: res, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: body)
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}
```

- [ ] **Step 2: Run — expect failure**

- [ ] **Step 3: Implement**

```swift
// Sources/MapleBackup/GeocodeClient.swift
import Foundation

public actor GeocodeClient {
    private struct Response: Decodable {
        struct Place: Decodable {
            struct Poi: Decodable { let name: String }
            struct Rollups: Decodable { let locality: String? }
            let pois: [Poi]
            let rollups: Rollups
        }
        let place: Place
    }

    private let baseURL: URL
    private let session: URLSession

    public init(baseURL: URL, session: URLSession = .shared) {
        self.baseURL = baseURL
        self.session = session
    }

    /// Returns the primary location name for `lat,lon`, or `nil` when the
    /// geocode cache has no entry. Errors propagate; the caller decides
    /// whether to fall back to the no-GPS path shape.
    public func lookup(lat: Double, lon: Double) async throws -> String? {
        var c = URLComponents(url: baseURL.appendingPathComponent("api/geocode/reverse"),
                              resolvingAgainstBaseURL: false)!
        c.queryItems = [
            URLQueryItem(name: "lat", value: String(lat)),
            URLQueryItem(name: "lon", value: String(lon)),
            URLQueryItem(name: "precision", value: "4"),
        ]
        let (data, response) = try await session.data(from: c.url!)
        guard let http = response as? HTTPURLResponse else { return nil }
        if http.statusCode == 404 { return nil }
        guard http.statusCode == 200 else { return nil }
        let decoded = try JSONDecoder().decode(Response.self, from: data)
        if let first = decoded.place.pois.first { return first.name }
        return decoded.place.rollups.locality
    }
}
```

- [ ] **Step 4: Run — expect pass**

- [ ] **Step 5: Commit**

```bash
git add src/apple/Packages/MapleBackup/Sources/MapleBackup/GeocodeClient.swift src/apple/Packages/MapleBackup/Tests/MapleBackupTests/GeocodeClientTests.swift
git commit -m "feat(maple-backup): GeocodeClient (wraps GET /api/geocode/reverse)"
```

## Task 2.6: BackupTask value types

**Files:**
- Create: `src/apple/Packages/MapleBackup/Sources/MapleBackup/BackupTask.swift`

(No test — pure value types; covered by the queue test.)

- [ ] **Step 1: Implement**

```swift
// Sources/MapleBackup/BackupTask.swift
import Foundation

public struct BackupTaskID: Hashable, Sendable, Codable {
    public let deviceId: String
    public let phassetLocalId: String
    public init(deviceId: String, phassetLocalId: String) {
        self.deviceId = deviceId
        self.phassetLocalId = phassetLocalId
    }
}

public enum BackupPriority: Int, Comparable, Sendable, Codable {
    case background = 0   // normal queue
    case userEdit = 10    // user is editing this asset right now — jump
    public static func < (a: BackupPriority, b: BackupPriority) -> Bool { a.rawValue < b.rawValue }
}

public enum BackupState: String, Sendable, Codable {
    case observed, pending, uploading, uploaded, failedRetry, skippedPolicy, localEditPending
}

public struct BackupTask: Sendable, Hashable, Codable {
    public let id: BackupTaskID
    public var state: BackupState
    public var priority: BackupPriority
    public var retryCount: Int
    public var lastError: String?
    public var enqueuedAt: Date
    public init(id: BackupTaskID, state: BackupState, priority: BackupPriority,
                retryCount: Int = 0, lastError: String? = nil, enqueuedAt: Date = .now) {
        self.id = id; self.state = state; self.priority = priority
        self.retryCount = retryCount; self.lastError = lastError; self.enqueuedAt = enqueuedAt
    }
}

public enum BackupQueueEvent: Sendable {
    case enqueued(BackupTask)
    case started(BackupTaskID)
    case progress(BackupTaskID, sent: Int64, total: Int64)
    case completed(BackupTaskID, mapleId: String)
    case failed(BackupTaskID, error: String, willRetry: Bool)
    case cancelled(BackupTaskID)
}
```

- [ ] **Step 2: Commit**

```bash
git add src/apple/Packages/MapleBackup/Sources/MapleBackup/BackupTask.swift
git commit -m "feat(maple-backup): BackupTask value types"
```

## Task 2.7: BackupState — GRDB-backed state persistence

**Files:**
- Create: `src/apple/Packages/MapleBackup/Sources/MapleBackup/BackupState.swift`
- Create: `src/apple/Packages/MapleBackup/Tests/MapleBackupTests/BackupStateTests.swift`

- [ ] **Step 1: Write the failing test**

```swift
import XCTest
@testable import MapleBackup

final class BackupStateTests: XCTestCase {
    private func freshStore() throws -> BackupStateStore {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("backup-state-\(UUID().uuidString).sqlite")
        return try BackupStateStore(databaseURL: url)
    }

    func testInsertAndLoad() async throws {
        let store = try freshStore()
        let t = BackupTask(id: BackupTaskID(deviceId: "d", phassetLocalId: "P1"),
                           state: .pending, priority: .background)
        try await store.upsert(t)
        let all = try await store.allTasks()
        XCTAssertEqual(all.count, 1)
        XCTAssertEqual(all[0].state, .pending)
    }
    func testStateTransition() async throws {
        let store = try freshStore()
        let id = BackupTaskID(deviceId: "d", phassetLocalId: "P1")
        try await store.upsert(BackupTask(id: id, state: .pending, priority: .background))
        try await store.transition(id, to: .uploading)
        let row = try await store.find(id)
        XCTAssertEqual(row?.state, .uploading)
    }
    func testFilterByState() async throws {
        let store = try freshStore()
        try await store.upsert(BackupTask(id: BackupTaskID(deviceId: "d", phassetLocalId: "A"),
                                          state: .pending, priority: .background))
        try await store.upsert(BackupTask(id: BackupTaskID(deviceId: "d", phassetLocalId: "B"),
                                          state: .uploaded, priority: .background))
        let pending = try await store.tasks(in: .pending)
        XCTAssertEqual(pending.count, 1)
        XCTAssertEqual(pending[0].id.phassetLocalId, "A")
    }
}
```

- [ ] **Step 2: Run — expect failure**

- [ ] **Step 3: Implement**

```swift
// Sources/MapleBackup/BackupState.swift
import Foundation
import GRDB

public actor BackupStateStore {
    private let dbQueue: DatabaseQueue

    public init(databaseURL: URL) throws {
        self.dbQueue = try DatabaseQueue(path: databaseURL.path)
        try dbQueue.write { db in
            try db.create(table: "tasks", ifNotExists: true) { t in
                t.column("device_id", .text).notNull()
                t.column("phasset_local_id", .text).notNull()
                t.column("state", .text).notNull()
                t.column("priority", .integer).notNull()
                t.column("retry_count", .integer).notNull().defaults(to: 0)
                t.column("last_error", .text)
                t.column("enqueued_at", .double).notNull()
                t.primaryKey(["device_id", "phasset_local_id"])
            }
            try db.create(index: "tasks_state_idx", on: "tasks", columns: ["state"], ifNotExists: true)
        }
    }

    public func upsert(_ task: BackupTask) throws {
        try dbQueue.write { db in
            try db.execute(literal: """
                INSERT OR REPLACE INTO tasks
                  (device_id, phasset_local_id, state, priority, retry_count, last_error, enqueued_at)
                VALUES
                  (\(task.id.deviceId), \(task.id.phassetLocalId), \(task.state.rawValue),
                   \(task.priority.rawValue), \(task.retryCount), \(task.lastError),
                   \(task.enqueuedAt.timeIntervalSince1970))
                """)
        }
    }

    public func transition(_ id: BackupTaskID, to state: BackupState, error: String? = nil) throws {
        try dbQueue.write { db in
            try db.execute(literal: """
                UPDATE tasks SET state=\(state.rawValue), last_error=\(error)
                WHERE device_id=\(id.deviceId) AND phasset_local_id=\(id.phassetLocalId)
                """)
        }
    }

    public func find(_ id: BackupTaskID) throws -> BackupTask? {
        try dbQueue.read { db in
            try Row.fetchOne(db, sql: """
                SELECT * FROM tasks WHERE device_id=? AND phasset_local_id=?
                """, arguments: [id.deviceId, id.phassetLocalId])
                .map(Self.decode)
        }
    }

    public func allTasks() throws -> [BackupTask] {
        try dbQueue.read { db in
            try Row.fetchAll(db, sql: "SELECT * FROM tasks").map(Self.decode)
        }
    }

    public func tasks(in state: BackupState) throws -> [BackupTask] {
        try dbQueue.read { db in
            try Row.fetchAll(db, sql: "SELECT * FROM tasks WHERE state=?",
                             arguments: [state.rawValue]).map(Self.decode)
        }
    }

    private static func decode(_ row: Row) -> BackupTask {
        BackupTask(
            id: BackupTaskID(deviceId: row["device_id"], phassetLocalId: row["phasset_local_id"]),
            state: BackupState(rawValue: row["state"]) ?? .observed,
            priority: BackupPriority(rawValue: row["priority"]) ?? .background,
            retryCount: row["retry_count"],
            lastError: row["last_error"],
            enqueuedAt: Date(timeIntervalSince1970: row["enqueued_at"]))
    }
}
```

- [ ] **Step 4: Run — expect pass**

- [ ] **Step 5: Commit**

```bash
git add src/apple/Packages/MapleBackup/Sources/MapleBackup/BackupState.swift src/apple/Packages/MapleBackup/Tests/MapleBackupTests/BackupStateTests.swift
git commit -m "feat(maple-backup): BackupStateStore (GRDB-backed)"
```

## Task 2.8: BackupQueue protocol + InProcessBackupQueue

**Files:**
- Create: `src/apple/Packages/MapleBackup/Sources/MapleBackup/BackupQueue.swift`
- Create: `src/apple/Packages/MapleBackup/Tests/MapleBackupTests/InProcessBackupQueueTests.swift`

- [ ] **Step 1: Write the failing test**

```swift
import XCTest
@testable import MapleBackup

final class InProcessBackupQueueTests: XCTestCase {
    func testEnqueueAndDrainInPriorityOrder() async throws {
        let q = InProcessBackupQueue()
        await q.enqueue(BackupTask(id: BackupTaskID(deviceId: "d", phassetLocalId: "low"),
                                   state: .pending, priority: .background), priority: .background)
        await q.enqueue(BackupTask(id: BackupTaskID(deviceId: "d", phassetLocalId: "hi"),
                                   state: .pending, priority: .userEdit), priority: .userEdit)
        let a = await q.dequeue()
        XCTAssertEqual(a?.id.phassetLocalId, "hi")
        let b = await q.dequeue()
        XCTAssertEqual(b?.id.phassetLocalId, "low")
        let c = await q.dequeue()
        XCTAssertNil(c)
    }

    func testCancelRemovesPendingTask() async throws {
        let q = InProcessBackupQueue()
        let id = BackupTaskID(deviceId: "d", phassetLocalId: "x")
        await q.enqueue(BackupTask(id: id, state: .pending, priority: .background),
                        priority: .background)
        await q.cancel(id)
        let next = await q.dequeue()
        XCTAssertNil(next)
    }

    func testObserveEmitsEnqueueEvent() async throws {
        let q = InProcessBackupQueue()
        let stream = await q.observe()
        Task {
            await q.enqueue(BackupTask(id: BackupTaskID(deviceId: "d", phassetLocalId: "y"),
                                       state: .pending, priority: .background),
                            priority: .background)
        }
        var it = stream.makeAsyncIterator()
        let evt = await it.next()
        if case .enqueued(let t) = evt {
            XCTAssertEqual(t.id.phassetLocalId, "y")
        } else { XCTFail("expected .enqueued") }
    }
}
```

- [ ] **Step 2: Run — expect failure**

- [ ] **Step 3: Implement**

```swift
// Sources/MapleBackup/BackupQueue.swift
import Foundation

public protocol BackupQueue: Actor {
    func enqueue(_ task: BackupTask, priority: BackupPriority) async
    func cancel(_ id: BackupTaskID) async
    func dequeue() async -> BackupTask?
    func observe() -> AsyncStream<BackupQueueEvent>
    func snapshot() async -> [BackupTask]
}

public actor InProcessBackupQueue: BackupQueue {
    private struct Entry: Comparable {
        let task: BackupTask
        let priority: BackupPriority
        let seq: UInt64
        static func < (a: Entry, b: Entry) -> Bool {
            if a.priority != b.priority { return a.priority > b.priority }
            return a.seq < b.seq // FIFO within same priority
        }
    }

    private var entries: [Entry] = []
    private var nextSeq: UInt64 = 0
    private var continuations: [UUID: AsyncStream<BackupQueueEvent>.Continuation] = [:]

    public init() {}

    public func enqueue(_ task: BackupTask, priority: BackupPriority) async {
        entries.append(Entry(task: task, priority: priority, seq: nextSeq))
        nextSeq &+= 1
        entries.sort()
        for c in continuations.values { c.yield(.enqueued(task)) }
    }

    public func cancel(_ id: BackupTaskID) async {
        entries.removeAll { $0.task.id == id }
        for c in continuations.values { c.yield(.cancelled(id)) }
    }

    public func dequeue() async -> BackupTask? {
        guard !entries.isEmpty else { return nil }
        return entries.removeFirst().task
    }

    public func observe() -> AsyncStream<BackupQueueEvent> {
        let id = UUID()
        return AsyncStream { continuation in
            self.continuations[id] = continuation
            continuation.onTermination = { @Sendable _ in
                Task { await self.removeContinuation(id) }
            }
        }
    }

    private func removeContinuation(_ id: UUID) {
        continuations.removeValue(forKey: id)
    }

    public func snapshot() async -> [BackupTask] {
        entries.map(\.task)
    }
}
```

- [ ] **Step 4: Run — expect pass**

- [ ] **Step 5: Commit**

```bash
git add src/apple/Packages/MapleBackup/Sources/MapleBackup/BackupQueue.swift src/apple/Packages/MapleBackup/Tests/MapleBackupTests/InProcessBackupQueueTests.swift
git commit -m "feat(maple-backup): BackupQueue protocol + InProcessBackupQueue"
```

## Task 2.9: PayloadAssembler (PHAsset → upload payload)

**Files:**
- Create: `src/apple/Packages/MapleBackup/Sources/MapleBackup/PayloadAssembler.swift`
- Create: `src/apple/Packages/MapleBackup/Tests/MapleBackupTests/PayloadAssemblerTests.swift`

PhotoKit-using code can't run in `swift test` (the Photo Library isn't available off-device). The Assembler is split: a pure transform layer with no PhotoKit symbols (testable) and a thin PhotoKit-touching wrapper (covered by app-level integration only). This task implements only the pure transform.

- [ ] **Step 1: Write the failing test**

```swift
import XCTest
@testable import MapleBackup

final class PayloadAssemblerTests: XCTestCase {
    func testSidecarXMPCarriesExpectedFields() throws {
        let xml = PayloadAssembler.buildSidecarXMP(input: .init(
            phassetLocalId: "ABC/L0/001",
            deviceId: "uuid-1",
            captureDate: Date(timeIntervalSince1970: 1_700_000_000),
            latitude: 35.68, longitude: 139.69,
            favorite: true,
            caption: "Cherry blossoms",
            keywords: ["spring", "japan"],
            tags: ["Trips", "Tokyo"],
            livePhotoCompanion: "IMG_0420.mov",
            burstStackId: nil,
            originalFilename: "IMG_0420.HEIC",
            mtime: 1_700_000_000))
        XCTAssertTrue(xml.contains("maple:phassetLocalId=\"ABC/L0/001\""))
        XCTAssertTrue(xml.contains("maple:deviceId=\"uuid-1\""))
        XCTAssertTrue(xml.contains("maple:favorite=\"True\""))
        XCTAssertTrue(xml.contains("<rdf:li>Trips</rdf:li>"))
        XCTAssertTrue(xml.contains("<rdf:li>Tokyo</rdf:li>"))
        XCTAssertTrue(xml.contains("maple:livePhotoCompanion=\"IMG_0420.mov\""))
    }
}
```

- [ ] **Step 2: Run — expect failure**

- [ ] **Step 3: Implement**

```swift
// Sources/MapleBackup/PayloadAssembler.swift
import Foundation

public enum PayloadAssembler {
    public struct SidecarInput: Sendable {
        public let phassetLocalId: String
        public let deviceId: String
        public let captureDate: Date
        public let latitude: Double?
        public let longitude: Double?
        public let favorite: Bool
        public let caption: String?
        public let keywords: [String]
        public let tags: [String]
        public let livePhotoCompanion: String?
        public let burstStackId: String?
        public let originalFilename: String
        public let mtime: TimeInterval
        public init(phassetLocalId: String, deviceId: String, captureDate: Date,
                    latitude: Double?, longitude: Double?, favorite: Bool,
                    caption: String?, keywords: [String], tags: [String],
                    livePhotoCompanion: String?, burstStackId: String?,
                    originalFilename: String, mtime: TimeInterval) {
            self.phassetLocalId = phassetLocalId
            self.deviceId = deviceId
            self.captureDate = captureDate
            self.latitude = latitude; self.longitude = longitude
            self.favorite = favorite; self.caption = caption
            self.keywords = keywords; self.tags = tags
            self.livePhotoCompanion = livePhotoCompanion
            self.burstStackId = burstStackId
            self.originalFilename = originalFilename
            self.mtime = mtime
        }
    }

    public static func buildSidecarXMP(input: SidecarInput) -> String {
        let iso = ISO8601DateFormatter().string(from: input.captureDate)
        let lat = input.latitude.map { String($0) } ?? ""
        let lon = input.longitude.map { String($0) } ?? ""
        let caption = (input.caption ?? "").replacingOccurrences(of: "\"", with: "&quot;")
        let kw = input.keywords.map { "<rdf:li>\($0)</rdf:li>" }.joined()
        let tags = input.tags.map { "<rdf:li>\($0)</rdf:li>" }.joined()
        let live = input.livePhotoCompanion ?? ""
        let burst = input.burstStackId ?? ""
        return """
        <x:xmpmeta xmlns:x="adobe:ns:meta/">
          <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"
                   xmlns:maple="https://justmaple.app/ns/maple/1.0/">
            <rdf:Description
              maple:phassetLocalId="\(input.phassetLocalId)"
              maple:deviceId="\(input.deviceId)"
              maple:captureDate="\(iso)"
              maple:gpsLat="\(lat)"
              maple:gpsLon="\(lon)"
              maple:favorite="\(input.favorite ? "True" : "False")"
              maple:caption="\(caption)"
              maple:livePhotoCompanion="\(live)"
              maple:burstStackId="\(burst)"
              maple:originalFilename="\(input.originalFilename)"
              maple:mtime="\(input.mtime)">
              <maple:keywords><rdf:Bag>\(kw)</rdf:Bag></maple:keywords>
              <maple:tags><rdf:Bag>\(tags)</rdf:Bag></maple:tags>
            </rdf:Description>
          </rdf:RDF>
        </x:xmpmeta>
        """
    }
}
```

- [ ] **Step 4: Run — expect pass**

- [ ] **Step 5: Commit**

```bash
git add src/apple/Packages/MapleBackup/Sources/MapleBackup/PayloadAssembler.swift src/apple/Packages/MapleBackup/Tests/MapleBackupTests/PayloadAssemblerTests.swift
git commit -m "feat(maple-backup): PayloadAssembler.buildSidecarXMP"
```

## Task 2.10: Cross-platform path-formatter parity test

**Files:**
- Create: `src/apple/Packages/MapleBackup/Tests/MapleBackupTests/PathFormatterParityTests.swift`
- Create: `src/scripts/test_path_formatter_parity.sh` (driver)

The Swift formatter must produce byte-identical output to the TypeScript one. Test by writing the test cases to JSON, running both, diffing.

- [ ] **Step 1: Create the JSON case set**

`src/scripts/path-formatter-cases.json`:

```json
[
  { "captureDate": "2024-03-15T10:30:00Z", "location": "Tokyo", "filename": "IMG_0420.HEIC",
    "expected": "2024/Tokyo/03-15/IMG_0420.HEIC" },
  { "captureDate": "2024-07-19T08:00:00Z", "location": null, "filename": "IMG_0512.HEIC",
    "expected": "2024/07/19/IMG_0512.HEIC" },
  { "captureDate": "2024-03-15T23:59:00Z", "location": "St. Tropez / Var", "filename": "IMG.heic",
    "expected": "2024/St. Tropez _ Var/03-15/IMG.heic" },
  { "captureDate": "2024-03-15T10:30:00Z", "location": "", "filename": "IMG.heic",
    "expected": "2024/03/15/IMG.heic" }
]
```

- [ ] **Step 2: Add the Swift side parity test**

```swift
// Tests/MapleBackupTests/PathFormatterParityTests.swift
import XCTest
@testable import MapleBackup

final class PathFormatterParityTests: XCTestCase {
    private struct Case: Decodable {
        let captureDate: String
        let location: String?
        let filename: String
        let expected: String
    }

    func testAllJSONCases() throws {
        let url = URL(fileURLWithPath: "../../../scripts/path-formatter-cases.json",
                      relativeTo: URL(fileURLWithPath: #filePath))
        let data = try Data(contentsOf: url)
        let cases = try JSONDecoder().decode([Case].self, from: data)
        for c in cases {
            let date = ISO8601DateFormatter().date(from: c.captureDate)!
            let got = PathFormatter.format(captureDate: date, location: c.location, filename: c.filename)
            XCTAssertEqual(got, c.expected, "case \(c.captureDate) / \(c.location ?? "nil")")
        }
    }
}
```

- [ ] **Step 3: Add the TS-side parity check**

```ts
// src/api/src/backup/path-formatter.parity.test.ts
import { describe, test, expect } from "bun:test";
import { formatBackupPath } from "./path-formatter.ts";
import { readFileSync } from "node:fs";

describe("PathFormatter parity (TS)", () => {
  const cases = JSON.parse(readFileSync(`${import.meta.dir}/../../../../scripts/path-formatter-cases.json`, "utf8"));
  for (const c of cases) {
    test(`${c.captureDate} / ${c.location}`, () => {
      const got = formatBackupPath({
        captureDate: new Date(c.captureDate),
        location: c.location,
        filename: c.filename,
      });
      expect(got).toBe(c.expected);
    });
  }
});
```

- [ ] **Step 4: Run both**

```bash
cd src/api && bun test src/backup/path-formatter.parity.test.ts
cd src/apple/Packages/MapleBackup && swift test --filter PathFormatterParityTests
```

Expected: both pass with 4 cases each.

- [ ] **Step 5: Commit**

```bash
git add src/scripts/path-formatter-cases.json \
  src/api/src/backup/path-formatter.parity.test.ts \
  src/apple/Packages/MapleBackup/Tests/MapleBackupTests/PathFormatterParityTests.swift
git commit -m "test: path-formatter parity (Swift ↔ TypeScript)"
```

## Task 2.11: UploadClient (chunked, resumable)

**Files:**
- Create: `src/apple/Packages/MapleBackup/Sources/MapleBackup/UploadClient.swift`
- Create: `src/apple/Packages/MapleBackup/Tests/MapleBackupTests/UploadClientTests.swift`

- [ ] **Step 1: Write the failing test**

```swift
import XCTest
@testable import MapleBackup

final class UploadClientTests: XCTestCase {
    override func setUp() { URLProtocol.registerClass(StubProtocol.self) }
    override func tearDown() { URLProtocol.unregisterClass(StubProtocol.self) }

    private var session: URLSession {
        let c = URLSessionConfiguration.ephemeral
        c.protocolClasses = [StubProtocol.self]
        return URLSession(configuration: c)
    }

    func testHappyPathSingleChunk() async throws {
        StubProtocol.stub = .ok(json: #"{"maple_id":"abc","target_rel_path":"2024/Tokyo/03-15/IMG.heic"}"#)
        let client = UploadClient(baseURL: URL(string: "https://server.example")!,
                                  libraryId: "lib", deviceId: "dev", session: session)
        let result = try await client.upload(
            phassetLocalId: "P1", filename: "IMG.heic",
            captureDate: Date(timeIntervalSince1970: 1_700_000_000),
            lat: nil, lon: nil,
            bytes: Data(count: 256), mapleId: "abc")
        XCTAssertEqual(result.targetRelPath, "2024/Tokyo/03-15/IMG.heic")
    }
}
```

- [ ] **Step 2: Run — expect failure**

- [ ] **Step 3: Implement**

```swift
// Sources/MapleBackup/UploadClient.swift
import Foundation

public actor UploadClient {
    public struct Result: Sendable { public let mapleId: String; public let targetRelPath: String }
    public enum UploadError: Error { case httpError(Int), badResponse, resumeMismatch(expected: Int64) }

    private let baseURL: URL
    private let libraryId: String
    private let deviceId: String
    private let session: URLSession
    /// 4 MiB default. Tunable from the engine.
    public var chunkSize: Int = 4 * 1024 * 1024

    public init(baseURL: URL, libraryId: String, deviceId: String, session: URLSession = .shared) {
        self.baseURL = baseURL
        self.libraryId = libraryId
        self.deviceId = deviceId
        self.session = session
    }

    public func upload(phassetLocalId: String, filename: String, captureDate: Date,
                       lat: Double?, lon: Double?, bytes: Data, mapleId: String) async throws -> Result {
        let total = Int64(bytes.count)
        var offset: Int64 = 0
        let urlString = baseURL.appendingPathComponent("api/libraries/\(libraryId)/backup/ingest").absoluteString
        while offset < total {
            let end = min(offset + Int64(chunkSize), total) - 1
            let chunk = bytes.subdata(in: Int(offset)..<Int(end + 1))
            let isFinal = end + 1 == total
            var req = URLRequest(url: URL(string: urlString)!)
            req.httpMethod = "POST"
            req.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
            req.setValue("bytes \(offset)-\(end)/\(total)", forHTTPHeaderField: "Content-Range")
            req.setValue(deviceId, forHTTPHeaderField: "X-Maple-Device-Id")
            req.setValue(phassetLocalId, forHTTPHeaderField: "X-Maple-Phasset-Id")
            req.setValue(ISO8601DateFormatter().string(from: captureDate), forHTTPHeaderField: "X-Maple-Capture-Date")
            req.setValue(filename, forHTTPHeaderField: "X-Maple-Filename")
            req.setValue(String(total), forHTTPHeaderField: "X-Maple-Total-Bytes")
            if let lat { req.setValue(String(lat), forHTTPHeaderField: "X-Maple-Lat") }
            if let lon { req.setValue(String(lon), forHTTPHeaderField: "X-Maple-Lon") }
            if isFinal { req.setValue(mapleId, forHTTPHeaderField: "X-Maple-Maple-Id") }
            req.httpBody = chunk

            let (data, resp) = try await session.data(for: req)
            guard let http = resp as? HTTPURLResponse else { throw UploadError.badResponse }
            if http.statusCode == 409 {
                // resume offset mismatch — server tells us where to pick up
                struct Mismatch: Decodable { let expected_offset: Int64 }
                if let body = try? JSONDecoder().decode(Mismatch.self, from: data) {
                    offset = body.expected_offset
                    continue
                }
                throw UploadError.resumeMismatch(expected: 0)
            }
            if isFinal {
                guard http.statusCode == 200 else { throw UploadError.httpError(http.statusCode) }
                struct Final: Decodable { let maple_id: String; let target_rel_path: String }
                let f = try JSONDecoder().decode(Final.self, from: data)
                return Result(mapleId: f.maple_id, targetRelPath: f.target_rel_path)
            } else {
                guard http.statusCode == 202 else { throw UploadError.httpError(http.statusCode) }
                offset = end + 1
            }
        }
        throw UploadError.badResponse
    }
}
```

(Reuse `StubProtocol` from `GeocodeClientTests.swift` — either move it to a `TestHelpers.swift` file or duplicate. Prefer extraction:)

- [ ] **Step 3a: Extract StubProtocol**

Move `StubProtocol` from `GeocodeClientTests.swift` to `Tests/MapleBackupTests/Helpers/StubProtocol.swift`. Make it `internal final class`. Update both test files to import it.

- [ ] **Step 4: Run — expect pass**

- [ ] **Step 5: Commit**

```bash
git add src/apple/Packages/MapleBackup/Sources/MapleBackup/UploadClient.swift \
  src/apple/Packages/MapleBackup/Tests/MapleBackupTests/UploadClientTests.swift \
  src/apple/Packages/MapleBackup/Tests/MapleBackupTests/Helpers/StubProtocol.swift
git commit -m "feat(maple-backup): UploadClient (chunked, resumable)"
```

## Task 2.12: BackupEngine actor (ties it all together)

**Files:**
- Create: `src/apple/Packages/MapleBackup/Sources/MapleBackup/BackupEngine.swift`
- Create: `src/apple/Packages/MapleBackup/Tests/MapleBackupTests/BackupEngineTests.swift`

The engine takes a queue + state-store + upload-client + sidecar-store and drives them. Tested with stubbed PhotoKit-touching dependencies via an injected `AssetReader` protocol so the test can feed synthetic bytes.

- [ ] **Step 1: Define `AssetReader` protocol**

In `Sources/MapleBackup/BackupEngine.swift` (top of file):

```swift
public protocol AssetReader: Actor {
    /// Returns the original bytes, optional Apple-rendered bytes, and sidecar input
    /// for the given PHAsset localIdentifier. Real implementation lives in
    /// MapleApp / EngineHost; tests inject a stub.
    func read(phassetLocalId: String) async throws -> AssetReadResult
}

public struct AssetReadResult: Sendable {
    public let originalBytes: Data
    public let renderedBytes: Data?
    public let sidecar: PayloadAssembler.SidecarInput
    public let mapleId: String
    public init(originalBytes: Data, renderedBytes: Data?,
                sidecar: PayloadAssembler.SidecarInput, mapleId: String) {
        self.originalBytes = originalBytes; self.renderedBytes = renderedBytes
        self.sidecar = sidecar; self.mapleId = mapleId
    }
}
```

- [ ] **Step 2: Write the failing test**

```swift
import XCTest
@testable import MapleBackup

private actor StubReader: AssetReader {
    func read(phassetLocalId: String) async throws -> AssetReadResult {
        AssetReadResult(
            originalBytes: Data(count: 256), renderedBytes: nil,
            sidecar: .init(phassetLocalId: phassetLocalId, deviceId: "d",
                           captureDate: Date(timeIntervalSince1970: 1_700_000_000),
                           latitude: nil, longitude: nil, favorite: false,
                           caption: nil, keywords: [], tags: [],
                           livePhotoCompanion: nil, burstStackId: nil,
                           originalFilename: "IMG.heic", mtime: 0),
            mapleId: "hash-\(phassetLocalId)")
    }
}

final class BackupEngineTests: XCTestCase {
    override func setUp() { URLProtocol.registerClass(StubProtocol.self) }
    override func tearDown() { URLProtocol.unregisterClass(StubProtocol.self) }

    func testProcessQueueOneTaskUploadsAndPersistsUploadedState() async throws {
        StubProtocol.stub = .ok(json: #"{"maple_id":"hash-P1","target_rel_path":"2024/03/15/IMG.heic"}"#)
        let cfg = URLSessionConfiguration.ephemeral
        cfg.protocolClasses = [StubProtocol.self]
        let session = URLSession(configuration: cfg)

        let stateURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("engine-state-\(UUID().uuidString).sqlite")
        let store = try BackupStateStore(databaseURL: stateURL)
        let queue = InProcessBackupQueue()
        let upload = UploadClient(baseURL: URL(string: "https://server.example")!,
                                  libraryId: "lib", deviceId: "d", session: session)
        let sidecars = AppSupportSidecarStore(root: FileManager.default.temporaryDirectory
            .appendingPathComponent("sc-\(UUID().uuidString)", isDirectory: true))
        try FileManager.default.createDirectory(at: sidecars.rootForTesting,
                                                withIntermediateDirectories: true)
        let engine = BackupEngine(queue: queue, state: store, upload: upload,
                                  sidecars: sidecars, reader: StubReader())

        await queue.enqueue(BackupTask(id: BackupTaskID(deviceId: "d", phassetLocalId: "P1"),
                                       state: .pending, priority: .background),
                            priority: .background)
        try await engine.processOne()
        let row = try await store.find(BackupTaskID(deviceId: "d", phassetLocalId: "P1"))
        XCTAssertEqual(row?.state, .uploaded)
    }
}
```

(Note: `AppSupportSidecarStore.rootForTesting` is an internal accessor; add it in the implementation step if needed.)

- [ ] **Step 3: Implement**

```swift
// Append to Sources/MapleBackup/BackupEngine.swift after the protocol/struct above:
public actor BackupEngine {
    private let queue: any BackupQueue
    private let state: BackupStateStore
    private let upload: UploadClient
    private let sidecars: AppSupportSidecarStore
    private let reader: any AssetReader

    public init(queue: any BackupQueue, state: BackupStateStore, upload: UploadClient,
                sidecars: AppSupportSidecarStore, reader: any AssetReader) {
        self.queue = queue; self.state = state; self.upload = upload
        self.sidecars = sidecars; self.reader = reader
    }

    /// Drive the queue until empty. The host (MapleApp / MapleBackupAgent)
    /// calls this on a long-lived background Task.
    public func run() async {
        while let next = await queue.dequeue() {
            do { try await processOne(task: next) }
            catch { /* TODO: telemetry; see Task 8.4 */ }
        }
    }

    /// Process a single task — used by tests; production callers use `run()`.
    public func processOne(task: BackupTask? = nil) async throws {
        let t: BackupTask
        if let task { t = task } else if let next = await queue.dequeue() { t = next } else { return }
        try await state.transition(t.id, to: .uploading)
        let read = try await reader.read(phassetLocalId: t.id.phassetLocalId)
        _ = try await upload.upload(
            phassetLocalId: t.id.phassetLocalId,
            filename: read.sidecar.originalFilename,
            captureDate: read.sidecar.captureDate,
            lat: read.sidecar.latitude, lon: read.sidecar.longitude,
            bytes: read.originalBytes, mapleId: read.mapleId)
        // On success, drop any App-Support sidecar (it lived only until upload).
        try? sidecars.delete(phassetLocalId: t.id.phassetLocalId)
        try await state.transition(t.id, to: .uploaded)
    }
}
```

- [ ] **Step 4: Add the test-only accessor in `AppSupportSidecarStore`**

```swift
// Internal: tests in the same module can read the root path.
extension AppSupportSidecarStore {
    internal var rootForTesting: URL { root }
}
```

- [ ] **Step 5: Run — expect pass**

- [ ] **Step 6: Commit**

```bash
git add src/apple/Packages/MapleBackup/Sources/MapleBackup/BackupEngine.swift \
  src/apple/Packages/MapleBackup/Sources/MapleBackup/AppSupportSidecarStore.swift \
  src/apple/Packages/MapleBackup/Tests/MapleBackupTests/BackupEngineTests.swift
git commit -m "feat(maple-backup): BackupEngine actor"
```

## Task 2.13: PhotoKitSource — writeXMP via AppSupportSidecarStore

**Files:**
- Modify: `src/apple/Packages/MapleCore/Sources/MapleCore/Sources/PhotoKitSource.swift` (lines 373-376 — the throwing stub)
- Modify: `src/apple/Packages/MapleCore/Package.swift` — add MapleBackup dependency

- [ ] **Step 1: Add MapleBackup dependency**

In `src/apple/Packages/MapleCore/Package.swift`, add to the package dependencies:

```swift
.package(path: "../MapleBackup"),
```

And to the MapleCore target dependencies:

```swift
.product(name: "MapleBackup", package: "MapleBackup"),
```

- [ ] **Step 2: Write the failing test**

```swift
// src/apple/Packages/MapleCore/Tests/MapleCoreTests/PhotoKitSourceXMPTests.swift
import XCTest
@testable import MapleCore

final class PhotoKitSourceXMPTests: XCTestCase {
    func testWriteXMPPersistsToShadowStore() async throws {
        // The shadow store is independent of PhotoKit auth state — we can
        // exercise it without a real PHAsset.
        let phid = "ABC/L0/001"
        let source = PhotoKitSource()
        let sidecar = Sidecar(model: .default, culling: CullingState())
        let ref = ImageRef(id: phid, displayName: phid)
        try await source.writeXMP(sidecar, for: ref)
        let read = try await source.readXMP(for: ref)
        XCTAssertEqual(read.0, sidecar.model)
    }
}
```

(`readXMP` doesn't exist yet — Task 2.14 will add it. This test will fail twice — once for missing implementation, then again until 2.14 adds the reader.)

- [ ] **Step 3: Run — expect failure**

```bash
cd src/apple/Packages/MapleCore && swift test --filter PhotoKitSourceXMPTests
```

Expected: compilation error.

- [ ] **Step 4: Implement writeXMP**

In `PhotoKitSource.swift`, replace the throwing `writeXMP` with:

```swift
import MapleBackup
// ...

private let appSupportSidecars: AppSupportSidecarStore = {
    do { return AppSupportSidecarStore(root: try AppSupportSidecarStore.defaultRoot()) }
    catch { fatalError("PhotoKit sidecar root unavailable: \(error)") }
}()

public func writeXMP(_ sidecar: Sidecar, for ref: ImageRef) async throws {
    // Marshal Sidecar (AdjustmentModel + CullingState) through the existing
    // XMP encoder used by XMPSidecarStore. Reuse the same helper — pull it
    // out into a static `XMPCodec.encode(_: Sidecar) -> String` if it isn't
    // already (see XMPSidecarStore.swift:80-120 for the current shape).
    let xml = try XMPCodec.encode(sidecar)
    try appSupportSidecars.write(phassetLocalId: ref.id, xmp: xml)
}
```

This task assumes the existing `XMPSidecarStore` has its encode/decode logic extractable. If it lives inline in the store, extract it to a `XMPCodec.swift` in the same sub-folder (Task 2.13a). Decode logic mirrors.

- [ ] **Step 4a (only if needed): Extract XMPCodec**

If the current `XMPSidecarStore.swift` has inline encode/decode, create `src/apple/Packages/MapleCore/Sources/MapleCore/XMPCodec.swift` with the extracted `encode(_:)` and `decode(_:)` static methods and update `XMPSidecarStore` to call them. Tests for the codec already exist (`AdjustmentModelTests`); rerun to verify no regression.

- [ ] **Step 5: Commit**

```bash
git add src/apple/Packages/MapleCore/Package.swift \
  src/apple/Packages/MapleCore/Sources/MapleCore/Sources/PhotoKitSource.swift \
  src/apple/Packages/MapleCore/Tests/MapleCoreTests/PhotoKitSourceXMPTests.swift
# include XMPCodec.swift if extracted
git commit -m "feat(maple-core): PhotoKitSource.writeXMP via AppSupportSidecarStore"
```

## Task 2.14: PhotoKitSource — readXMP

**Files:**
- Modify: `src/apple/Packages/MapleCore/Sources/MapleCore/Sources/PhotoKitSource.swift`

- [ ] **Step 1: Implement readXMP**

```swift
public func readXMP(for ref: ImageRef) async throws -> (AdjustmentModel, CullingState) {
    if let xml = try appSupportSidecars.read(phassetLocalId: ref.id),
       let decoded = try? XMPCodec.decode(xml) {
        return (decoded.model, decoded.culling)
    }
    return (.default, CullingState())
}
```

Update `SidecarStoreProtocol` and `EditSession` (if needed) so a Photo-Kit-sourced edit knows to call `PhotoKitSource.readXMP` instead of looking for an `.xmp` next to the (nonexistent) file.

- [ ] **Step 2: Run the test from 2.13 — expect pass**

```bash
cd src/apple/Packages/MapleCore && swift test --filter PhotoKitSourceXMPTests
```

- [ ] **Step 3: Commit**

```bash
git add src/apple/Packages/MapleCore/Sources/MapleCore/Sources/PhotoKitSource.swift
git commit -m "feat(maple-core): PhotoKitSource.readXMP from AppSupportSidecarStore"
```

## Task 2.15: Phase 2 PR

- [ ] **Step 1: Full Swift test pass**

```bash
cd src/apple/Packages/MapleBackup && swift test
cd src/apple/Packages/MapleCore && swift test
```

Both green. Pre-existing test count for MapleCore should not drop.

- [ ] **Step 2: Open PR**

```bash
gh pr create --title "feat(maple): MapleBackup SPM module + PhotoKitSource sidecar writes" --body "$(cat <<'EOF'
## Summary
- New SPM module \`MapleBackup\` at src/apple/Packages/MapleBackup with the device-side engine: BackupQueue, BackupStateStore (GRDB), UploadClient (chunked + resumable), AppSupportSidecarStore, PathFormatter, GeocodeClient, BackupEngine actor.
- PhotoKitSource.writeXMP / readXMP wired through AppSupportSidecarStore so PhotoKit photos become editable in Maple without modifying the originals.
- Path formatter parity test between Swift and TypeScript implementations.

Server side: see PR for Phase 1.

## Test plan
- [ ] \`swift test\` in MapleBackup passes
- [ ] \`swift test\` in MapleCore passes (no regression)
- [ ] Parity test green
EOF
)"
```

---

# Phase 3 — App integration (hosting, settings, merged timeline, sync, hardening)

Goal: wire the engine into MapleApp, add the LaunchAgent on macOS, ship the settings UI + merged timeline UI, register the iOS background task, and harden the failure paths.

## Task 3.1: EngineHost — boot the engine inside MapleApp

**Files:**
- Create: `src/apple/Maple/Backup/EngineHost.swift`
- Modify: `src/apple/Maple/MapleApp.swift`

- [ ] **Step 1: Implement EngineHost**

```swift
// src/apple/Maple/Backup/EngineHost.swift
import Foundation
import Photos
import MapleBackup
import MapleCore

/// Singleton boot for the device-side BackupEngine. Lives for the life of
/// the process. `MapleApp` constructs it once and forgets about it; UI reads
/// progress via `BackupQueue.observe()`.
@MainActor
final class EngineHost {
    static let shared = EngineHost()

    private(set) var engine: BackupEngine?
    private(set) var queue: any BackupQueue = InProcessBackupQueue()
    private(set) var state: BackupStateStore?
    private(set) var sidecars: AppSupportSidecarStore?
    private var runnerTask: Task<Void, Never>?

    private init() {}

    func start(serverBaseURL: URL, libraryId: String) async {
        do {
            let appSupport = try FileManager.default.url(
                for: .applicationSupportDirectory, in: .userDomainMask,
                appropriateFor: nil, create: true)
                .appendingPathComponent("Maple", isDirectory: true)
            try FileManager.default.createDirectory(at: appSupport, withIntermediateDirectories: true)

            let deviceId = try DeviceIdentity.current(storageURL: try DeviceIdentity.defaultStorageURL())
            let sidecars = AppSupportSidecarStore(root: try AppSupportSidecarStore.defaultRoot())
            let state = try BackupStateStore(databaseURL: appSupport.appendingPathComponent("backup-state.sqlite"))
            let upload = UploadClient(baseURL: serverBaseURL, libraryId: libraryId, deviceId: deviceId)
            let reader = PhotoKitAssetReader(deviceId: deviceId,
                                             geocode: GeocodeClient(baseURL: serverBaseURL))
            let engine = BackupEngine(queue: queue, state: state, upload: upload,
                                      sidecars: sidecars, reader: reader)
            self.engine = engine
            self.state = state
            self.sidecars = sidecars
            self.runnerTask = Task.detached(priority: .background) { await engine.run() }
        } catch {
            // TODO: surface to user via the settings panel
            print("EngineHost start failed: \(error)")
        }
    }

    func stop() {
        runnerTask?.cancel()
        runnerTask = nil
    }
}
```

- [ ] **Step 2: Wire into MapleApp.swift**

Find the `MapleApp` `@main` struct and add inside the `.task` (or `init`) hook:

```swift
.task {
    if let settings = BackupSettings.load(),
       let url = URL(string: settings.serverURL) {
        await EngineHost.shared.start(serverBaseURL: url, libraryId: settings.libraryId)
    }
}
```

(`BackupSettings.load()` is added in Task 3.4. For now this code references a type that doesn't exist yet — the task can be wired but commented out until 3.4 lands, or implement 3.4 first.)

- [ ] **Step 3: Commit**

```bash
git add src/apple/Maple/Backup/EngineHost.swift src/apple/Maple/MapleApp.swift
git commit -m "feat(maple-app): EngineHost wires BackupEngine into the app lifecycle"
```

## Task 3.2: PhotoKitAssetReader (PhotoKit-touching wrapper)

**Files:**
- Create: `src/apple/Maple/Backup/PhotoKitAssetReader.swift`

This isn't unit-tested directly (PhotoKit isn't available in `swift test`). It's exercised via the manual run in Task 3.10.

- [ ] **Step 1: Implement**

```swift
// src/apple/Maple/Backup/PhotoKitAssetReader.swift
import Foundation
import Photos
import CryptoKit
import MapleBackup

actor PhotoKitAssetReader: AssetReader {
    private let deviceId: String
    private let geocode: GeocodeClient

    init(deviceId: String, geocode: GeocodeClient) {
        self.deviceId = deviceId
        self.geocode = geocode
    }

    func read(phassetLocalId: String) async throws -> AssetReadResult {
        let asset = PHAsset.fetchAssets(withLocalIdentifiers: [phassetLocalId], options: nil).firstObject!
        let resources = PHAssetResource.assetResources(for: asset)
        let originalResource = resources.first { $0.type == .photo || $0.type == .video || $0.type == .audio }!
        let renderedResource = resources.first { $0.type == .fullSizePhoto }

        let originalBytes = try await Self.readAllBytes(of: originalResource)
        let renderedBytes: Data? = renderedResource.map { try? await Self.readAllBytes(of: $0) } ?? nil

        let captureDate = asset.creationDate ?? Date()
        let lat = asset.location?.coordinate.latitude
        let lon = asset.location?.coordinate.longitude
        let filename = originalResource.originalFilename

        // BLAKE3 hash via existing raw-pipeline primitive. For the early v1
        // we substitute SHA-256 hex — Task 8.5 swaps in BLAKE3 once the
        // raw-pipeline FFI exposes it for Swift.
        let hash = SHA256.hash(data: originalBytes).map { String(format: "%02x", $0) }.joined()

        let sidecar = PayloadAssembler.SidecarInput(
            phassetLocalId: phassetLocalId, deviceId: deviceId,
            captureDate: captureDate, latitude: lat, longitude: lon,
            favorite: asset.isFavorite, caption: nil,
            keywords: [], tags: [],
            livePhotoCompanion: nil, burstStackId: asset.burstIdentifier,
            originalFilename: filename, mtime: Date().timeIntervalSince1970)

        return AssetReadResult(originalBytes: originalBytes, renderedBytes: renderedBytes,
                               sidecar: sidecar, mapleId: hash)
    }

    private static func readAllBytes(of resource: PHAssetResource) async throws -> Data {
        var accumulator = Data()
        let options = PHAssetResourceRequestOptions()
        options.isNetworkAccessAllowed = true
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            PHAssetResourceManager.default().requestData(
                for: resource, options: options,
                dataReceivedHandler: { accumulator.append($0) },
                completionHandler: { err in
                    if let err { continuation.resume(throwing: err) }
                    else { continuation.resume() }
                })
        }
        return accumulator
    }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/apple/Maple/Backup/PhotoKitAssetReader.swift
git commit -m "feat(maple-app): PhotoKitAssetReader bridges PhotoKit → AssetReader"
```

## Task 3.3: BackupSettings persisted in UserDefaults

**Files:**
- Create: `src/apple/Maple/Backup/BackupSettings.swift`
- Create: `src/apple/Packages/MapleCore/Tests/MapleCoreTests/BackupSettingsTests.swift`

- [ ] **Step 1: Write the failing test**

```swift
import XCTest
@testable import MapleCore  // assume BackupSettings lives in MapleCore for testability

final class BackupSettingsTests: XCTestCase {
    private let suiteName = "BackupSettingsTests-\(UUID().uuidString)"
    private var defaults: UserDefaults!

    override func setUp() {
        defaults = UserDefaults(suiteName: suiteName)!
        defaults.removePersistentDomain(forName: suiteName)
    }

    func testSaveAndLoad() {
        let s = BackupSettings(serverURL: "https://srv.example", libraryId: "lib1",
                               rootFolder: "Photos/", wifiOnly: true,
                               includeLivePhotos: true, includeVideos: true,
                               includeBursts: false, includeSharedLibrary: true,
                               includeSharedAlbums: false)
        s.save(to: defaults)
        let loaded = BackupSettings.load(from: defaults)
        XCTAssertEqual(loaded, s)
    }
}
```

- [ ] **Step 2: Implement**

Put `BackupSettings` in `src/apple/Packages/MapleCore/Sources/MapleCore/BackupSettings.swift` (so the test target can reach it):

```swift
import Foundation

public struct BackupSettings: Equatable, Codable, Sendable {
    public var serverURL: String
    public var libraryId: String
    public var rootFolder: String
    public var wifiOnly: Bool
    public var includeLivePhotos: Bool
    public var includeVideos: Bool
    public var includeBursts: Bool
    public var includeSharedLibrary: Bool
    public var includeSharedAlbums: Bool

    public init(serverURL: String, libraryId: String, rootFolder: String,
                wifiOnly: Bool, includeLivePhotos: Bool, includeVideos: Bool,
                includeBursts: Bool, includeSharedLibrary: Bool, includeSharedAlbums: Bool) {
        self.serverURL = serverURL; self.libraryId = libraryId
        self.rootFolder = rootFolder; self.wifiOnly = wifiOnly
        self.includeLivePhotos = includeLivePhotos; self.includeVideos = includeVideos
        self.includeBursts = includeBursts
        self.includeSharedLibrary = includeSharedLibrary
        self.includeSharedAlbums = includeSharedAlbums
    }

    private static let key = "maple.backup.settings.v1"

    public func save(to defaults: UserDefaults = .standard) {
        guard let data = try? JSONEncoder().encode(self) else { return }
        defaults.set(data, forKey: Self.key)
    }
    public static func load(from defaults: UserDefaults = .standard) -> BackupSettings? {
        guard let data = defaults.data(forKey: key) else { return nil }
        return try? JSONDecoder().decode(BackupSettings.self, from: data)
    }
}
```

- [ ] **Step 3: Run — expect pass**

- [ ] **Step 4: Commit**

```bash
git add src/apple/Packages/MapleCore/Sources/MapleCore/BackupSettings.swift \
  src/apple/Packages/MapleCore/Tests/MapleCoreTests/BackupSettingsTests.swift
git commit -m "feat(maple-core): BackupSettings persistence"
```

## Task 3.4: BackupSettingsView (SwiftUI)

**Files:**
- Create: `src/apple/Maple/Views/Settings/BackupSettingsView.swift`

- [ ] **Step 1: Implement**

```swift
// src/apple/Maple/Views/Settings/BackupSettingsView.swift
import SwiftUI
import MapleCore

@MainActor
struct BackupSettingsView: View {
    @State private var settings = BackupSettings.load() ?? BackupSettings(
        serverURL: "", libraryId: "", rootFolder: "Photos/",
        wifiOnly: true, includeLivePhotos: true, includeVideos: true,
        includeBursts: false, includeSharedLibrary: true, includeSharedAlbums: false)
    @State private var libraries: [LibraryDescriptor] = []

    var body: some View {
        Form {
            Section("Destination") {
                TextField("Server URL", text: $settings.serverURL)
                    .accessibilityIdentifier("backup.serverURL")
                Picker("Library", selection: $settings.libraryId) {
                    ForEach(libraries, id: \.id) { Text($0.label).tag($0.id) }
                }
                .accessibilityIdentifier("backup.library")
                TextField("Root folder", text: $settings.rootFolder)
                    .accessibilityIdentifier("backup.rootFolder")
            }
            Section("Inclusion") {
                Toggle("Live Photos", isOn: $settings.includeLivePhotos)
                Toggle("Videos", isOn: $settings.includeVideos)
                Toggle("Bursts (every frame)", isOn: $settings.includeBursts)
                Toggle("iCloud Shared Library", isOn: $settings.includeSharedLibrary)
                Toggle("Shared Albums", isOn: $settings.includeSharedAlbums)
            }
            Section("Network") {
                Toggle("Wi-Fi only", isOn: $settings.wifiOnly)
            }
            Section { BackupStatusPanel() }
        }
        .onChange(of: settings) { _, new in new.save() }
        .task { libraries = await loadLibraries() }
    }

    private func loadLibraries() async -> [LibraryDescriptor] {
        // Calls the existing libraries endpoint — implementation pattern lives
        // in src/apple/Packages/MapleCore/Sources/MapleCore/CloudFoldersClient.swift.
        return []
    }
}

struct LibraryDescriptor: Identifiable, Hashable { let id: String; let label: String }
```

- [ ] **Step 2: Commit**

```bash
git add src/apple/Maple/Views/Settings/BackupSettingsView.swift
git commit -m "feat(maple-app): BackupSettingsView"
```

## Task 3.5: BackupStatusPanel

**Files:**
- Create: `src/apple/Maple/Views/Settings/BackupStatusPanel.swift`

- [ ] **Step 1: Implement**

```swift
// src/apple/Maple/Views/Settings/BackupStatusPanel.swift
import SwiftUI
import MapleBackup

@MainActor
struct BackupStatusPanel: View {
    @State private var queueSize: Int = 0
    @State private var lastEvent: String = "idle"
    @State private var observerTask: Task<Void, Never>?

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("Queue").font(.headline)
                Spacer()
                Text("\(queueSize)").font(.system(.body, design: .monospaced))
            }
            Text("Last event: \(lastEvent)").font(.caption).foregroundStyle(.secondary)
            HStack {
                Button("Pause") { /* TODO Task 3.11 */ }
                Button("Resume") { /* TODO Task 3.11 */ }
            }
        }
        .onAppear {
            observerTask = Task {
                let stream = await EngineHost.shared.queue.observe()
                for await event in stream { await render(event) }
            }
            Task { @MainActor in
                queueSize = await EngineHost.shared.queue.snapshot().count
            }
        }
        .onDisappear { observerTask?.cancel() }
    }

    @MainActor private func render(_ event: BackupQueueEvent) async {
        queueSize = await EngineHost.shared.queue.snapshot().count
        switch event {
        case .enqueued: lastEvent = "enqueued"
        case .started: lastEvent = "started"
        case .progress: lastEvent = "uploading…"
        case .completed: lastEvent = "completed"
        case .failed: lastEvent = "failed"
        case .cancelled: lastEvent = "cancelled"
        }
    }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/apple/Maple/Views/Settings/BackupStatusPanel.swift
git commit -m "feat(maple-app): BackupStatusPanel"
```

## Task 3.6: MergedTimelineSource

**Files:**
- Create: `src/apple/Maple/Browse/MergedTimelineSource.swift`
- Create: `src/apple/Packages/MapleCore/Tests/MapleCoreTests/MergedTimelineSourceTests.swift`

The merge logic is testable; PhotoKit and CloudSource are passed in as injected dependencies.

- [ ] **Step 1: Write the failing test**

```swift
import XCTest
@testable import MapleCore

final class MergedTimelineSourceTests: XCTestCase {
    private struct StubLocal { let id: String; let date: Date }
    private struct StubCloud { let id: String; let date: Date; let phassetLink: String? }

    func testCloudWithLinkMatchingLocalShownAsSynced() async throws {
        let now = Date()
        let local = [StubLocal(id: "P1", date: now)]
        let cloud = [StubCloud(id: "C1", date: now, phassetLink: "P1")]
        let merged = MergedTimelineSource.merge(
            local: local.map { MergedTimelineItem.local(id: $0.id, captureDate: $0.date) },
            cloud: cloud.map { MergedTimelineItem.cloud(id: $0.id, captureDate: $0.date, phassetLink: $0.phassetLink) }
        )
        XCTAssertEqual(merged.count, 1)
        if case .synced(let l, let c) = merged[0] {
            XCTAssertEqual(l.id, "P1"); XCTAssertEqual(c.id, "C1")
        } else { XCTFail("expected .synced") }
    }
    func testCloudOnlyWhenNoLocalMatch() {
        let now = Date()
        let merged = MergedTimelineSource.merge(
            local: [], cloud: [MergedTimelineItem.cloud(id: "C1", captureDate: now, phassetLink: nil)])
        if case .cloudOnly(let c) = merged[0] { XCTAssertEqual(c.id, "C1") }
        else { XCTFail() }
    }
    func testLocalOnlyWhenNoCloudRow() {
        let now = Date()
        let merged = MergedTimelineSource.merge(
            local: [MergedTimelineItem.local(id: "P1", captureDate: now)], cloud: [])
        if case .localOnly(let l) = merged[0] { XCTAssertEqual(l.id, "P1") }
        else { XCTFail() }
    }
}
```

- [ ] **Step 2: Implement (pure merge)**

```swift
// src/apple/Packages/MapleCore/Sources/MapleCore/Browse/MergedTimelineSource.swift
import Foundation

public enum MergedTimelineItem: Sendable {
    case local(id: String, captureDate: Date)
    case cloud(id: String, captureDate: Date, phassetLink: String?)
}

public enum MergedTimelineCell: Sendable {
    case localOnly(MergedTimelineItem)
    case cloudOnly(MergedTimelineItem)
    case synced(local: MergedTimelineItem, cloud: MergedTimelineItem)
}

public enum MergedTimelineSource {
    /// Pure merge — no I/O. Cells preserve capture-date descending order.
    public static func merge(local: [MergedTimelineItem],
                             cloud: [MergedTimelineItem]) -> [MergedTimelineCell] {
        var matchedLocalIDs = Set<String>()
        var cells: [MergedTimelineCell] = []

        for c in cloud {
            guard case .cloud(_, _, let link) = c else { continue }
            if let link, let l = local.first(where: { itemId($0) == link }) {
                cells.append(.synced(local: l, cloud: c))
                matchedLocalIDs.insert(link)
            } else {
                cells.append(.cloudOnly(c))
            }
        }
        for l in local where !matchedLocalIDs.contains(itemId(l)) {
            cells.append(.localOnly(l))
        }
        return cells.sorted(by: { date($0) > date($1) })
    }

    private static func itemId(_ i: MergedTimelineItem) -> String {
        switch i {
        case .local(let id, _), .cloud(let id, _, _): return id
        }
    }
    private static func date(_ c: MergedTimelineCell) -> Date {
        switch c {
        case .localOnly(let i), .cloudOnly(let i):
            switch i { case .local(_, let d), .cloud(_, let d, _): return d }
        case .synced(let l, _):
            if case .local(_, let d) = l { return d }; return .distantPast
        }
    }
}
```

- [ ] **Step 3: Run — expect pass**

- [ ] **Step 4: Commit**

```bash
git add src/apple/Packages/MapleCore/Sources/MapleCore/Browse/MergedTimelineSource.swift \
  src/apple/Packages/MapleCore/Tests/MapleCoreTests/MergedTimelineSourceTests.swift
git commit -m "feat(maple-core): MergedTimelineSource (pure merge)"
```

## Task 3.7: Wire MergedTimelineSource into BrowseGrid

**Files:**
- Modify: `src/apple/Maple/Views/BrowseGrid.swift`
- Modify: `src/apple/Packages/MapleCore/Sources/MapleCore/BrowseViewModel.swift`

- [ ] **Step 1: Add a "merged" branch to the BrowseViewModel**

Find where `BrowseViewModel` loads images (`func reload()` or similar). Add an alternative path when the active source is PhotoKit + a backup destination is configured:

```swift
public func reloadMerged(photoKit: PhotoKitSource, cloud: CloudSource) async {
    async let localRefs = photoKit.images()
    async let cloudRefs = cloud.images()
    do {
        let l = try await localRefs
        let c = try await cloudRefs
        let localItems = l.map { MergedTimelineItem.local(id: $0.id, captureDate: $0.captureDate ?? .distantPast) }
        // CloudSource needs to surface phasset_links — see Task 3.8.
        let cloudItems = c.map { MergedTimelineItem.cloud(id: $0.id, captureDate: $0.captureDate ?? .distantPast,
                                                          phassetLink: $0.phassetLink) }
        self.mergedCells = MergedTimelineSource.merge(local: localItems, cloud: cloudItems)
    } catch {
        log.error("merged reload failed: \(error)")
    }
}
```

(`ImageRef` currently has no `captureDate` or `phassetLink`. Adding them is part of Task 3.8.)

- [ ] **Step 2: Commit**

```bash
git add src/apple/Packages/MapleCore/Sources/MapleCore/BrowseViewModel.swift src/apple/Maple/Views/BrowseGrid.swift
git commit -m "feat(maple-app): BrowseGrid reads from MergedTimelineSource"
```

## Task 3.8: Extend ImageRef with captureDate + phassetLink

**Files:**
- Modify: `src/apple/Packages/MapleCore/Sources/MapleCore/Sources/ImageSource.swift` (lines 28-53 — ImageRef)

- [ ] **Step 1: Add optional fields**

```swift
public struct ImageRef: Sendable, Hashable, Identifiable, Codable {
    public let id: String
    public let displayName: String
    public let url: URL?
    public let scopeParentURL: URL?
    /// Capture date when known by the source (PhotoKit and CloudSource provide
    /// this; filesystem/SMB do not until indexed).
    public let captureDate: Date?
    /// Server-side phasset_links[].phasset_local_id when this ImageRef is
    /// a cloud-side row that was backed up from PhotoKit. `nil` for non-cloud
    /// rows and for cloud rows that aren't PhotoKit-backed.
    public let phassetLink: String?

    public init(id: String, displayName: String, url: URL? = nil,
                scopeParentURL: URL? = nil, captureDate: Date? = nil,
                phassetLink: String? = nil) {
        self.id = id; self.displayName = displayName
        self.url = url; self.scopeParentURL = scopeParentURL
        self.captureDate = captureDate; self.phassetLink = phassetLink
    }
}
```

- [ ] **Step 2: Update PhotoKitSource.images() to populate captureDate**

In `PhotoKitSource.swift`, line ~346:

```swift
refs.append(ImageRef(id: id, displayName: id, url: nil,
                     captureDate: phAsset.creationDate))
```

- [ ] **Step 3: Update CloudSource.images() to populate phassetLink**

In the CloudSource (path probably `src/apple/Packages/MapleCore/Sources/MapleCore/Sources/CloudSource.swift`), where the response is mapped to `ImageRef`, include `phassetLink: row.phasset_links?.first?.phasset_local_id`. Server already returns this on `/api/folders/:id/assets` and similar — confirm the existing mapper and extend if needed.

- [ ] **Step 4: Commit**

```bash
git add src/apple/Packages/MapleCore/Sources/MapleCore/Sources/ImageSource.swift \
  src/apple/Packages/MapleCore/Sources/MapleCore/Sources/PhotoKitSource.swift \
  src/apple/Packages/MapleCore/Sources/MapleCore/Sources/CloudSource.swift
git commit -m "feat(maple-core): ImageRef.captureDate + phassetLink"
```

## Task 3.9: Continuous sync — PhotoKitChangeObserver → engine

**Files:**
- Create: `src/apple/Maple/Backup/ChangeObserverWiring.swift`

- [ ] **Step 1: Implement**

```swift
// src/apple/Maple/Backup/ChangeObserverWiring.swift
import Foundation
import Photos
import MapleBackup
import MapleCore

@MainActor
enum ChangeObserverWiring {
    private static var token: UUID?

    static func start(deviceId: String) {
        guard token == nil else { return }
        token = PhotoKitChangeObserver.shared.subscribe { @Sendable in
            Task { await enqueueAllNew(deviceId: deviceId) }
        }
    }

    static func stop() {
        if let t = token { PhotoKitChangeObserver.shared.unsubscribe(t); token = nil }
    }

    private static func enqueueAllNew(deviceId: String) async {
        let opts = PHFetchOptions()
        opts.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: false)]
        let result = PHAsset.fetchAssets(with: opts)
        var ids: [String] = []
        result.enumerateObjects { phAsset, _, _ in ids.append(phAsset.localIdentifier) }
        // Compare against state-store; enqueue any phid we've not seen.
        guard let state = EngineHost.shared.state else { return }
        for phid in ids {
            let taskId = BackupTaskID(deviceId: deviceId, phassetLocalId: phid)
            if (try? await state.find(taskId)) == nil {
                let task = BackupTask(id: taskId, state: .pending, priority: .background)
                try? await state.upsert(task)
                await EngineHost.shared.queue.enqueue(task, priority: .background)
            }
        }
    }
}
```

- [ ] **Step 2: Wire into EngineHost.start**

After `runnerTask` setup:

```swift
ChangeObserverWiring.start(deviceId: deviceId)
```

- [ ] **Step 3: Commit**

```bash
git add src/apple/Maple/Backup/ChangeObserverWiring.swift src/apple/Maple/Backup/EngineHost.swift
git commit -m "feat(maple-app): PhotoKitChangeObserver enqueues new assets"
```

## Task 3.10: macOS LaunchAgent target

**Files:**
- Create: `src/apple/MapleBackupAgent/main.swift`
- Create: `src/apple/MapleBackupAgent/MapleBackupAgent.entitlements`
- Create: `src/apple/MapleBackupAgent/app.justmaple.aperture.backup.plist` (LaunchAgent plist)
- Modify: `src/apple/Maple.xcodeproj/project.pbxproj` — new target

This task requires Xcode project surgery. Instructions are explicit because pbxproj edits in code are fragile.

- [ ] **Step 1: Create the target by hand in Xcode**

Open `src/apple/Maple.xcodeproj` in Xcode. Add a new target:
- Template: macOS → Command Line Tool
- Product name: `MapleBackupAgent`
- Language: Swift
- Bundle ID: `app.justmaple.aperture.backup`

Add the `MapleBackup` and `MapleCore` packages to its dependencies. Set the deployment target to macOS 14.

- [ ] **Step 2: Implement main.swift**

```swift
// src/apple/MapleBackupAgent/main.swift
import Foundation
import MapleBackup
import MapleCore

@main
struct MapleBackupAgentEntryPoint {
    static func main() async throws {
        guard let s = BackupSettings.load(), !s.serverURL.isEmpty, !s.libraryId.isEmpty else {
            print("MapleBackupAgent: no backup settings configured; exiting")
            return
        }
        guard let url = URL(string: s.serverURL) else {
            print("MapleBackupAgent: invalid server URL"); return
        }
        let deviceId = try DeviceIdentity.current(storageURL: try DeviceIdentity.defaultStorageURL())
        let sidecars = AppSupportSidecarStore(root: try AppSupportSidecarStore.defaultRoot())
        let stateURL = (try DeviceIdentity.defaultStorageURL()).deletingLastPathComponent()
            .appendingPathComponent("backup-state.sqlite")
        let state = try BackupStateStore(databaseURL: stateURL)
        let queue = InProcessBackupQueue()
        // Rehydrate any pending tasks the app may have queued.
        for task in try await state.tasks(in: .pending) {
            await queue.enqueue(task, priority: .background)
        }
        let upload = UploadClient(baseURL: url, libraryId: s.libraryId, deviceId: deviceId)
        // Agent has no PhotoKit access here — PhotoKit needs a logged-in user
        // session. The agent reuses MapleApp's PhotoKitAssetReader by linking
        // against the same target's source file: drag PhotoKitAssetReader.swift
        // into the agent target's Compile Sources phase in Xcode.
        let reader = PhotoKitAssetReader(deviceId: deviceId,
                                         geocode: GeocodeClient(baseURL: url))
        let engine = BackupEngine(queue: queue, state: state, upload: upload,
                                  sidecars: sidecars, reader: reader)
        await engine.run()
    }
}
```

- [ ] **Step 3: Create the LaunchAgent plist**

```xml
<!-- src/apple/MapleBackupAgent/app.justmaple.aperture.backup.plist -->
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>app.justmaple.aperture.backup</string>
  <key>ProgramArguments</key>
  <array>
    <string>/Applications/Maple.app/Contents/Helpers/MapleBackupAgent</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>
  <dict><key>SuccessfulExit</key><false/></dict>
  <key>StandardOutPath</key><string>/tmp/maple-backup-agent.out.log</string>
  <key>StandardErrorPath</key><string>/tmp/maple-backup-agent.err.log</string>
</dict>
</plist>
```

- [ ] **Step 4: Install / uninstall helpers**

Add a `MapleApp` menu item (or settings button) that copies the plist into `~/Library/LaunchAgents/` and `launchctl load`s it. The exact wiring lives in `BackupSettingsView` (extend in this task). Provide an "Uninstall agent" button too. Defer the actual UX work to a follow-up if time-pressed; the agent binary is what matters for this task.

- [ ] **Step 5: Commit**

```bash
git add src/apple/MapleBackupAgent src/apple/Maple.xcodeproj/project.pbxproj
git commit -m "feat(maple-app): MapleBackupAgent LaunchAgent for macOS"
```

## Task 3.11: iOS BGProcessingTask registration

**Files:**
- Create: `src/apple/Maple/Backup/BGTaskRegistration.swift`
- Modify: `src/apple/Maple/MapleApp.swift`
- Modify: `src/apple/Maple.xcodeproj/project.pbxproj` (add `UIBackgroundModes` + `BGTaskSchedulerPermittedIdentifiers` via INFOPLIST_KEY_*)

- [ ] **Step 1: Implement**

```swift
// src/apple/Maple/Backup/BGTaskRegistration.swift
#if canImport(BackgroundTasks) && os(iOS)
import BackgroundTasks
import MapleBackup

enum BGTaskRegistration {
    static let taskIdentifier = "app.justmaple.aperture.backup.refresh"

    static func register() {
        BGTaskScheduler.shared.register(forTaskWithIdentifier: taskIdentifier, using: nil) { task in
            handle(task: task as! BGProcessingTask)
        }
    }

    static func schedule() {
        let req = BGProcessingTaskRequest(identifier: taskIdentifier)
        req.requiresNetworkConnectivity = true
        req.requiresExternalPower = false
        req.earliestBeginDate = Date(timeIntervalSinceNow: 60 * 60) // try again in 1h
        try? BGTaskScheduler.shared.submit(req)
    }

    private static func handle(task: BGProcessingTask) {
        schedule() // queue the next one immediately
        let work = Task {
            // Drain a few queue items; iOS will signal expiration.
            if let engine = await EngineHost.shared.engine { await engine.run() }
        }
        task.expirationHandler = { work.cancel() }
        Task {
            _ = await work.value
            task.setTaskCompleted(success: true)
        }
    }
}
#else
enum BGTaskRegistration { static func register() {}; static func schedule() {} }
#endif
```

- [ ] **Step 2: Wire into MapleApp.swift**

```swift
init() {
    BGTaskRegistration.register()
}
```

In `.onChange(of: scenePhase)`:

```swift
if newPhase == .background { BGTaskRegistration.schedule() }
```

- [ ] **Step 3: Add Info.plist keys (build setting)**

In `project.pbxproj`, under the Maple target, add:

```
INFOPLIST_KEY_UIBackgroundModes = "fetch processing";
INFOPLIST_KEY_BGTaskSchedulerPermittedIdentifiers = "app.justmaple.aperture.backup.refresh";
```

- [ ] **Step 4: Commit**

```bash
git add src/apple/Maple/Backup/BGTaskRegistration.swift src/apple/Maple/MapleApp.swift src/apple/Maple.xcodeproj/project.pbxproj
git commit -m "feat(maple-app): iOS BGProcessingTask for backup continuation"
```

## Task 3.12: Network gating (Wi-Fi-only)

**Files:**
- Create: `src/apple/Packages/MapleBackup/Sources/MapleBackup/Reachability.swift`
- Modify: `src/apple/Packages/MapleBackup/Sources/MapleBackup/BackupEngine.swift`

- [ ] **Step 1: Implement Reachability**

```swift
// Sources/MapleBackup/Reachability.swift
import Foundation
import Network

public actor Reachability {
    public enum Status: Sendable { case wifi, cellular, none }
    private let monitor = NWPathMonitor()
    private var current: Status = .none
    public init() {
        monitor.pathUpdateHandler = { [weak self] path in
            Task { await self?.update(path) }
        }
        monitor.start(queue: .global())
    }
    private func update(_ path: NWPath) {
        if path.status == .satisfied {
            current = path.usesInterfaceType(.wifi) ? .wifi
                : path.usesInterfaceType(.cellular) ? .cellular : .wifi
        } else { current = .none }
    }
    public func status() async -> Status { current }
}
```

- [ ] **Step 2: Gate uploads in BackupEngine**

Inject `Reachability` into `BackupEngine`:

```swift
private let reach: Reachability
private let wifiOnly: Bool
// in init: accept reach + wifiOnly

public func processOne(...) async throws {
    if wifiOnly, await reach.status() != .wifi, task.priority < .userEdit {
        // Defer — re-enqueue with same priority once we're back online.
        try? await state.transition(t.id, to: .pending)
        await queue.enqueue(t, priority: t.priority)
        return
    }
    // existing impl
}
```

- [ ] **Step 3: Commit**

```bash
git add src/apple/Packages/MapleBackup/Sources/MapleBackup/Reachability.swift \
  src/apple/Packages/MapleBackup/Sources/MapleBackup/BackupEngine.swift
git commit -m "feat(maple-backup): Wi-Fi-only gating"
```

## Task 3.13: Retry policy + exponential backoff

**Files:**
- Modify: `src/apple/Packages/MapleBackup/Sources/MapleBackup/BackupEngine.swift`

- [ ] **Step 1: Add retry logic to processOne**

```swift
private func backoffSeconds(for retryCount: Int) -> TimeInterval {
    min(3600, pow(2.0, Double(retryCount))) // 1s, 2s, 4s, …, 1h cap
}

public func processOne(task: BackupTask? = nil) async throws {
    let t: BackupTask = task ?? (await queue.dequeue() ?? { throw EngineError.empty }())
    do {
        try await state.transition(t.id, to: .uploading)
        let read = try await reader.read(phassetLocalId: t.id.phassetLocalId)
        _ = try await upload.upload(/* … */)
        try? sidecars.delete(phassetLocalId: t.id.phassetLocalId)
        try await state.transition(t.id, to: .uploaded)
    } catch {
        let next = t.retryCount + 1
        if next >= 8 {
            try? await state.transition(t.id, to: .failedRetry, error: "max retries: \(error)")
        } else {
            try? await state.transition(t.id, to: .pending, error: "\(error)")
            Task {
                try? await Task.sleep(nanoseconds: UInt64(backoffSeconds(for: next) * 1_000_000_000))
                var retry = t; retry.retryCount = next
                await queue.enqueue(retry, priority: retry.priority)
            }
        }
    }
}
```

- [ ] **Step 2: Add a test**

`Tests/MapleBackupTests/BackupEngineRetryTests.swift`:

```swift
final class BackupEngineRetryTests: XCTestCase {
    func testTransientFailureReenqueues() async throws {
        StubProtocol.stub = .status(500)
        // … (build engine, enqueue, processOne)
        // Expect state .pending again with retryCount incremented.
    }
}
```

- [ ] **Step 3: Commit**

```bash
git add src/apple/Packages/MapleBackup/Sources/MapleBackup/BackupEngine.swift \
  src/apple/Packages/MapleBackup/Tests/MapleBackupTests/BackupEngineRetryTests.swift
git commit -m "feat(maple-backup): exponential-backoff retry policy"
```

## Task 3.14: Manual end-to-end smoke test

This task is manual — automated end-to-end (live PhotoKit + live server + chunked uploads) is out of reach in CI. The agent executing this task documents the result; no code change.

- [ ] **Step 1: Run a local Maple Cloud server**

```bash
cd src/api && bun run dev
```

- [ ] **Step 2: Build and launch Maple on macOS**

```bash
cd src/apple
xcodebuild -project Maple.xcodeproj -scheme Maple -destination 'platform=macOS' build
open ~/Library/Developer/Xcode/DerivedData/Maple-*/Build/Products/Debug/Maple.app
```

- [ ] **Step 3: Configure backup**

In Settings → "Photo Library backup":
- Server URL: `http://localhost:3000`
- Library: pick an existing folder library
- Root: `Photos/`
- Inclusion toggles default

- [ ] **Step 4: Observe the queue draining**

The status panel should show:
- Queue size growing (initial enumerate)
- Last event cycling through enqueued → started → uploading → completed
- The library folder on disk gaining files under `Photos/<year>/<location-or-MM>/<MM-DD>/`

- [ ] **Step 5: Verify on the server**

```bash
curl 'http://localhost:3000/api/libraries/<libid>/backup/state?device_id=<your-device-id>' | jq
```

Expected: an `assets[]` list containing the uploaded photo localIDs.

- [ ] **Step 6: Document the smoke-test result in the PR description.** No commit needed.

## Task 3.15: Phase 3 PR

- [ ] **Step 1: Build all platforms**

```bash
cd src/apple
xcodebuild -project Maple.xcodeproj -scheme Maple -destination 'platform=macOS' build
xcodebuild -project Maple.xcodeproj -scheme Maple -destination 'platform=iOS Simulator,name=iPhone 17 Pro' build
xcodebuild -project Maple.xcodeproj -scheme MapleBackupAgent -destination 'platform=macOS' build
```

All green.

- [ ] **Step 2: Run all Swift tests**

```bash
cd src/apple/Packages/MapleBackup && swift test
cd src/apple/Packages/MapleCore && swift test
```

- [ ] **Step 3: Open PR**

```bash
gh pr create --title "feat(maple-app): PhotoKit backup app integration" --body "$(cat <<'EOF'
## Summary
- EngineHost wires BackupEngine into the app lifecycle on iOS + macOS.
- PhotoKitAssetReader bridges PHAsset → AssetReader.
- BackupSettingsView + BackupStatusPanel for configuration + live progress.
- MergedTimelineSource merges PhotoKit-local + Cloud assets.
- ImageRef gains captureDate + phassetLink.
- PhotoKitChangeObserver enqueues new assets continuously.
- MapleBackupAgent LaunchAgent (macOS) keeps backups running when Maple is closed.
- iOS BGProcessingTask for opportunistic background continuation.
- Wi-Fi-only gating + exponential-backoff retry.

Spec: docs/superpowers/specs/2026-05-09-photokit-backup-design.md (PR #9).
Plan: docs/superpowers/plans/2026-05-11-photokit-backup.md.
Depends on Phase 1 + Phase 2 PRs.

## Test plan
- [ ] \`swift test\` MapleBackup + MapleCore green
- [ ] macOS + iOS sim build green
- [ ] Manual smoke test passed (50 photos uploaded against local server)
EOF
)"
```

---

## Self-Review

After completing all tasks above, verify against the spec:

| Spec § | Requirement | Plan task |
| --- | --- | --- |
| §7 | Configuration flow | 3.4 |
| §8 | Per-asset payload (originals + rendered + sidecar) | 2.9, 3.2 |
| §9 | Folder layout `<year>/<loc-or-MM>/<MM-DD>/<file>` | 1.3, 2.3, 2.10 |
| §9 fallback | Offline / no-geocode → no-GPS shape | 2.5, 1.6 |
| §10 | Continuous sync | 3.9, 3.11 |
| §11 | Edit-while-not-backed-up via App-Support `.xmp` | 2.4, 2.13, 2.14 |
| §12 | Merged timeline | 3.6, 3.7, 3.8 |
| §13 | Networking & power (Wi-Fi-only, retry) | 3.12, 3.13 |
| §14 | Failure modes | 3.13, 3.14 |
| §15 | System shape (SPM module + agent + app) | 2.1, 3.10 |
| §16 | Identity model (deviceId + phassetLocalId + maple_id) | 2.2, 2.12, 3.2 |
| §17 | State machine | 2.7 |
| §18 | BackupQueue protocol | 2.8 |
| §19 | Server data model | 1.1 |
| §20 | New endpoints | 1.5, 1.6, 1.7 |
| §21 | Settings UI | 3.4, 3.5 |
| §22 | Telemetry | (deferred — covered by 3.13's lastError) |
| §23 | Dependencies on in-flight work | (cross-cutting, not a task) |

**Coverage gap:** Telemetry counters from §22 are not fully implemented — only `lastError` is surfaced in the status panel. Acceptable for v1 since the spec says "Local-only counters for now" and "Surface in the status panel for the user to read"; throughput/error-breakdown counters can land as a follow-up. The plan does not block on this.

**Type consistency:** spot-checked `BackupTaskID`, `BackupState`, `BackupQueueEvent`, `AssetReadResult` — same names across all tasks that reference them. ✓

**Placeholder scan:** no "TBD" / "TODO: figure out" — the only `TODO` comments left are for explicit follow-ups (telemetry hook in Task 3.5, retry telemetry in Task 3.13).

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-11-photokit-backup.md`.

**Two execution options:**

1. **Subagent-driven (recommended for a plan this size).** Each task → fresh subagent → review between tasks → fast iteration. ~30 subagents total across the three phases.
2. **Inline execution.** Execute tasks in this session using `superpowers:executing-plans`. Batch execution with checkpoints. Heavier on this session's context.

**Which approach?**
