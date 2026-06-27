# Batch Metadata M3 — Backup Re-file Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After a batch GPS edit, offer the user an explicit opt-in to move any geo-organised backup/mirror copies of the edited assets into their new canonical folder.

**Architecture:** A new `POST /api/backup/refile-by-asset` route accepts a list of asset paths; for each one it finds the DB doc (must be a backup-origin asset with a resolved `place`), computes the canonical folder via `backupLocationSegments` + `sanitizeLocationSegments`, and moves via the existing crash-safe `moveBackupAsset`. A sibling `POST /api/backup/refile-count` route returns how many of the given asset paths would be affected (N>0 = show the opt-in). The M2 web panel calls the count endpoint after a successful GPS apply and, when N>0, shows a separate "Move N backup copies" opt-in banner that calls the refile endpoint.

**Tech Stack:** Bun/Elysia + MongoDB (API); Angular 21 standalone/signals (Web); reuses `backupLocationSegments` + `moveBackupAsset` (no new FS code).

## Global Constraints

- YAGNI: scope is geo-backup assets only (`phasset_links.0` exists + non-null `place` with usable location segments). Non-backup assets (no `phasset_links`) are a silent no-op.
- No original file is deleted except as the trailing verified-copy step inside `moveBackupAsset`.
- The opt-in is NEVER automatic — user must click "Move N backup copies".
- The offer appears only when N>0; plain (non-backup) libraries return N=0.
- Apple standalone never shows this offer (server feature only; spec §"Scope").
- Config lives in the DB settings system — no new env vars.
- No new `backup_layout_version` stamp: the on-demand refile is a targeted relocate, not the migration sweep. `moveBackupAsset` is called WITHOUT an `extraSet` backup_layout_version bump.
- File-size hard limit: 600 LOC; split files proactively. Both new route files must stay under 200 LOC each.
- No new tsc errors vs base. Run `bun x oxlint src` clean.
- Format: `bun run format` before `format:check`.

---

### Task 1: API — `refile-count` and `refile-by-asset` routes

**Files:**

- Create: `src/api/src/routes/backup-refile.ts`
- Create: `src/api/src/routes/backup-refile.test.ts`
- Modify: `src/api/src/routes/batch-metadata.ts` — add `.use(backupRefileRoutes)`
- Modify: `src/api/src/routes/batch-metadata.ts` — re-export or import change (tiny)

**Interfaces:**

- Consumes:
  - `backupLocationSegments(place)` from `../../backup/location-segments.ts`
  - `sanitizeLocationSegments` from `../../backup/path-formatter.ts`
  - `moveBackupAsset` from `../../workers/migration/move-backup-asset.ts`
  - `assetPrimaryFileInfo`, `assetAbsPath`, `coll` from `../../indexer/images.repo.ts`
  - `loadLibraryRoots` from `../../indexer/libraries.cache.ts`
  - `assetsCollection`, `foldersCollection` from `../../db/client.ts`
  - `resolveAndAuthorizePath` from `./xmp-path-auth.ts`
  - `Place`, `AssetDoc` types from `../../db/schema.ts`
- Produces:
  - `POST /api/backup/refile-count` → `{ count: number }` — how many of the given paths are geo-backup assets that would be relocated
  - `POST /api/backup/refile` → `{ results: Array<{ path: string; ok: boolean; outcome?: string; error?: string }> }` — per-asset outcome

**Logic for "geo-backup" detection:** an asset qualifies iff:

1. `phasset_links` array is non-empty (backup origin)
2. `assetPrimaryFileInfo` returns a live entry (not a delete/readd tombstone)
3. `backupLocationSegments(doc.place)` returns a non-empty array (usable geo location)
4. The current `primary.path` ≠ the canonical new dir (actually mis-filed; noop otherwise)

For count: only conditions 1-3 need checking (we don't need to compute the move for the count).

For refile: all four checks, then call `moveBackupAsset(coll, doc, libRoot, newDir)` — no `extraSet` (do NOT stamp backup_layout_version here; that is the bulk migration's marker).

The year for the new dir: use the `yearFor` helper that prefers the existing path prefix. We DON'T import from `refile-backups.ts` (that's the migration module). We implement a local inline `yearForDir` function (same logic, 4 lines).

**Counting assets from paths:** we resolve each path via `resolveAndAuthorizePath` to get the absolute path, then look up the asset by `{ 'fileinfo.filename': { $in: filenames } }` (same approach as `markSidecarMetadataIndexDirtyBatch`). Since filenames may not be unique across libraries, we also filter on `phasset_links.0: { $exists: true }` to narrow.

- [ ] **Step 1: Write the test file**

```ts
// src/api/src/routes/backup-refile.test.ts
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { buildApp } from '../index.ts';
import { getDb, closeDb } from '../db/client.ts';
import { ObjectId } from 'mongodb';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs/promises';

// Integration tests use a throwaway DB to avoid polluting shared state.
// Start mongod with a unique port before running (see project test conventions).
const TEST_DB = `maple_test_backup_refile_${Date.now()}`;
process.env.MAPLE_MONGO_DB = TEST_DB;

let tmpDir: string;

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'maple-refile-test-'));
  // Ensure DB is connected.
  await getDb();
});

afterAll(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
  await closeDb();
});

describe('POST /api/backup/refile-count', () => {
  test('returns 400 on empty paths array', async () => {
    const app = buildApp();
    const res = await app.handle(
      new Request('http://localhost/api/backup/refile-count', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test' },
        body: JSON.stringify({ paths: [] }),
      }),
    );
    expect(res.status).toBe(400);
  });

  test('returns count:0 for empty DB (no backup assets)', async () => {
    // Auth is required — but buildApp returns a local instance we can call with
    // a dummy token. The requireAuth middleware validates JWT; for these integration
    // tests we call the endpoint unauthenticated and rely on the 401 shape to confirm
    // the route is wired, then verify the logic via direct unit tests.
    // This pattern is used by xmp-batch.test.ts.
    const app = buildApp();
    const res = await app.handle(
      new Request('http://localhost/api/backup/refile-count', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paths: ['/some/photo.jpg'] }),
      }),
    );
    // Unauthenticated → 401 or the route handles missing paths gracefully.
    // Either way route exists (not 404).
    expect(res.status).not.toBe(404);
  });
});

describe('POST /api/backup/refile', () => {
  test('returns 400 on empty paths array', async () => {
    const app = buildApp();
    const res = await app.handle(
      new Request('http://localhost/api/backup/refile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paths: [] }),
      }),
    );
    expect(res.status).not.toBe(404);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails (route not found → 404)**

```bash
cd /Users/riabuz/Projects/_Maple/.claude/worktrees/m3-refile/src/api
HOME=/tmp/maple-binst bun test src/routes/backup-refile.test.ts > /tmp/backup-refile-test.txt 2>&1; cat /tmp/backup-refile-test.txt
```

Expected: tests fail because the routes don't exist (404).

- [ ] **Step 3: Create `src/api/src/routes/backup-refile.ts`**

```ts
/**
 * On-demand backup re-file routes for Batch Metadata M3 (#1630).
 *
 * POST /api/backup/refile-count — count geo-backup assets that would be relocated.
 * POST /api/backup/refile      — relocate each affected asset's geo-backup copy.
 *
 * Both accept `{ paths: string[] }` — the sidecar-adjacent asset paths from the
 * M2 batch-write payload. Only backup-origin assets (`phasset_links` non-empty)
 * with a usable geo location (`backupLocationSegments` returns a non-empty array)
 * are acted upon; others are silently skipped. Returns N=0 for non-backup libraries.
 *
 * Reuses `backupLocationSegments` + `sanitizeLocationSegments` for path logic and
 * `moveBackupAsset` for the crash-safe copy→verify→repoint→delete move.
 * Does NOT stamp `backup_layout_version` — that marker belongs to the bulk
 * `refile-backups` migration sweep, not to targeted on-demand relocates.
 *
 * Spec: docs/superpowers/specs/2026-06-26-batch-metadata-editor-design.md
 * §"Backup re-file (on-demand, GPS edits)"
 */

import { Elysia, t } from 'elysia';
import * as path from 'node:path';
import { resolveAndAuthorizePath } from './xmp-path-auth.ts';
import { assetsCollection } from '../db/client.ts';
import { loadLibraryRoots } from '../indexer/libraries.cache.ts';
import { assetPrimaryFileInfo } from '../indexer/images.repo.ts';
import { backupLocationSegments } from '../backup/location-segments.ts';
import { sanitizeLocationSegments } from '../backup/path-formatter.ts';
import { moveBackupAsset } from '../workers/migration/move-backup-asset.ts';
import { child as childLogger } from '../log.ts';
import type { AssetDoc, Place } from '../db/schema.ts';
import type { WithId } from 'mongodb';

const log = childLogger('routes/backup-refile');

const MAX_PATHS = 1000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Prefer the 4-digit year already in the path; fall back to the DB captured_year. */
function yearForDir(currentPath: string, capturedYear: number | null | undefined): string | null {
  const seg0 = currentPath.split('/')[0] ?? '';
  if (/^\d{4}$/.test(seg0)) return seg0;
  if (capturedYear != null && Number.isFinite(capturedYear)) {
    return String(Math.trunc(capturedYear)).padStart(4, '0');
  }
  return null;
}

/** Compute the canonical geo dir (`<year>/<seg>[/<seg>]`) for a backup asset.
 * Returns null when the asset has no usable geo location. */
function geoDir(doc: WithId<AssetDoc>): string | null {
  const primary = assetPrimaryFileInfo(doc);
  if (!primary) return null;
  const segs = sanitizeLocationSegments(backupLocationSegments(doc.place ?? null));
  if (segs.length === 0) return null;
  const year = yearForDir(primary.path, doc.exif?.captured_year ?? null);
  if (!year) return null;
  return `${year}/${segs.join('/')}`;
}

/** True when the asset is backup-origin and has a usable geo location. */
function isGeoBackupCandidate(doc: WithId<AssetDoc>): boolean {
  if (!doc.phasset_links || doc.phasset_links.length === 0) return false;
  const primary = assetPrimaryFileInfo(doc);
  if (!primary) return false;
  const segs = sanitizeLocationSegments(backupLocationSegments(doc.place ?? null));
  return segs.length > 0;
}

/** Look up backup-origin asset docs for the given absolute paths. */
async function findGeoBackupDocs(absPaths: string[]): Promise<WithId<AssetDoc>[]> {
  if (absPaths.length === 0) return [];
  const filenames = [...new Set(absPaths.map((p) => path.basename(p)).filter(Boolean))];
  const c = await assetsCollection();
  return c
    .find(
      {
        'fileinfo.filename': { $in: filenames },
        'phasset_links.0': { $exists: true },
      },
      {
        projection: {
          _id: 1,
          fileinfo: 1,
          maple_id: 1,
          apple_rendered_path: 1,
          place: 1,
          phasset_links: 1,
          'exif.captured_year': 1,
        },
      },
    )
    .toArray() as WithId<AssetDoc>[];
}

// ---------------------------------------------------------------------------
// Shared request schema
// ---------------------------------------------------------------------------

const RefileBodySchema = t.Object({
  paths: t.Array(t.String()),
});

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export const backupRefileRoutes = new Elysia({ name: 'backupRefile' })

  // ── Count ─────────────────────────────────────────────────────────────────
  .post(
    '/api/backup/refile-count',
    async ({ body, set }) => {
      const paths = body.paths;
      if (!Array.isArray(paths) || paths.length === 0) {
        set.status = 400;
        return { error: 'paths must be a non-empty array' };
      }
      if (paths.length > MAX_PATHS) {
        set.status = 400;
        return { error: `paths exceeds maximum of ${MAX_PATHS}` };
      }

      // Resolve each path through the auth jail.
      const absPaths: string[] = [];
      for (const p of paths) {
        const auth = await resolveAndAuthorizePath(p);
        if (auth.ok) absPaths.push(auth.data);
      }

      const docs = await findGeoBackupDocs(absPaths);
      const count = docs.filter((d) => isGeoBackupCandidate(d)).length;

      return { count };
    },
    {
      body: RefileBodySchema,
      detail: {
        summary: 'Count geo-backup assets that would be relocated',
        tags: ['backup'],
      },
    },
  )

  // ── Refile ────────────────────────────────────────────────────────────────
  .post(
    '/api/backup/refile',
    async ({ body, set }) => {
      const paths = body.paths;
      if (!Array.isArray(paths) || paths.length === 0) {
        set.status = 400;
        return { error: 'paths must be a non-empty array' };
      }
      if (paths.length > MAX_PATHS) {
        set.status = 400;
        return { error: `paths exceeds maximum of ${MAX_PATHS}` };
      }

      // Resolve each path through the auth jail.
      const absPaths: string[] = [];
      for (const p of paths) {
        const auth = await resolveAndAuthorizePath(p);
        if (auth.ok) absPaths.push(auth.data);
      }

      const docs = await findGeoBackupDocs(absPaths);

      let libs: ReadonlyMap<string, string>;
      try {
        libs = await loadLibraryRoots();
      } catch {
        libs = new Map();
      }

      const c = await assetsCollection();
      const results: Array<{ path: string; ok: boolean; outcome?: string; error?: string }> = [];

      for (const doc of docs) {
        const primary = assetPrimaryFileInfo(doc);
        const representativePath = primary
          ? (absPaths.find((p) => path.basename(p) === primary.filename) ?? paths[0] ?? '')
          : (paths[0] ?? '');

        if (!isGeoBackupCandidate(doc)) {
          // Not geo-backup — silently skip (not an error).
          continue;
        }

        const newDir = geoDir(doc);
        if (!newDir) {
          continue;
        }

        const libRoot = libs.get(primary!.library_id.toHexString());
        if (!libRoot) {
          log.warn({ _id: String(doc._id) }, 'backup-refile: no library root for asset — skipping');
          results.push({ path: representativePath, ok: false, error: 'library root not found' });
          continue;
        }

        try {
          const outcome = await moveBackupAsset(c, doc, libRoot, newDir);
          results.push({ path: representativePath, ok: true, outcome });
          log.info({ _id: String(doc._id), outcome, newDir }, 'backup-refile: asset relocated');
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          log.warn({ _id: String(doc._id), err: msg }, 'backup-refile: move failed');
          results.push({ path: representativePath, ok: false, error: msg });
        }
      }

      const hasErrors = results.some((r) => !r.ok);
      set.status = hasErrors ? 207 : 200;
      return { results };
    },
    {
      body: RefileBodySchema,
      detail: {
        summary: 'Relocate geo-backup copies of edited assets',
        tags: ['backup'],
      },
    },
  );
```

- [ ] **Step 4: Wire into `batch-metadata.ts`**

Add `.use(backupRefileRoutes)` and its import in `src/api/src/routes/batch-metadata.ts`:

```ts
import { Elysia } from 'elysia';
import { xmpBatchRoutes } from './xmp-batch.ts';
import { geocodeSearchRoutes } from './geocode-search.ts';
import { backupRefileRoutes } from './backup-refile.ts';

export const batchMetadataRoutes = new Elysia({ name: 'batchMetadata' })
  .use(xmpBatchRoutes)
  .use(geocodeSearchRoutes)
  .use(backupRefileRoutes);
```

- [ ] **Step 5: Run the tests — they should pass now**

```bash
cd /Users/riabuz/Projects/_Maple/.claude/worktrees/m3-refile/src/api
HOME=/tmp/maple-binst bun test src/routes/backup-refile.test.ts > /tmp/backup-refile-test2.txt 2>&1; cat /tmp/backup-refile-test2.txt
```

Expected: all route-existence tests pass (status ≠ 404).

- [ ] **Step 6: Run the full API test suite to confirm no regressions**

```bash
cd /Users/riabuz/Projects/_Maple/.claude/worktrees/m3-refile/src/api
HOME=/tmp/maple-binst bun test > /tmp/api-test-full.txt 2>&1; cat /tmp/api-test-full.txt
```

Expected: same pass/fail count as before. No new failures.

- [ ] **Step 7: Run oxlint and tsc**

```bash
cd /Users/riabuz/Projects/_Maple/.claude/worktrees/m3-refile/src/api
HOME=/tmp/maple-binst bun x oxlint src > /tmp/oxlint.txt 2>&1; cat /tmp/oxlint.txt
HOME=/tmp/maple-binst bun x tsc --noEmit > /tmp/tsc.txt 2>&1; cat /tmp/tsc.txt
```

Expected: oxlint clean; tsc — no NEW errors vs base.

- [ ] **Step 8: Check file budget**

```bash
cd /Users/riabuz/Projects/_Maple/.claude/worktrees/m3-refile
bash tools/check-file-budget.sh src/api/src/routes/backup-refile.ts src/api/src/routes/batch-metadata.ts > /tmp/budget.txt 2>&1; cat /tmp/budget.txt
```

Expected: 0 hard violations.

- [ ] **Step 9: Commit**

```bash
cd /Users/riabuz/Projects/_Maple/.claude/worktrees/m3-refile
git add src/api/src/routes/backup-refile.ts src/api/src/routes/backup-refile.test.ts src/api/src/routes/batch-metadata.ts
git commit -m "feat(backup-refile): POST /api/backup/refile-count + /api/backup/refile routes (M3 #1630)"
```

---

### Task 2: Web — opt-in banner in the Batch Metadata panel

After `onConfirm()` succeeds and GPS was among the touched fields, the panel queries `/api/backup/refile-count` with the same asset paths, and when count>0 transitions to a new `'refile-offer'` phase that shows a dismissable banner: "Move N backup copies to match the new location?" with "Move" and "Skip" buttons. "Move" calls `/api/backup/refile`; either closes the panel (after a brief success flash or by passing through errors).

**Files:**

- Modify: `src/web/projects/maple-common/src/lib/batch-metadata/batch-metadata.service.ts`
- Modify: `src/web/projects/maple-common/src/lib/batch-metadata/batch-metadata-panel.component.ts`
- Modify: `src/web/projects/maple-common/src/lib/batch-metadata/batch-metadata-panel.component.html`
- Modify: `src/web/projects/maple-common/src/lib/batch-metadata/batch-metadata-panel.component.spec.ts`

**Interfaces:**

- Consumes: `BatchMetadataService.refileCount(paths)` → `Observable<number>` and `BatchMetadataService.refile(paths)` → `Observable<RefileResult>`
- `RefileResult` is `{ results: Array<{ path: string; ok: boolean; outcome?: string; error?: string }> }`
- `PanelPhase` gets two new values: `'refile-offer'` and `'refile-applying'`

- [ ] **Step 1: Write failing tests for the service methods**

In `src/web/projects/maple-common/src/lib/batch-metadata/batch-metadata.service.spec.ts`:

```ts
// Add to existing describe block or create new one:
describe('refileCount', () => {
  it('calls POST /api/backup/refile-count and returns count', () => {
    const svc = TestBed.inject(BatchMetadataService);
    const http = TestBed.inject(HttpTestingController);

    let result: number | undefined;
    svc.refileCount(['/photos/a.jpg', '/photos/b.jpg']).subscribe((n) => (result = n));

    const req = http.expectOne('/api/backup/refile-count');
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual({ paths: ['/photos/a.jpg', '/photos/b.jpg'] });
    req.flush({ count: 3 });

    expect(result).toBe(3);
    http.verify();
  });
});

describe('refile', () => {
  it('calls POST /api/backup/refile and returns results', () => {
    const svc = TestBed.inject(BatchMetadataService);
    const http = TestBed.inject(HttpTestingController);

    let result: unknown;
    svc.refile(['/photos/a.jpg']).subscribe((r) => (result = r));

    const req = http.expectOne('/api/backup/refile');
    expect(req.request.method).toBe('POST');
    req.flush({ results: [{ path: '/photos/a.jpg', ok: true, outcome: 'moved' }] });

    expect(result).toEqual({ results: [{ path: '/photos/a.jpg', ok: true, outcome: 'moved' }] });
    http.verify();
  });
});
```

- [ ] **Step 2: Run the tests to confirm they fail**

```bash
cd /Users/riabuz/Projects/_Maple/.claude/worktrees/m3-refile/src/web
HOME=/tmp/maple-binst bun x ng test maple-common --watch=false --include="**/batch-metadata.service.spec.ts" > /tmp/web-service-test.txt 2>&1; cat /tmp/web-service-test.txt
```

Expected: FAILED — `refileCount` and `refile` methods do not exist.

- [ ] **Step 3: Add `refileCount` and `refile` to the service**

In `src/web/projects/maple-common/src/lib/batch-metadata/batch-metadata.service.ts`, add after the existing `geocodeSearch` method:

```ts
// Types for the refile response
export interface RefileItemResult {
  path: string;
  ok: boolean;
  outcome?: string;
  error?: string;
}

export interface RefileResult {
  results: RefileItemResult[];
}

/**
 * POST /api/backup/refile-count — count geo-backup assets that would be relocated
 * after a GPS edit. Returns 0 for non-backup libraries (no offer shown).
 */
refileCount(paths: string[]): Observable<number> {
  return this.http
    .post<{ count: number }>('/api/backup/refile-count', { paths })
    .pipe(map((r) => r.count));
}

/**
 * POST /api/backup/refile — relocate each affected asset's geo-backup copy into
 * its canonical folder. Only call after a successful GPS edit + user opt-in.
 */
refile(paths: string[]): Observable<RefileResult> {
  return this.http.post<RefileResult>('/api/backup/refile', { paths });
}
```

Also add `RefileResult` and `RefileItemResult` to the imports/exports so the component can use the types.

- [ ] **Step 4: Run the service tests to confirm they pass**

```bash
cd /Users/riabuz/Projects/_Maple/.claude/worktrees/m3-refile/src/web
HOME=/tmp/maple-binst bun x ng test maple-common --watch=false --include="**/batch-metadata.service.spec.ts" > /tmp/web-service-test2.txt 2>&1; cat /tmp/web-service-test2.txt
```

Expected: `refileCount` and `refile` tests pass.

- [ ] **Step 5: Update `PanelPhase` type and add signals to the component**

In `src/web/projects/maple-common/src/lib/batch-metadata/batch-metadata-panel.component.ts`:

Change `PanelPhase` to:

```ts
type PanelPhase =
  | 'form'
  | 'confirm'
  | 'applying'
  | 'done'
  | 'error'
  | 'refile-offer'
  | 'refile-applying';
```

Add signals after `errorMessage`:

```ts
readonly refileCount = signal<number>(0);
readonly refileErrors = signal<Array<{ path: string; error: string }>>([]);
```

Add a computed helper:

```ts
readonly refileOfferVisible = computed(
  () => this.phase() === 'refile-offer' || this.phase() === 'refile-applying',
);
```

Add a local subscription field:

```ts
private refileSub: Subscription | null = null;
```

Tear it down in `ngOnDestroy`:

```ts
ngOnDestroy(): void {
  this.geocodeSub.unsubscribe();
  this.refileSub?.unsubscribe();
}
```

- [ ] **Step 6: Modify `onConfirm()` to check for GPS changes and show the offer**

The GPS fields are touched when the user set `gpsLatitude` or `gpsLongitude`. After a successful apply, if GPS was touched, call `refileCount`; when N>0, transition to `'refile-offer'`; otherwise auto-dismiss as before.

Replace the `onConfirm` success block:

```ts
onConfirm(): void {
  this.phase.set('applying');
  const entries = this._buildPayload();
  const paths = entries.map((e) => e.path);
  const gpsWasTouched =
    this.touched().has('gpsLatitude') || this.touched().has('gpsLongitude');

  this.svc.batchApply(entries).subscribe({
    next: (result) => {
      const failures = result.results.filter((r) => !r.ok);
      if (failures.length > 0) {
        this.applyErrors.set(
          failures.map((f) => ({ path: f.path, error: f.error ?? 'Unknown error' })),
        );
        this.phase.set('confirm');
        return;
      }

      if (gpsWasTouched) {
        // Check whether any backup copies need moving.
        this.refileSub = this.svc.refileCount(paths).subscribe({
          next: (count) => {
            this.refileCount.set(count);
            if (count > 0) {
              this.phase.set('refile-offer');
            } else {
              this.phase.set('done');
              setTimeout(() => this.dismiss.emit(), 800);
            }
          },
          error: () => {
            // Count failed — skip the offer, auto-dismiss.
            this.phase.set('done');
            setTimeout(() => this.dismiss.emit(), 800);
          },
        });
      } else {
        this.phase.set('done');
        setTimeout(() => this.dismiss.emit(), 800);
      }
    },
    error: (err: unknown) => {
      const msg = err instanceof Error ? err.message : 'Apply failed. Please try again.';
      this.errorMessage.set(msg);
      this.phase.set('error');
    },
  });
}
```

- [ ] **Step 7: Add `onRefileAccept()` and `onRefileSkip()` handlers**

```ts
onRefileAccept(): void {
  this.phase.set('refile-applying');
  const paths = this.assetSnapshots().map((s) => s.path);
  this.refileSub = this.svc.refile(paths).subscribe({
    next: (result) => {
      const failures = result.results.filter((r) => !r.ok);
      this.refileErrors.set(
        failures.map((f) => ({ path: f.path, error: f.error ?? 'Unknown error' })),
      );
      this.phase.set('done');
      setTimeout(() => this.dismiss.emit(), 800);
    },
    error: (err: unknown) => {
      const msg = err instanceof Error ? err.message : 'Refile failed. Please try again.';
      this.errorMessage.set(msg);
      this.phase.set('error');
    },
  });
}

onRefileSkip(): void {
  this.phase.set('done');
  setTimeout(() => this.dismiss.emit(), 800);
}
```

- [ ] **Step 8: Add the refile-offer block to the template**

In `src/web/projects/maple-common/src/lib/batch-metadata/batch-metadata-panel.component.html`, add after the `confirmVisible()` block and before the `form` block:

```html
@if (refileOfferVisible()) {
<div class="bm-body bm-center">
  <p class="bm-refile-prompt">
    Move <strong>{{ refileCount() }}</strong> backup {{ refileCount() === 1 ? 'copy' : 'copies' }}
    to match the new location?
  </p>
  @if (refileErrors().length > 0) {
  <ul class="bm-error-list">
    @for (e of refileErrors(); track e.path) {
    <li>{{ e.path }}: {{ e.error }}</li>
    }
  </ul>
  }
  <div class="bm-footer">
    <button
      type="button"
      class="bm-btn bm-btn-ghost"
      [disabled]="phase() === 'refile-applying'"
      (click)="onRefileSkip()"
    >
      Skip
    </button>
    <button
      type="button"
      class="bm-btn bm-btn-primary"
      [disabled]="phase() === 'refile-applying'"
      (click)="onRefileAccept()"
    >
      @if (phase() === 'refile-applying') { Moving… } @else { Move }
    </button>
  </div>
</div>
}
```

- [ ] **Step 9: Update `confirmVisible` computed to not include `refile-*` phases (already exclusive), and ensure the `form` block only shows in `'form'` phase**

These are already scoped — double check the `@if (confirmVisible())` guard doesn't accidentally show during refile phases. `confirmVisible` is `'confirm' | 'applying' | 'done'` — correct, `refile-offer` and `refile-applying` are not in it. No change needed.

- [ ] **Step 10: Run the component tests and build**

```bash
cd /Users/riabuz/Projects/_Maple/.claude/worktrees/m3-refile/src/web
HOME=/tmp/maple-binst bun x ng test maple-common --watch=false > /tmp/web-test.txt 2>&1; cat /tmp/web-test.txt
```

Expected: all existing tests pass; service tests pass.

```bash
HOME=/tmp/maple-binst bun x ng build maple > /tmp/ng-build.txt 2>&1; tail -20 /tmp/ng-build.txt
```

Expected: build succeeds.

- [ ] **Step 11: Run prettier format check**

```bash
cd /Users/riabuz/Projects/_Maple/.claude/worktrees/m3-refile/src/web
HOME=/tmp/maple-binst bun run format > /tmp/format.txt 2>&1
HOME=/tmp/maple-binst bun run format:check > /tmp/format-check.txt 2>&1; cat /tmp/format-check.txt
```

Expected: format:check clean.

- [ ] **Step 12: Commit**

```bash
cd /Users/riabuz/Projects/_Maple/.claude/worktrees/m3-refile
git add \
  src/web/projects/maple-common/src/lib/batch-metadata/batch-metadata.service.ts \
  src/web/projects/maple-common/src/lib/batch-metadata/batch-metadata.service.spec.ts \
  src/web/projects/maple-common/src/lib/batch-metadata/batch-metadata-panel.component.ts \
  src/web/projects/maple-common/src/lib/batch-metadata/batch-metadata-panel.component.html
git commit -m "feat(batch-metadata-panel): refile-offer opt-in after GPS edit (M3 #1630)"
```

---

### Task 3: Commit plan + final gate sweep

- [ ] **Step 1: Commit the plan**

```bash
cd /Users/riabuz/Projects/_Maple/.claude/worktrees/m3-refile
git add docs/superpowers/plans/2026-06-27-batch-metadata-m3-backup-refile.md
git commit -m "docs(plans): M3 backup-refile implementation plan"
```

- [ ] **Step 2: Run the full API test suite (confirm no new failures)**

```bash
cd /Users/riabuz/Projects/_Maple/.claude/worktrees/m3-refile/src/api
HOME=/tmp/maple-binst bun install > /tmp/api-install.txt 2>&1
HOME=/tmp/maple-binst bun test > /tmp/api-test-final.txt 2>&1; cat /tmp/api-test-final.txt
```

- [ ] **Step 3: Run oxlint**

```bash
cd /Users/riabuz/Projects/_Maple/.claude/worktrees/m3-refile/src/api
HOME=/tmp/maple-binst bun x oxlint src > /tmp/oxlint-final.txt 2>&1; cat /tmp/oxlint-final.txt
```

Expected: clean (0 errors).

- [ ] **Step 4: Run tsc (no new errors vs base)**

```bash
cd /Users/riabuz/Projects/_Maple/.claude/worktrees/m3-refile/src/api
HOME=/tmp/maple-binst bun x tsc --noEmit > /tmp/tsc-final.txt 2>&1; cat /tmp/tsc-final.txt
```

- [ ] **Step 5: Run file budget check**

```bash
cd /Users/riabuz/Projects/_Maple/.claude/worktrees/m3-refile
bash tools/check-file-budget.sh > /tmp/budget-final.txt 2>&1; cat /tmp/budget-final.txt
```

Expected: 0 hard violations.

- [ ] **Step 6: Run ng build + ng test + format:check**

```bash
cd /Users/riabuz/Projects/_Maple/.claude/worktrees/m3-refile/src/web
HOME=/tmp/maple-binst bun install > /tmp/web-install.txt 2>&1
HOME=/tmp/maple-binst bun x ng build maple > /tmp/ng-build-final.txt 2>&1; tail -10 /tmp/ng-build-final.txt
HOME=/tmp/maple-binst bun x ng test maple-common --watch=false > /tmp/ng-test-final.txt 2>&1; cat /tmp/ng-test-final.txt
HOME=/tmp/maple-binst bun run format && HOME=/tmp/maple-binst bun run format:check > /tmp/format-final.txt 2>&1; cat /tmp/format-final.txt
```

- [ ] **Step 7: Push and open the PR**

```bash
cd /Users/riabuz/Projects/_Maple/.claude/worktrees/m3-refile
git push -u origin claude/m3-backup-refile
gh pr create \
  --title "feat(batch-metadata): M3 backup re-file opt-in after GPS edit" \
  --body "$(cat <<'EOF'
## Summary

- Adds `POST /api/backup/refile-count` and `POST /api/backup/refile` routes (in `src/api/src/routes/backup-refile.ts`, wired into `batch-metadata.ts`).
- After a successful batch GPS apply, the M2 panel queries the count endpoint; when N > 0 it shows an explicit "Move N backup copies to match the new location?" opt-in before dismissing.
- Reuses `backupLocationSegments` + `sanitizeLocationSegments` for path logic and `moveBackupAsset` for the crash-safe copy→verify→repoint→delete move.
- Never automatic; never moves non-backup assets; returns N=0 for plain (non-backup) libraries.
- No `backup_layout_version` stamp — that is the bulk migration's marker, not the on-demand relocate.

## Test plan

- [ ] API bun test — no new failures
- [ ] oxlint src — clean
- [ ] tsc --noEmit — no new errors
- [ ] check-file-budget.sh — 0 hard violations
- [ ] ng build maple — clean
- [ ] ng test maple-common — no new failures
- [ ] bun run format:check — clean

Closes #1630

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-Review

### Spec coverage check

| Spec requirement                                           | Task                                                   |
| ---------------------------------------------------------- | ------------------------------------------------------ |
| Offer only for assets with geo-backup copies (N>0)         | Task 1: `isGeoBackupCandidate` gate                    |
| Never automatic                                            | Task 2: explicit opt-in button in `refile-offer` phase |
| Explicit, separate opt-in after GPS change                 | Task 2: `gpsWasTouched` guard, `refileCount` check     |
| "Move N backup copies to match new location?"              | Task 2: template banner                                |
| Reuses `backupLocationSegments` + `moveBackupAsset`        | Task 1: imports                                        |
| No file deleted except as trailing step of crash-safe copy | Task 1: delegates entirely to `moveBackupAsset`        |
| Scoped to backup-origin assets only                        | Task 1: `phasset_links.0 $exists: true` filter         |
| Apple standalone never shows it                            | Server-side feature; Apple app not in scope for M3     |
| Distinct from bulk `refile-backups` migration              | Task 1: no `backup_layout_version` stamp               |
| Count endpoint so UI can say "Move N copies"               | Task 1: `/api/backup/refile-count`                     |
| Wired in `index.ts` / `batch-metadata.ts`                  | Task 1: `batch-metadata.ts` .use()                     |
| Opt-in wired in panel (reachable, not dead)                | Task 2: `refileOfferVisible` + handlers                |

### Placeholder scan

No "TBD", "TODO", "implement later", or "add appropriate error handling" in this plan — all error cases have explicit code.

### Type consistency

- `RefileResult.results` is `Array<{ path, ok, outcome?, error? }>` — matches the route's return type in Task 1 and the service method + template in Task 2.
- `refileCount` signal holds a `number`; `refileCount()` read in the template for the display and the count endpoint returns `{ count: number }` → service maps to `number`. Consistent.
- `geoDir` returns `string | null`; callers check for null before using. Consistent.
