# Derivative-Audit Worker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A background worker that verifies each live asset's thumb/preview/description against disk and its thumbnail against Cloudflare R2, and re-arms the responsible pipeline stage when a derivative has drifted (most often after a file was moved and its `.maple/` cache did not follow).

**Architecture:** An interval-loop worker modeled on `workers/mirror/scan.ts` (NOT a pipeline stage — a stage marks assets "done" and never revisits them, which is exactly the state we must re-check). Each pass sweeps live assets, stats disk (and optionally HEADs R2), and on drift issues the canonical **5-field stage reset** (`stages.<name>.{version:0, attempts:0, last_error:null, processed_at:null, dead:false}`) so the existing `thumb`/`preview`/`describe`/`cf-thumb-sync` stages regenerate. The worker only detects and re-arms — it never renders, encodes, or uploads. A per-asset cooldown (`derivative_audit.<stage>`) plus replicated stage skip-predicates prevent reset loops.

**Tech Stack:** Bun + Elysia + MongoDB (`bun:test`), TypeScript with `.ts` import extensions; `aws4fetch` for R2; Angular 21 standalone + signals for the operator panel.

## Global Constraints

- API tooling gate is `bun test` (run in `src/api`); there is no lint/format step for the API. `tsc` is not clean repo-wide — the bar is "no NEW tsc errors."
- No new env vars: worker config lives in a DB-backed `app_settings` doc, mirroring `cloudflare-config.repo.ts`. (CLAUDE.md.)
- Stage handlers may NOT patch `stages.*`; cross-stage resets are separate `updateOne`/`updateMany` calls (`run-stage.ts` throws on a `stages.`-prefixed patch key). The audit worker is not a stage, but it follows the same reset shape.
- Reset shape is exactly the five fields (`version`, `attempts`, `last_error`, `processed_at`, `dead`) — matching `reArmCacheStages()` in `workers/dedupe.helpers.ts` and `resetCfThumbSyncVersion()` in `stages/thumb.ts`. All five are required (a `dead:true` asset is excluded from the claim query, and a stale `last_error` lingers in Settings → Workers).
- Worker name is `derivative-audit` (not "reconcile" — that term belongs to mirror-reconcile).
- Integration tests use a real throwaway `mongod` on a throwaway port (no sidecar/DB mocks); there is no `timeout` command on this Mac.
- Prettier gate for the web workspace: run the PINNED `./src/web/node_modules/.bin/prettier --write` over changed files (bunx resolves a newer Prettier that formats differently). Check the full PR diff with `main...HEAD`.
- Every PR closes a ticket: this plan closes **#2156**.

## Stage facts referenced throughout (verbatim from the code)

- `thumb`: `targetVersion: 3`, `dependsOn: ['exif']`. Disk path: `resolveThumbPathForAsset(asset, libs)` → `<root>/<fileinfo[0].path>/.maple/thumbs/<maple_id>.avif`. Terminal skips: `stub-file` (`isUndecodableFilename(primary.filename)`), `no-video-decoder` (`isVideoFilename(primary.filename) && !(await ffmpegBinary())`), `no-resolvable-location`. On success calls `resetCfThumbSyncVersion(image._id)`.
- `preview`: `targetVersion: 4`, `dependsOn: ['thumb']`. Disk path: `cachePathForAsset(asset, libs, 'previews', PREVIEW_CACHE_SUFFIX)` → `<root>/<fileinfo[0].path>/.maple/previews/<fileinfo[0].filename>.avif`. Same three terminal skips.
- `describe`: `targetVersion: 7`, `dependsOn: ['preview']`, `pausedOnFirstBoot: true`. Writes `description` = caption. Terminal skips: `stub-file`, `no-resolvable-location`, `preview-missing` (preview AVIF ENOENT).
- `cf-thumb-sync`: `targetVersion: 1`, `dependsOn: [{name:'thumb', minVersion:2}]`, `pausedOnFirstBoot: true`. Uploads `resolveThumbPathForAsset` bytes to R2 at `thumbR2Key({ slug, relDir: primary.path, filename: primary.filename })`, stamps `cf_thumb_synced_at`. Terminal skips: `hidden` (also deletes the R2 copy when `cf_thumb_synced_at` set), `no-resolvable-location`, `no-thumb` (thumb ENOENT). Config: `resolveCloudflareConfig(await loadCloudflareConfig())` + `isCloudflareConfigComplete(config)`.

## Helpers to import (exact origins)

- `assetsCollection` from `../../db/client.ts`; `getDb` from `../../db/client.ts`.
- `liveFileInfoElemMatch`, `assetPrimaryFileInfo`, `assetAbsPath`, `isEnoentError` from `../../indexer/images.repo.ts`.
- `loadLibraryRoots`, `loadLibraryIdToSlug` from `../../indexer/libraries.cache.ts`.
- `resolveThumbPathForAsset`, `cachePathForAsset` from `../../fs/xmp.ts`.
- `PREVIEW_CACHE_SUFFIX` from `../../indexer/previewer.ts`.
- `isUndecodableFilename`, `isVideoFilename` from `../../indexer/media-types.ts`; `ffmpegBinary` from `../../thumbs/video-poster.ts`.
- `thumbR2Key` from `../../cloudflare/thumb-key.ts`.
- `loadCloudflareConfig`, `resolveCloudflareConfig`, `isCloudflareConfigComplete` from `../../cloudflare/cloudflare-config.repo.ts`.
- `statOrNull` from `../mirror/replicate.ts` (stat → `null` on ENOENT, rethrow otherwise).
- `thumbExistsInR2` (added in Task 1) from `../../cloudflare/r2-client.ts`.
- `child as childLogger` from `../../log.ts`.
- Types `ImageDoc`, `StageState` from `../run-stage.ts`; `AssetDoc` from `../../db/schema.ts`.

---

### Task 1: `thumbExistsInR2` — R2 HEAD probe

**Files:**
- Modify: `src/api/src/cloudflare/r2-client.ts` (add one exported function next to `deleteThumbFromR2`)
- Test: `src/api/src/cloudflare/r2-client.test.ts` (create)

**Interfaces:**
- Produces: `export async function thumbExistsInR2(config: ResolvedCloudflareConfig, key: string, signal?: AbortSignal): Promise<boolean>` — `true` on 2xx, `false` on 404, throws on any other non-2xx or network error.

- [ ] **Step 1: Write the failing test.** The R2 client signs with `aws4fetch` and calls `client.fetch`. Stub `globalThis.fetch` so we assert method + return mapping without network. Create `src/api/src/cloudflare/r2-client.test.ts`:

```ts
import { describe, expect, it, afterEach } from 'bun:test';
import { thumbExistsInR2 } from './r2-client.ts';

const CONFIG = {
  account_id: 'acc',
  bucket: 'buck',
  access_key_id: 'ak',
  secret_access_key: 'sk',
};

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('thumbExistsInR2', () => {
  it('returns true on a 200 HEAD', async () => {
    let seenMethod = '';
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      seenMethod = init?.method ?? 'GET';
      return new Response(null, { status: 200 });
    }) as typeof fetch;
    expect(await thumbExistsInR2(CONFIG, 'thumbs/slug/dir/f.avif')).toBe(true);
    expect(seenMethod).toBe('HEAD');
  });

  it('returns false on a 404', async () => {
    globalThis.fetch = (async () => new Response(null, { status: 404 })) as typeof fetch;
    expect(await thumbExistsInR2(CONFIG, 'thumbs/x')).toBe(false);
  });

  it('throws on a 500', async () => {
    globalThis.fetch = (async () => new Response('boom', { status: 500 })) as typeof fetch;
    await expect(thumbExistsInR2(CONFIG, 'thumbs/x')).rejects.toThrow(/R2 head failed \(500\)/);
  });
});
```

- [ ] **Step 2: Run it, verify it fails.** Run: `cd src/api && bun test src/cloudflare/r2-client.test.ts`. Expected: FAIL — `thumbExistsInR2` is not exported.

- [ ] **Step 3: Implement.** Add to `src/api/src/cloudflare/r2-client.ts` after `deleteThumbFromR2`:

```ts
/** HEAD a thumbnail object to check whether it currently exists in R2.
 * `true` on 2xx, `false` on 404 (the object is genuinely absent). Any other
 * non-2xx or a network failure throws — an ambiguous response must not be
 * read as "absent" (which would wrongly re-arm cf-thumb-sync). `signal`
 * bounds the request the same way the upload/delete paths do, since the
 * derivative-audit worker HEADs many objects per pass. */
export async function thumbExistsInR2(
  config: ResolvedCloudflareConfig,
  key: string,
  signal?: AbortSignal,
): Promise<boolean> {
  const client = r2Client(config);
  const res = await client.fetch(r2Endpoint(config, key), { method: 'HEAD', signal });
  if (res.ok) return true;
  if (res.status === 404) return false;
  const body = await res.text().catch(() => '');
  throw new Error(`R2 head failed (${res.status}): ${body.slice(0, 500)}`);
}
```

- [ ] **Step 4: Run test, verify pass.** Run: `cd src/api && bun test src/cloudflare/r2-client.test.ts`. Expected: PASS (3 tests).

- [ ] **Step 5: Commit.**

```bash
git add src/api/src/cloudflare/r2-client.ts src/api/src/cloudflare/r2-client.test.ts
git commit -m "feat(api): add thumbExistsInR2 R2 HEAD probe (#2156)"
```

---

### Task 2: `derivative-audit-config.repo.ts` — DB-backed settings

**Files:**
- Create: `src/api/src/workers/derivative-audit/config.repo.ts`
- Test: `src/api/src/workers/derivative-audit/config.repo.test.ts`

**Interfaces:**
- Produces:
  - `interface DerivativeAuditConfig { enabled: boolean; interval_ms: number; max_resets_per_pass: number; concurrency: number; deep_r2_enabled: boolean; updated_at?: number }`
  - `const DEFAULT_DERIVATIVE_AUDIT_CONFIG: DerivativeAuditConfig` — `{ enabled: true, interval_ms: 21_600_000, max_resets_per_pass: 500, concurrency: 8, deep_r2_enabled: true }`
  - `async function loadDerivativeAuditConfig(): Promise<DerivativeAuditConfig>` — reads the `app_settings` doc `_id:"derivative-audit"`, merged over defaults; returns defaults on any read error.
  - `async function saveDerivativeAuditConfig(patch: Partial<DerivativeAuditConfig>): Promise<void>` — upsert of supplied fields only, stamping `config.updated_at`.

Mirrors `cloudflare-config.repo.ts` exactly (same `app_settings` collection, `{ _id, config }` shape, defaults-merge on read, partial `$set` on save).

- [ ] **Step 1: Write the failing test** (`config.repo.test.ts`). Uses the shared test-mongo harness (see Task 5 for the exact boilerplate; reuse it here):

```ts
import { describe, expect, it, beforeAll, afterAll, beforeEach } from 'bun:test';
import { withTestMongo, type TestMongo } from '../../test-helpers/mongo.ts';
import {
  loadDerivativeAuditConfig,
  saveDerivativeAuditConfig,
  DEFAULT_DERIVATIVE_AUDIT_CONFIG,
} from './config.repo.ts';

let mongo: TestMongo;
beforeAll(async () => { mongo = await withTestMongo(); });
afterAll(async () => { await mongo.stop(); });
beforeEach(async () => { await mongo.db.collection('app_settings').deleteMany({}); });

describe('derivative-audit config repo', () => {
  it('returns defaults when no doc exists', async () => {
    expect(await loadDerivativeAuditConfig()).toMatchObject(DEFAULT_DERIVATIVE_AUDIT_CONFIG);
  });

  it('round-trips a partial patch, leaving other fields at default', async () => {
    await saveDerivativeAuditConfig({ enabled: false, max_resets_per_pass: 25 });
    const cfg = await loadDerivativeAuditConfig();
    expect(cfg.enabled).toBe(false);
    expect(cfg.max_resets_per_pass).toBe(25);
    expect(cfg.deep_r2_enabled).toBe(DEFAULT_DERIVATIVE_AUDIT_CONFIG.deep_r2_enabled);
    expect(cfg.interval_ms).toBe(DEFAULT_DERIVATIVE_AUDIT_CONFIG.interval_ms);
  });
});
```

- [ ] **Step 2: Run it, verify it fails.** Run: `cd src/api && bun test src/workers/derivative-audit/config.repo.test.ts`. Expected: FAIL (module missing). (This depends on Task 5's `test-helpers/mongo.ts`; if executing strictly in order, create that helper first — it is small and listed in Task 5 Step 1.)

- [ ] **Step 3: Implement** `config.repo.ts`:

```ts
/**
 * Persisted config for the derivative-audit worker. A single document in
 * `app_settings` keyed `_id: "derivative-audit"`, mirroring the shape of
 * `cloudflare-config.repo.ts`. Operator-editable at runtime (Settings →
 * Workers), never an env var (CLAUDE.md).
 */
import { getDb } from '../../db/client.ts';

const COLL = 'app_settings';
const DOC_ID = 'derivative-audit';

export interface DerivativeAuditConfig {
  /** Master toggle for the interval loop. */
  enabled: boolean;
  /** Loop cadence in ms. Default 6h — a full-library disk+R2 sweep is cheap
   * per asset but there is no urgency, and a long cadence keeps R2 HEAD
   * volume modest. */
  interval_ms: number;
  /** Runaway guard: stop issuing stage resets after this many in one pass so a
   * mass-drift event can't flood the downstream pipeline. */
  max_resets_per_pass: number;
  /** How many assets are evaluated concurrently (bounds parallel R2 HEADs). */
  concurrency: number;
  /** Whether to HEAD each thumbnail's R2 object to detect bucket-side drift.
   * Auto-skipped when Cloudflare is not fully configured, regardless of this. */
  deep_r2_enabled: boolean;
  updated_at?: number;
}

interface DerivativeAuditConfigDoc {
  _id: string;
  config: DerivativeAuditConfig;
}

export const DEFAULT_DERIVATIVE_AUDIT_CONFIG: DerivativeAuditConfig = {
  enabled: true,
  interval_ms: 21_600_000,
  max_resets_per_pass: 500,
  concurrency: 8,
  deep_r2_enabled: true,
};

export async function loadDerivativeAuditConfig(): Promise<DerivativeAuditConfig> {
  try {
    const db = await getDb();
    const doc = await db.collection<DerivativeAuditConfigDoc>(COLL).findOne({ _id: DOC_ID });
    return { ...DEFAULT_DERIVATIVE_AUDIT_CONFIG, ...(doc?.config ?? {}) };
  } catch {
    return { ...DEFAULT_DERIVATIVE_AUDIT_CONFIG };
  }
}

export async function saveDerivativeAuditConfig(
  patch: Partial<DerivativeAuditConfig>,
): Promise<void> {
  const db = await getDb();
  const set: Record<string, unknown> = { 'config.updated_at': Date.now() };
  for (const k of ['enabled', 'interval_ms', 'max_resets_per_pass', 'concurrency', 'deep_r2_enabled'] as const) {
    if (patch[k] !== undefined) set[`config.${k}`] = patch[k];
  }
  await db
    .collection<DerivativeAuditConfigDoc>(COLL)
    .updateOne({ _id: DOC_ID }, { $set: set }, { upsert: true });
}
```

- [ ] **Step 4: Run test, verify pass.** Run: `cd src/api && bun test src/workers/derivative-audit/config.repo.test.ts`. Expected: PASS (2 tests).

- [ ] **Step 5: Commit.**

```bash
git add src/api/src/workers/derivative-audit/config.repo.ts src/api/src/workers/derivative-audit/config.repo.test.ts
git commit -m "feat(api): DB-backed config for derivative-audit worker (#2156)"
```

---

### Task 3: Schema field + reset/cooldown helper (`reset.ts`)

**Files:**
- Modify: `src/api/src/db/schema.ts` (add one optional field to `AssetDoc`)
- Create: `src/api/src/workers/derivative-audit/reset.ts`
- Test: `src/api/src/workers/derivative-audit/reset.test.ts`

**Interfaces:**
- Produces:
  - Schema: `derivative_audit?: Record<string, DerivativeAuditStageMark> | null` on `AssetDoc`, with `interface DerivativeAuditStageMark { attempts: number; last_reset_at: string }` exported from schema.
  - `const AUDIT_MAX_ATTEMPTS = 3` (cooldown ceiling).
  - `function buildStageReset(stageName: string): Record<string, unknown>` — the 5-field `$set` fragment for one stage.
  - `function auditMarkKey(stageName: string): string` — `` `derivative_audit.${stageName}` ``.

- [ ] **Step 1: Write the failing test** (`reset.test.ts`, pure unit — no Mongo):

```ts
import { describe, expect, it } from 'bun:test';
import { buildStageReset, auditMarkKey, AUDIT_MAX_ATTEMPTS } from './reset.ts';

describe('buildStageReset', () => {
  it('emits exactly the five re-arm fields for the stage', () => {
    expect(buildStageReset('thumb')).toEqual({
      'stages.thumb.version': 0,
      'stages.thumb.attempts': 0,
      'stages.thumb.last_error': null,
      'stages.thumb.processed_at': null,
      'stages.thumb.dead': false,
    });
  });
});

describe('auditMarkKey', () => {
  it('namespaces under derivative_audit', () => {
    expect(auditMarkKey('cf-thumb-sync')).toBe('derivative_audit.cf-thumb-sync');
  });
});

describe('AUDIT_MAX_ATTEMPTS', () => {
  it('is a small positive bound', () => {
    expect(AUDIT_MAX_ATTEMPTS).toBeGreaterThan(0);
    expect(AUDIT_MAX_ATTEMPTS).toBeLessThanOrEqual(5);
  });
});
```

- [ ] **Step 2: Run it, verify it fails.** Run: `cd src/api && bun test src/workers/derivative-audit/reset.test.ts`. Expected: FAIL (module missing).

- [ ] **Step 3a: Implement `reset.ts`:**

```ts
/**
 * The canonical 5-field stage re-arm (matches `reArmCacheStages` in
 * `workers/dedupe.helpers.ts` and `resetCfThumbSyncVersion` in
 * `stages/thumb.ts`) plus the per-asset cooldown key. Kept pure so it unit
 * tests without Mongo; the caller composes these fragments into `$set`.
 */

/** After this many audit re-arms that did NOT resolve the drift, stop
 * re-arming an asset+stage — the stage keeps marking itself done without
 * producing output (an imperfect skip-predicate would otherwise loop). */
export const AUDIT_MAX_ATTEMPTS = 3;

/** `$set` fragment that re-arms one stage (version → 0, clears bookkeeping). */
export function buildStageReset(stageName: string): Record<string, unknown> {
  return {
    [`stages.${stageName}.version`]: 0,
    [`stages.${stageName}.attempts`]: 0,
    [`stages.${stageName}.last_error`]: null,
    [`stages.${stageName}.processed_at`]: null,
    [`stages.${stageName}.dead`]: false,
  };
}

/** Dotted path to this stage's audit cooldown mark on the asset. */
export function auditMarkKey(stageName: string): string {
  return `derivative_audit.${stageName}`;
}
```

- [ ] **Step 3b: Add the schema field.** In `src/api/src/db/schema.ts`, add near the `cf_thumb_synced_at` field of `AssetDoc`:

```ts
  /**
   * Per-stage cooldown bookkeeping written by the derivative-audit worker
   * (`workers/derivative-audit/`). Keyed by pipeline stage name; records how
   * many times the auditor has re-armed that stage for this asset and when,
   * so a stage that keeps marking itself done without producing output isn't
   * re-armed forever. Cleared for a stage once its derivative is verified
   * present again. Absent until the auditor first acts on the asset.
   */
  derivative_audit?: Record<string, DerivativeAuditStageMark> | null;
```

And add the exported interface near `DamagedInfo`:

```ts
/** One stage's derivative-audit cooldown mark (see `AssetDoc.derivative_audit`). */
export interface DerivativeAuditStageMark {
  /** Consecutive audit re-arms that did not resolve the drift. */
  attempts: number;
  /** ISO 8601 timestamp of the most recent re-arm. */
  last_reset_at: string;
}
```

- [ ] **Step 4: Run test + typecheck.** Run: `cd src/api && bun test src/workers/derivative-audit/reset.test.ts`. Expected: PASS (3 tests). Then `cd src/api && bunx tsc --noEmit 2>&1 | grep -c "schema.ts"` — expected `0` (no new errors in the edited file).

- [ ] **Step 5: Commit.**

```bash
git add src/api/src/workers/derivative-audit/reset.ts src/api/src/workers/derivative-audit/reset.test.ts src/api/src/db/schema.ts
git commit -m "feat(api): audit reset helper + derivative_audit cooldown field (#2156)"
```

---

### Task 4: Drift checks (`checks.ts`)

**Files:**
- Create: `src/api/src/workers/derivative-audit/checks.ts`
- Test: `src/api/src/workers/derivative-audit/checks.test.ts`

**Interfaces:**
- Consumes: `statOrNull` (mirror/replicate), the path helpers, `thumbExistsInR2` (Task 1), stage facts.
- Produces:
  - `interface AuditDeps { statOrNull(p: string): Promise<import('node:fs').Stats | null>; ffmpegAvailable(): Promise<boolean>; thumbExistsInR2(key: string): Promise<boolean> | null }` — `thumbExistsInR2` returns `null` when the deep R2 check is disabled/unconfigured (so the check is skipped).
  - `async function evaluateAsset(image: ImageDoc, libs: ReadonlyMap<string,string>, idToSlug: ReadonlyMap<string,string>, deps: AuditDeps): Promise<string[]>` — returns the list of stage names to re-arm (subset of `['thumb','preview','describe','cf-thumb-sync']`). Empty when nothing has drifted. Skips everything (returns `[]`) if the original file is not on disk.

Check logic (each only fires when the stage claims done, i.e. `version >= targetVersion`):
- **original guard:** `assetAbsPath(image, libs)` → if null or `statOrNull` is null, return `[]` (a moved/vanished original is the discover/missing-reaper path, not ours).
- **thumb:** `stages.thumb.version >= 3` AND not `isUndecodableFilename` AND (not video OR ffmpeg available) AND `resolveThumbPathForAsset` resolves AND its `statOrNull` is null → `'thumb'`.
- **preview:** `stages.preview.version >= 4` AND not `isUndecodableFilename` AND (not video OR ffmpeg available) AND `cachePathForAsset(...,'previews',PREVIEW_CACHE_SUFFIX)` resolves AND its `statOrNull` is null → `'preview'`.
- **describe:** `stages.describe.version >= 7` AND `(image.description ?? '').trim() === ''` AND not `isUndecodableFilename` AND the preview file **exists** on disk (so describe can actually run) → `'describe'`.
- **cf-thumb-sync (deep):** `deps.thumbExistsInR2 != null` AND `stages['cf-thumb-sync'].version >= 1` AND `image.hidden !== true` AND thumb file **exists** on disk AND slug resolves AND `await deps.thumbExistsInR2(key) === false` → `'cf-thumb-sync'`.

- [ ] **Step 1: Write the failing test** (`checks.test.ts`, pure — real temp dirs, fake R2 via `deps`). Uses a small `makeAsset` factory and writes/omits files on disk:

```ts
import { describe, expect, it, beforeAll, afterAll } from 'bun:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { stat } from 'node:fs/promises';
import { ObjectId } from 'mongodb';
import { evaluateAsset, type AuditDeps } from './checks.ts';
import type { ImageDoc } from '../run-stage.ts';

const statOrNull = async (p: string) => { try { return await stat(p); } catch { return null; } };
let root: string;
const LIB = new ObjectId();
const libs = new Map<string, string>();
const slugs = new Map<string, string>();

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'audit-checks-'));
  libs.set(LIB.toHexString(), root);
  slugs.set(LIB.toHexString(), 'lib');
});
afterAll(async () => { await rm(root, { recursive: true, force: true }); });

function makeAsset(over: Partial<ImageDoc> = {}): ImageDoc {
  return {
    _id: new ObjectId(),
    maple_id: 'abc123',
    fileinfo: [{ library_id: LIB, path: 'a/b', filename: 'p.dng' }],
    size: 1, mtime: 1, rating: 0, flag: 0, color_label: '', indexed_at: '',
    stages: {
      thumb: { version: 3, attempts: 0, last_error: null, processed_at: null, dead: false },
      preview: { version: 4, attempts: 0, last_error: null, processed_at: null, dead: false },
      describe: { version: 7, attempts: 0, last_error: null, processed_at: null, dead: false },
      'cf-thumb-sync': { version: 1, attempts: 0, last_error: null, processed_at: null, dead: false },
    },
    description: 'a cat',
    ...over,
  } as unknown as ImageDoc;
}

const deps = (over: Partial<AuditDeps> = {}): AuditDeps => ({
  statOrNull,
  ffmpegAvailable: async () => true,
  thumbExistsInR2: null,
  ...over,
});

async function writeOriginal() {
  await mkdir(path.join(root, 'a/b'), { recursive: true });
  await writeFile(path.join(root, 'a/b/p.dng'), 'raw');
}
async function writeThumb() {
  await mkdir(path.join(root, 'a/b/.maple/thumbs'), { recursive: true });
  await writeFile(path.join(root, 'a/b/.maple/thumbs/abc123.avif'), 'thumb');
}
async function writePreview() {
  await mkdir(path.join(root, 'a/b/.maple/previews'), { recursive: true });
  await writeFile(path.join(root, 'a/b/.maple/previews/p.dng.avif'), 'prev');
}

describe('evaluateAsset', () => {
  it('re-arms nothing when the original is missing (leave to discover/reaper)', async () => {
    await rm(path.join(root, 'a/b/p.dng'), { force: true });
    expect(await evaluateAsset(makeAsset(), libs, slugs, deps())).toEqual([]);
  });

  it('re-arms thumb + preview when both derivatives are missing', async () => {
    await writeOriginal();
    await rm(path.join(root, 'a/b/.maple'), { recursive: true, force: true });
    const res = await evaluateAsset(makeAsset(), libs, slugs, deps());
    expect(res.sort()).toEqual(['preview', 'thumb']);
  });

  it('re-arms nothing when both derivatives are present and description set', async () => {
    await writeOriginal(); await writeThumb(); await writePreview();
    expect(await evaluateAsset(makeAsset(), libs, slugs, deps())).toEqual([]);
  });

  it('re-arms describe when description is empty but a preview exists', async () => {
    await writeOriginal(); await writeThumb(); await writePreview();
    const res = await evaluateAsset(makeAsset({ description: '' }), libs, slugs, deps());
    expect(res).toEqual(['describe']);
  });

  it('does NOT re-arm cf-thumb-sync for a hidden asset even if R2 says absent', async () => {
    await writeOriginal(); await writeThumb(); await writePreview();
    const res = await evaluateAsset(
      makeAsset({ hidden: true }), libs, slugs,
      deps({ thumbExistsInR2: async () => false }),
    );
    expect(res).toEqual([]);
  });

  it('re-arms cf-thumb-sync when the thumb exists locally but is absent in R2', async () => {
    await writeOriginal(); await writeThumb(); await writePreview();
    const res = await evaluateAsset(
      makeAsset(), libs, slugs,
      deps({ thumbExistsInR2: async () => false }),
    );
    expect(res).toEqual(['cf-thumb-sync']);
  });

  it('does not re-arm a stage that has not reached its target version', async () => {
    await writeOriginal();
    await rm(path.join(root, 'a/b/.maple'), { recursive: true, force: true });
    const a = makeAsset();
    (a.stages as Record<string, { version: number }>).thumb.version = 0; // still queued
    const res = await evaluateAsset(a, libs, slugs, deps());
    expect(res).toEqual(['preview']); // thumb not re-armed — pipeline owns it
  });
});
```

- [ ] **Step 2: Run it, verify it fails.** Run: `cd src/api && bun test src/workers/derivative-audit/checks.test.ts`. Expected: FAIL (module missing).

- [ ] **Step 3: Implement `checks.ts`:**

```ts
import type { Stats } from 'node:fs';
import type { ImageDoc } from '../run-stage.ts';
import { assetAbsPath, assetPrimaryFileInfo } from '../../indexer/images.repo.ts';
import { resolveThumbPathForAsset, cachePathForAsset } from '../../fs/xmp.ts';
import { PREVIEW_CACHE_SUFFIX } from '../../indexer/previewer.ts';
import { isUndecodableFilename, isVideoFilename } from '../../indexer/media-types.ts';
import { thumbR2Key } from '../../cloudflare/thumb-key.ts';

const THUMB_TARGET = 3;
const PREVIEW_TARGET = 4;
const DESCRIBE_TARGET = 7;
const CF_TARGET = 1;

export interface AuditDeps {
  statOrNull(p: string): Promise<Stats | null>;
  ffmpegAvailable(): Promise<boolean>;
  /** `null` disables the deep R2 check (R2 unconfigured or turned off). */
  thumbExistsInR2: ((key: string) => Promise<boolean>) | null;
}

function stageVersion(image: ImageDoc, name: string): number {
  return image.stages?.[name]?.version ?? 0;
}

/** Would the thumb/preview stages actually produce a file for this asset?
 * Replicates their terminal skips (stub-file, no-video-decoder). */
async function pixelDerivativeExpected(image: ImageDoc, deps: AuditDeps): Promise<boolean> {
  const primary = assetPrimaryFileInfo(image);
  if (!primary) return false;
  if (isUndecodableFilename(primary.filename)) return false;
  if (isVideoFilename(primary.filename) && !(await deps.ffmpegAvailable())) return false;
  return true;
}

export async function evaluateAsset(
  image: ImageDoc,
  libs: ReadonlyMap<string, string>,
  idToSlug: ReadonlyMap<string, string>,
  deps: AuditDeps,
): Promise<string[]> {
  // Original-present guard: a moved/vanished original belongs to discover /
  // missing-reaper. If it isn't on disk right now, re-arming a stage would
  // just make it ENOENT and re-tag missing_since.
  const absPath = assetAbsPath(image, libs);
  if (!absPath || (await deps.statOrNull(absPath)) === null) return [];

  const resets: string[] = [];
  const expectPixels = await pixelDerivativeExpected(image, deps);

  const thumbPath = resolveThumbPathForAsset(image, libs);
  const thumbPresent =
    thumbPath !== null && (await deps.statOrNull(thumbPath)) !== null;
  if (expectPixels && stageVersion(image, 'thumb') >= THUMB_TARGET && thumbPath && !thumbPresent) {
    resets.push('thumb');
  }

  const previewPath = cachePathForAsset(image, libs, 'previews', PREVIEW_CACHE_SUFFIX);
  const previewPresent =
    previewPath !== null && (await deps.statOrNull(previewPath)) !== null;
  if (expectPixels && stageVersion(image, 'preview') >= PREVIEW_TARGET && previewPath && !previewPresent) {
    resets.push('preview');
  }

  // Description is a DB field (survives a move); it only goes "missing" when
  // describe skipped `preview-missing`. Re-arm only when a preview now exists,
  // so the re-run actually captions instead of skipping again.
  if (
    stageVersion(image, 'describe') >= DESCRIBE_TARGET &&
    (image.description ?? '').trim() === '' &&
    (await pixelDerivativeExpected(image, deps)) &&
    previewPresent
  ) {
    resets.push('describe');
  }

  // Deep R2 check: thumb present locally but absent in the bucket. Skip hidden
  // (absence in R2 is correct — cf-thumb-sync tears it down on hide).
  if (
    deps.thumbExistsInR2 !== null &&
    stageVersion(image, 'cf-thumb-sync') >= CF_TARGET &&
    image.hidden !== true &&
    thumbPresent
  ) {
    const primary = assetPrimaryFileInfo(image);
    const slug = primary ? idToSlug.get(primary.library_id.toHexString()) : undefined;
    if (primary && slug) {
      const key = thumbR2Key({ slug, relDir: primary.path, filename: primary.filename });
      if ((await deps.thumbExistsInR2(key)) === false) resets.push('cf-thumb-sync');
    }
  }

  return resets;
}
```

- [ ] **Step 4: Run test, verify pass.** Run: `cd src/api && bun test src/workers/derivative-audit/checks.test.ts`. Expected: PASS (7 tests).

- [ ] **Step 5: Commit.**

```bash
git add src/api/src/workers/derivative-audit/checks.ts src/api/src/workers/derivative-audit/checks.test.ts
git commit -m "feat(api): derivative-audit drift checks (#2156)"
```

---

### Task 5: The audit pass + interval loop (`scan.ts`) + progress

**Files:**
- Create: `src/api/src/test-helpers/mongo.ts` (shared throwaway-mongo harness, if not already present)
- Create: `src/api/src/workers/derivative-audit/progress.ts`
- Create: `src/api/src/workers/derivative-audit/scan.ts`
- Test: `src/api/src/workers/derivative-audit/scan.test.ts`

**Interfaces:**
- Produces (progress.ts):
  - `interface DerivativeAuditSummary { scanned: number; reArmed: number; byStage: Record<string, number>; skippedCooldown: number; errors: number; startedAt: string | null; finishedAt: string | null; running: boolean }`
  - `function getDerivativeAuditProgress(): DerivativeAuditSummary`
  - internal setters used by scan.ts.
- Produces (scan.ts):
  - `async function runDerivativeAuditOnce(cfg?: Partial<DerivativeAuditConfig>): Promise<DerivativeAuditSummary>` — one pass. Loads config (merged with `cfg` override for tests), iterates `assetsCollection().find(claimQuery)` in chunks of `concurrency`, evaluates each asset (Task 4), and for each drifted stage below the cooldown ceiling issues `buildStageReset` + bumps `derivative_audit.<stage>`; clears the mark for a stage whose derivative verifies clean. Stops issuing resets at `max_resets_per_pass`.
  - `interface DerivativeAuditHandle { stop(): void }`
  - `function startDerivativeAudit(): DerivativeAuditHandle` — the interval loop (fires once on boot, then every `interval_ms`), guarded by `enabled` and an in-flight flag, matching `startMirrorScan`.

Claim query (assets that could have drifted): `{ ...liveFileInfoElemMatch(), 'damaged.since': { $not: { $type: 'string' } } }`. (No `stages.*` predicate — a drifted asset looks "done", so the per-stage version gate lives inside `evaluateAsset`.)

Cooldown application inside the pass, per drifted stage `s`:
- read `image.derivative_audit?.[s]?.attempts ?? 0`; if `>= AUDIT_MAX_ATTEMPTS`, count `skippedCooldown` and do not reset.
- else add `buildStageReset(s)` to the `$set` and set `` `${auditMarkKey(s)}` `` to `{ attempts: prev+1, last_reset_at: nowIso }`.
- For every stage in `['thumb','preview','describe','cf-thumb-sync']` NOT in the drift list but which currently has a `derivative_audit.<s>` mark, `$unset` that mark (drift resolved).
- Issue a single `updateOne({ _id }, { $set, $unset })` when either is non-empty.

- [ ] **Step 1: Create the shared test-mongo harness** `src/api/src/test-helpers/mongo.ts` (only if the repo doesn't already expose one — search first: `grep -rl "MongoMemoryServer\|mongodb-memory-server\|spawn.*mongod" src/api/src --include='*.ts'`; if an existing helper is found, import it instead and skip this file). Minimal real-mongod harness:

```ts
import { MongoClient, type Db } from 'mongodb';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { connect as netConnect } from 'node:net';
import { setDbForTests } from '../db/client.ts';

export interface TestMongo { db: Db; client: MongoClient; stop(): Promise<void>; }

function waitPort(port: number, tries = 100): Promise<void> {
  return new Promise((resolve, reject) => {
    const attempt = (n: number) => {
      const sock = netConnect(port, '127.0.0.1');
      sock.once('connect', () => { sock.destroy(); resolve(); });
      sock.once('error', () => {
        sock.destroy();
        if (n <= 0) reject(new Error('mongod did not open port'));
        else setTimeout(() => attempt(n - 1), 100);
      });
    };
    attempt(tries);
  });
}

export async function withTestMongo(): Promise<TestMongo> {
  const port = 27077 + Math.floor(Math.random() * 800);
  const dbPath = await mkdtemp(path.join(tmpdir(), 'audit-mongo-'));
  const proc: ChildProcess = spawn(
    'mongod',
    ['--dbpath', dbPath, '--port', String(port), '--bind_ip', '127.0.0.1', '--nojournal'],
    { stdio: 'ignore' },
  );
  await waitPort(port);
  const client = new MongoClient(`mongodb://127.0.0.1:${port}`);
  await client.connect();
  const db = client.db('audit_test');
  setDbForTests(db); // make getDb()/assetsCollection() return this db
  return {
    db, client,
    stop: async () => {
      await client.close();
      proc.kill('SIGKILL');
      await rm(dbPath, { recursive: true, force: true });
    },
  };
}
```

> NOTE for the implementer: confirm `db/client.ts` exposes a `setDbForTests(db)` seam (or the equivalent the existing API tests use to point `getDb()`/`assetsCollection()` at a test db). If it does not, add a minimal test-only setter there in this step and cover it by the fact that Task 2's and this task's tests pass. Do NOT invent a mocking layer — the existing API integration tests already do this; match their mechanism.

- [ ] **Step 2: Write the failing integration test** `scan.test.ts` — the move scenario end-to-end:

```ts
import { describe, expect, it, beforeAll, afterAll, beforeEach } from 'bun:test';
import { ObjectId } from 'mongodb';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { withTestMongo, type TestMongo } from '../../test-helpers/mongo.ts';
import { runDerivativeAuditOnce } from './scan.ts';

let mongo: TestMongo;
let root: string;
const LIB = new ObjectId();

beforeAll(async () => {
  mongo = await withTestMongo();
  root = await mkdtemp(path.join(tmpdir(), 'audit-scan-'));
  // Register the library root so loadLibraryRoots() resolves it. Match the
  // folders collection shape used by libraries.cache.ts (implementer: confirm
  // the field names — {_id, path, slug} — against foldersCollection docs).
  await mongo.db.collection('folders').insertOne({ _id: LIB, path: root, slug: 'lib' });
});
afterAll(async () => { await mongo.stop(); await rm(root, { recursive: true, force: true }); });
beforeEach(async () => { await mongo.db.collection('assets').deleteMany({}); });

async function seedMovedAsset() {
  // Original present at its (new) path; NO .maple derivatives there — the
  // exact post-move drift. Stages all say "done".
  await mkdir(path.join(root, 'y2024'), { recursive: true });
  await writeFile(path.join(root, 'y2024', 'p.dng'), 'raw');
  await mongo.db.collection('assets').insertOne({
    _id: new ObjectId(),
    maple_id: 'deadbeef',
    fileinfo: [{ library_id: LIB, path: 'y2024', filename: 'p.dng' }],
    live_location_count: 1,
    size: 3, mtime: 1, rating: 0, flag: 0, color_label: '', indexed_at: '',
    description: 'a photo',
    stages: {
      thumb: { version: 3, attempts: 0, last_error: null, processed_at: null, dead: false },
      preview: { version: 4, attempts: 0, last_error: null, processed_at: null, dead: false },
      describe: { version: 7, attempts: 0, last_error: null, processed_at: null, dead: false },
      'cf-thumb-sync': { version: 1, attempts: 0, last_error: null, processed_at: null, dead: false },
    },
  });
}

describe('runDerivativeAuditOnce', () => {
  it('re-arms thumb + preview for a moved asset whose derivatives are gone', async () => {
    await seedMovedAsset();
    const summary = await runDerivativeAuditOnce({ deep_r2_enabled: false });
    expect(summary.scanned).toBe(1);
    expect(summary.byStage.thumb).toBe(1);
    expect(summary.byStage.preview).toBe(1);
    const doc = await mongo.db.collection('assets').findOne({ maple_id: 'deadbeef' });
    expect(doc?.stages.thumb.version).toBe(0);
    expect(doc?.stages.preview.version).toBe(0);
    expect(doc?.stages.describe.version).toBe(7); // description present → untouched
    expect(doc?.derivative_audit.thumb.attempts).toBe(1);
  });

  it('stops re-arming after AUDIT_MAX_ATTEMPTS (cooldown)', async () => {
    await seedMovedAsset();
    for (let i = 0; i < 4; i++) {
      // stage never regenerates in this test (no real workers running), so the
      // drift persists — the auditor must stop after the ceiling.
      await mongo.db.collection('assets').updateOne(
        { maple_id: 'deadbeef' },
        { $set: { 'stages.thumb.version': 3, 'stages.preview.version': 4 } },
      );
      await runDerivativeAuditOnce({ deep_r2_enabled: false });
    }
    const doc = await mongo.db.collection('assets').findOne({ maple_id: 'deadbeef' });
    expect(doc?.derivative_audit.thumb.attempts).toBe(3); // capped, not 4
  });

  it('honors max_resets_per_pass', async () => {
    await seedMovedAsset();
    const summary = await runDerivativeAuditOnce({ deep_r2_enabled: false, max_resets_per_pass: 1 });
    expect(summary.reArmed).toBe(1); // stopped after one stage reset
  });
});
```

- [ ] **Step 3a: Implement `progress.ts`:**

```ts
import type { DerivativeAuditSummary } from './types.ts';
export type { DerivativeAuditSummary } from './types.ts';

let current: DerivativeAuditSummary = emptySummary();
export function emptySummary(): DerivativeAuditSummary {
  return { scanned: 0, reArmed: 0, byStage: {}, skippedCooldown: 0, errors: 0, startedAt: null, finishedAt: null, running: false };
}
export function getDerivativeAuditProgress(): DerivativeAuditSummary {
  return current;
}
export function setDerivativeAuditProgress(s: DerivativeAuditSummary): void {
  current = s;
}
```

(Also create `src/api/src/workers/derivative-audit/types.ts` exporting `DerivativeAuditSummary`.)

- [ ] **Step 3b: Implement `scan.ts`** (the pass + loop). Key structure — iterate the cursor in `concurrency`-sized chunks, evaluate, then issue per-asset `$set`/`$unset`:

```ts
import { assetsCollection } from '../../db/client.ts';
import { liveFileInfoElemMatch } from '../../indexer/images.repo.ts';
import { loadLibraryRoots, loadLibraryIdToSlug } from '../../indexer/libraries.cache.ts';
import { statOrNull } from '../mirror/replicate.ts';
import { ffmpegBinary } from '../../thumbs/video-poster.ts';
import {
  loadCloudflareConfig, resolveCloudflareConfig, isCloudflareConfigComplete,
} from '../../cloudflare/cloudflare-config.repo.ts';
import { thumbExistsInR2 } from '../../cloudflare/r2-client.ts';
import { child as childLogger } from '../../log.ts';
import { evaluateAsset, type AuditDeps } from './checks.ts';
import { buildStageReset, auditMarkKey, AUDIT_MAX_ATTEMPTS } from './reset.ts';
import {
  DEFAULT_DERIVATIVE_AUDIT_CONFIG, loadDerivativeAuditConfig, type DerivativeAuditConfig,
} from './config.repo.ts';
import { emptySummary, setDerivativeAuditProgress } from './progress.ts';
import type { DerivativeAuditSummary } from './types.ts';
import type { ImageDoc } from '../run-stage.ts';

const log = childLogger('derivative-audit');
const ALL_AUDIT_STAGES = ['thumb', 'preview', 'describe', 'cf-thumb-sync'] as const;

export async function runDerivativeAuditOnce(
  override: Partial<DerivativeAuditConfig> = {},
): Promise<DerivativeAuditSummary> {
  const cfg = { ...(await loadDerivativeAuditConfig()), ...override };
  const summary = emptySummary();
  summary.startedAt = new Date().toISOString();
  summary.running = true;
  setDerivativeAuditProgress({ ...summary });

  const libs = await loadLibraryRoots();
  const idToSlug = await loadLibraryIdToSlug();
  const coll = await assetsCollection();

  // Deep R2: only when explicitly enabled AND fully configured.
  const cf = resolveCloudflareConfig(await loadCloudflareConfig());
  const r2Ready = cfg.deep_r2_enabled && isCloudflareConfigComplete(cf);
  const deps: AuditDeps = {
    statOrNull,
    ffmpegAvailable: () => ffmpegBinary().then((b) => b !== null),
    thumbExistsInR2: r2Ready
      ? (key) => thumbExistsInR2(cf, key, AbortSignal.timeout(5_000))
      : null,
  };

  const cursor = coll.find(
    { ...liveFileInfoElemMatch(), 'damaged.since': { $not: { $type: 'string' } } },
    { projection: { fileinfo: 1, maple_id: 1, stages: 1, description: 1, hidden: 1, derivative_audit: 1 } },
  );

  let chunk: ImageDoc[] = [];
  const flush = async () => {
    await Promise.all(chunk.map((doc) => handleOne(doc)));
    chunk = [];
  };
  const handleOne = async (doc: ImageDoc) => {
    if (summary.reArmed >= cfg.max_resets_per_pass) return;
    try {
      summary.scanned++;
      const drifted = await evaluateAsset(doc, libs, idToSlug, deps);
      const nowIso = new Date().toISOString();
      const set: Record<string, unknown> = {};
      const unset: Record<string, unknown> = {};
      for (const s of drifted) {
        if (summary.reArmed >= cfg.max_resets_per_pass) break;
        const prev = doc.derivative_audit?.[s]?.attempts ?? 0;
        if (prev >= AUDIT_MAX_ATTEMPTS) { summary.skippedCooldown++; continue; }
        Object.assign(set, buildStageReset(s));
        set[auditMarkKey(s)] = { attempts: prev + 1, last_reset_at: nowIso };
        summary.reArmed++;
        summary.byStage[s] = (summary.byStage[s] ?? 0) + 1;
      }
      // Clear resolved marks for stages that did NOT drift this pass.
      for (const s of ALL_AUDIT_STAGES) {
        if (!drifted.includes(s) && doc.derivative_audit?.[s]) unset[auditMarkKey(s)] = '';
      }
      const update: Record<string, unknown> = {};
      if (Object.keys(set).length) update.$set = set;
      if (Object.keys(unset).length) update.$unset = unset;
      if (Object.keys(update).length) await coll.updateOne({ _id: doc._id }, update);
    } catch (err) {
      summary.errors++;
      log.warn({ id: doc._id, err: err instanceof Error ? err.message : err }, 'audit row failed');
    }
  };

  for await (const doc of cursor) {
    chunk.push(doc as unknown as ImageDoc);
    if (chunk.length >= Math.max(1, cfg.concurrency)) await flush();
    if (summary.reArmed >= cfg.max_resets_per_pass) break;
  }
  await flush();

  summary.finishedAt = new Date().toISOString();
  summary.running = false;
  setDerivativeAuditProgress({ ...summary });
  if (summary.scanned > 0) log.info(summary, 'derivative-audit pass complete');
  return summary;
}

export interface DerivativeAuditHandle { stop(): void; }

export function startDerivativeAudit(): DerivativeAuditHandle {
  let stopped = false;
  let inFlight = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  const tick = async () => {
    if (stopped || inFlight) return;
    const cfg = await loadDerivativeAuditConfig();
    if (!cfg.enabled) return;
    inFlight = true;
    try { await runDerivativeAuditOnce(); }
    catch (err) { log.error({ err: err instanceof Error ? err.message : err }, 'derivative-audit pass crashed'); }
    finally { inFlight = false; }
  };
  // Re-read cadence each boot; interval uses the default (config changes to the
  // interval take effect on next restart — matching mirror-scan's fixed timer).
  timer = setInterval(() => void tick(), DEFAULT_DERIVATIVE_AUDIT_CONFIG.interval_ms);
  timer.unref?.();
  void tick();
  return { stop: () => { stopped = true; if (timer) clearInterval(timer); } };
}
```

> NOTE: `loadLibraryIdToSlug` is imported from `../../indexer/libraries.cache.ts` (same module `cf-thumb-sync.ts` uses). Confirm the export name; if it differs, match the real one.

- [ ] **Step 4: Run test, verify pass.** Run: `cd src/api && bun test src/workers/derivative-audit/scan.test.ts`. Expected: PASS (3 tests). If mongod isn't on PATH the harness throws — install/point to a local `mongod` (see the API test memory).

- [ ] **Step 5: Commit.**

```bash
git add src/api/src/workers/derivative-audit/ src/api/src/test-helpers/mongo.ts src/api/src/db/client.ts
git commit -m "feat(api): derivative-audit pass + interval loop (#2156)"
```

---

### Task 6: Boot the worker in maintenance

**Files:**
- Modify: `src/api/src/workers/maintenance.ts`

**Interfaces:**
- Consumes: `startDerivativeAudit`, `DerivativeAuditHandle` from `./derivative-audit/scan.ts`.

- [ ] **Step 1: Add the import + handle.** In `maintenance.ts`, add near the other imports:

```ts
import { startDerivativeAudit, type DerivativeAuditHandle } from './derivative-audit/scan.ts';
```

and a module-level handle beside `mirrorScan`:

```ts
let derivativeAudit: DerivativeAuditHandle | null = null;
```

- [ ] **Step 2: Start it in `startMaintenanceJobs()`** after the mirror block:

```ts
  // Derivative-audit: verify each asset's thumb/preview/description on disk and
  // its thumbnail in R2; re-arm the owning stage when a derivative has drifted
  // (most often after a move left the .maple cache behind). Self-gates on its
  // own `enabled` config each tick.
  if (!derivativeAudit) derivativeAudit = startDerivativeAudit();
```

- [ ] **Step 3: Stop it in `stopMaintenanceJobs()`** beside `mirrorScan`:

```ts
  derivativeAudit?.stop();
  derivativeAudit = null;
```

- [ ] **Step 4: Verify the module still type-loads.** Run: `cd src/api && bun test src/workers/derivative-audit/scan.test.ts` (unchanged pass) and `cd src/api && bunx tsc --noEmit 2>&1 | grep -c "maintenance.ts"` — expected `0`.

- [ ] **Step 5: Commit.**

```bash
git add src/api/src/workers/maintenance.ts
git commit -m "feat(api): boot derivative-audit worker in maintenance jobs (#2156)"
```

---

### Task 7: Status + config + run-now route

**Files:**
- Create: `src/api/src/routes/derivative-audit.ts`
- Modify: `src/api/src/index.ts` (mount the route behind `requireAuth`, beside `mirrorRoutes`)
- Test: `src/api/src/routes/derivative-audit.test.ts`

**Interfaces:**
- Produces (Elysia):
  - `GET  /api/derivative-audit/status` → `{ config: DerivativeAuditConfig; progress: DerivativeAuditSummary }`
  - `PUT  /api/derivative-audit/config` (body: partial config, validated) → `{ ok: true; config }`
  - `POST /api/derivative-audit/run` → kicks `runDerivativeAuditOnce()` in the background (returns immediately `{ started: true }`; a run already in flight returns `{ started: false, reason: 'already-running' }`).
  - `export const derivativeAuditRoutes`

- [ ] **Step 1: Write the failing test** (`derivative-audit.test.ts`) — call the Elysia app's `.handle()` with `Request`s (the pattern other route tests use — implementer: match an existing `routes/*.test.ts` for app construction + auth bypass):

```ts
import { describe, expect, it, beforeAll, afterAll, beforeEach } from 'bun:test';
import { withTestMongo, type TestMongo } from '../test-helpers/mongo.ts';
import { derivativeAuditRoutes } from './derivative-audit.ts';

let mongo: TestMongo;
beforeAll(async () => { mongo = await withTestMongo(); });
afterAll(async () => { await mongo.stop(); });
beforeEach(async () => { await mongo.db.collection('app_settings').deleteMany({}); });

describe('derivative-audit routes', () => {
  it('GET /status returns config + progress', async () => {
    const res = await derivativeAuditRoutes.handle(
      new Request('http://x/api/derivative-audit/status'),
    );
    const body = await res.json();
    expect(body.config.enabled).toBe(true);
    expect(body.progress).toHaveProperty('scanned');
  });

  it('PUT /config persists a partial patch', async () => {
    const res = await derivativeAuditRoutes.handle(
      new Request('http://x/api/derivative-audit/config', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: false, deep_r2_enabled: false }),
      }),
    );
    expect((await res.json()).config.enabled).toBe(false);
    const check = await derivativeAuditRoutes.handle(
      new Request('http://x/api/derivative-audit/status'),
    );
    expect((await check.json()).config.enabled).toBe(false);
  });
});
```

- [ ] **Step 2: Run it, verify it fails.** Run: `cd src/api && bun test src/routes/derivative-audit.test.ts`. Expected: FAIL (module missing).

- [ ] **Step 3: Implement `derivative-audit.ts`** (model on `routes/mirror.ts` — Elysia + `t` body validation):

```ts
import { Elysia, t } from 'elysia';
import {
  loadDerivativeAuditConfig, saveDerivativeAuditConfig,
} from '../workers/derivative-audit/config.repo.ts';
import { runDerivativeAuditOnce } from '../workers/derivative-audit/scan.ts';
import { getDerivativeAuditProgress } from '../workers/derivative-audit/progress.ts';

let runInFlight = false;

export const derivativeAuditRoutes = new Elysia()
  .get('/api/derivative-audit/status', async () => ({
    config: await loadDerivativeAuditConfig(),
    progress: getDerivativeAuditProgress(),
  }))
  .put(
    '/api/derivative-audit/config',
    async ({ body }) => {
      await saveDerivativeAuditConfig(body);
      return { ok: true, config: await loadDerivativeAuditConfig() };
    },
    {
      body: t.Object({
        enabled: t.Optional(t.Boolean()),
        interval_ms: t.Optional(t.Integer({ minimum: 60_000 })),
        max_resets_per_pass: t.Optional(t.Integer({ minimum: 1, maximum: 1_000_000 })),
        concurrency: t.Optional(t.Integer({ minimum: 1, maximum: 64 })),
        deep_r2_enabled: t.Optional(t.Boolean()),
      }),
    },
  )
  .post('/api/derivative-audit/run', async () => {
    if (runInFlight) return { started: false, reason: 'already-running' };
    runInFlight = true;
    void runDerivativeAuditOnce().finally(() => { runInFlight = false; });
    return { started: true };
  });
```

- [ ] **Step 4: Mount it.** In `src/api/src/index.ts`, find where `mirrorRoutes` is `.use(...)`d behind `requireAuth` and add `.use(derivativeAuditRoutes)` beside it (import at top). Run: `cd src/api && bun test src/routes/derivative-audit.test.ts`. Expected: PASS (2 tests).

- [ ] **Step 5: Commit.**

```bash
git add src/api/src/routes/derivative-audit.ts src/api/src/routes/derivative-audit.test.ts src/api/src/index.ts
git commit -m "feat(api): derivative-audit status/config/run route (#2156)"
```

---

### Task 8: maple-common backend service + DTOs

**Files:**
- Modify: the backend service in `src/web/projects/maple-common/src/lib/` that owns `getMirrorStatus`/`runMirrorReconcile` (grep: `grep -rl "getMirrorStatus" src/web/projects/maple-common/src`), plus its public DTO exports (grep `MirrorReconcileProgress`).

**Interfaces:**
- Produces on `BunApiBackendService`:
  - `getDerivativeAuditStatus(): Observable<DerivativeAuditStatusDto>`
  - `setDerivativeAuditConfig(patch: Partial<DerivativeAuditConfigDto>): Observable<{ ok: boolean; config: DerivativeAuditConfigDto }>`
  - `runDerivativeAudit(): Observable<{ started: boolean; reason?: string }>`
  - Exported DTO types `DerivativeAuditConfigDto`, `DerivativeAuditSummaryDto`, `DerivativeAuditStatusDto` (structural mirrors of the API types) from the same barrel that exports `MirrorReconcileProgress` (so `@maple-common` re-exports them).

- [ ] **Step 1: Write the failing test.** Add to the backend service's existing `.spec.ts` (grep `getMirrorStatus` in a `.spec.ts`) an `HttpTestingController` case mirroring the mirror-status test:

```ts
it('getDerivativeAuditStatus GETs the status endpoint', () => {
  let got: DerivativeAuditStatusDto | undefined;
  service.getDerivativeAuditStatus().subscribe((r) => (got = r));
  const req = httpMock.expectOne((r) => r.url.endsWith('/api/derivative-audit/status'));
  expect(req.request.method).toBe('GET');
  req.flush({ config: { enabled: true, interval_ms: 1, max_resets_per_pass: 1, concurrency: 1, deep_r2_enabled: true }, progress: { scanned: 0, reArmed: 0, byStage: {}, skippedCooldown: 0, errors: 0, startedAt: null, finishedAt: null, running: false } });
  expect(got?.config.enabled).toBe(true);
});
```

- [ ] **Step 2: Run it, verify it fails.** Run: `cd src/web && bun x ng test maple-common --watch=false --include='**/<that-service>.spec.ts'`. (Match the project's test invocation — see the web test memory: `ng test project=maple-common`.) Expected: FAIL (method undefined).

- [ ] **Step 3: Implement** the three methods + DTO types on the service, mirroring the existing mirror methods (same `http.get`/`http.put`/`http.post` + `apiUrl(...)` helper the mirror methods use). Export the DTO types from the library barrel.

- [ ] **Step 4: Run test, verify pass.** Re-run Step 2's command. Expected: PASS.

- [ ] **Step 5: Prettier + commit.**

```bash
./src/web/node_modules/.bin/prettier --write <changed web files>
git add <changed web files>
git commit -m "feat(web): maple-common client for derivative-audit (#2156)"
```

---

### Task 9: Operator panel on Settings → Workers

**Files:**
- Create: `src/web/projects/maple/src/app/settings/workers/derivative-audit-settings.component.ts` / `.html` / `.scss`
- Modify: `src/web/projects/maple/src/app/settings/workers/workers.component.ts` (import the component) and `workers.component.html` (render it under its own group label)
- Test: `derivative-audit-settings.component.spec.ts`

**Interfaces:**
- Consumes: `getDerivativeAuditStatus`, `setDerivativeAuditConfig`, `runDerivativeAudit` (Task 8).

Model directly on `mirror-settings.component.ts` (standalone, `ChangeDetectionStrategy.OnPush`, signals, `ngOnInit` fetch + `refreshStatus`, poll timer while `progress.running`). The panel shows: a status pill (`Running` / `Enabled` / `Off`), an enable toggle, number inputs for `max_resets_per_pass` / `interval_ms` (hours) / `concurrency`, a `deep_r2_enabled` checkbox, a "Run now" button, and a last-pass readout (`scanned`, `reArmed`, per-stage counts, `errors`). Save calls `setDerivativeAuditConfig`.

- [ ] **Step 1: Write the failing spec** — render the standalone component with `provideHttpClientTesting()`, flush a `GET /status`, assert the enable toggle reflects `config.enabled` and the last-pass counts render. (Mirror `mirror-settings.component.spec.ts` structure — read it for the exact `TestBed` + `HttpTestingController` setup.)

- [ ] **Step 2: Run it, verify it fails.** Run: `cd src/web && bun x ng test maple --watch=false --include='**/derivative-audit-settings.component.spec.ts'`. Expected: FAIL (component missing).

- [ ] **Step 3: Implement** the component (`.ts`/`.html`/`.scss`) adapting `mirror-settings.component.*`. Then in `workers.component.ts` add the import to the `imports:` array, and in `workers.component.html` add — after the `Backup` group block (`<maple-mirror-settings />`) — a new group:

```html
    <!-- Maintenance — the derivative-audit self-heal worker: verifies each
         asset's thumb/preview/description on disk + thumbnail in R2 and
         re-arms the owning stage when a derivative has drifted. -->
    <div class="group-label">Maintenance</div>
    <maple-derivative-audit-settings />
```

- [ ] **Step 4: Run test, verify pass.** Re-run Step 2's command. Expected: PASS.

- [ ] **Step 5: Prettier + commit.**

```bash
./src/web/node_modules/.bin/prettier --write <changed web files>
git add <changed web files>
git commit -m "feat(web): derivative-audit panel on Settings → Workers (#2156)"
```

---

### Task 10: Full-suite green + PR

**Files:** none (verification + PR).

- [ ] **Step 1: API suite.** Run: `cd src/api && bun test`. Expected: no NEW failures vs. `origin/main` (record any pre-existing reds first with a clean checkout if unsure).
- [ ] **Step 2: Web tests for touched projects.** Run: `cd src/web && bun x ng test maple-common --watch=false` and `bun x ng test maple --watch=false`. Expected: green for the new specs; no new failures.
- [ ] **Step 3: Prettier gate.** Run: `cd src/web && bun run format:check` (or the pinned prettier over `main...HEAD` changed files). Expected: clean.
- [ ] **Step 4: Rebase check.** `git fetch origin main && git rebase origin/main` (resolve per-commit if needed), `git push --force-with-lease`.
- [ ] **Step 5: Open the PR** (ready, not draft) with `Closes #2156`, body summarizing the worker + the four checks + loop-protection + the Settings → Workers panel. End the body with the Claude Code attribution line.

---

## Self-Review

**Spec coverage:** ① reconcile-only, previews local-only, Cloudflare = existing thumb sync → Tasks 4 (checks) + 1 (R2 HEAD, thumbs only). ② continuous background self-heal, mirror-scan shape → Task 5 `startDerivativeAudit`, Task 6 boot. ③ deep R2 verify → Task 1 + Task 4 cf-thumb-sync check + Task 5 `r2Ready` gate. Four checks → Task 4. 5-field reset → Task 3. Loop protection (skip-predicates + cooldown) → Task 4 `pixelDerivativeExpected`/hidden guard + Task 3/5 cooldown. Config via settings → Task 2. Operator surface → Tasks 7–9. Testing (move fixture, skip-legit, cooldown, R2) → Tasks 4–5 tests. Ticket → #2156, Task 10.

**Placeholder scan:** the two "NOTE for the implementer" items (test-mongo `setDbForTests` seam, `loadLibraryIdToSlug` export name, folders doc field names) are verification-of-existing-code steps, not deferred work — each says exactly what to confirm and what to do. No "TBD"/"handle edge cases"/"add validation" left abstract.

**Type consistency:** `DerivativeAuditConfig` fields (`enabled`, `interval_ms`, `max_resets_per_pass`, `concurrency`, `deep_r2_enabled`) are identical across config.repo (Task 2), scan override (Task 5), route body (Task 7), and DTO (Task 8). `buildStageReset`/`auditMarkKey`/`AUDIT_MAX_ATTEMPTS` (Task 3) are consumed unchanged in Task 5. `evaluateAsset(image, libs, idToSlug, deps)` signature (Task 4) matches its call in Task 5. `DerivativeAuditSummary` shape is single-sourced in `types.ts` and reused by progress.ts, scan.ts, the route, and the DTO.
