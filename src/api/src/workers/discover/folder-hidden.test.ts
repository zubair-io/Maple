/**
 * Folder-level `.hidden` marker (#2972): the discover sweep hides every photo
 * in a marked directory (and its subtree, via the frontier's
 * `hidden_ancestor` flag), and un-hides them when the marker is removed.
 * Real temp dirs + real Mongo, matching `sweeper.test.ts`.
 */
import { describe, it, expect, afterAll, beforeAll, beforeEach } from 'bun:test';
import { ObjectId, type Db, type WithId } from 'mongodb';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb, getDb, assetsCollection } from '../../db/client.ts';
import { withTestDb } from '../../db/test-db.test-helpers.ts';
import type { AssetDoc } from '../../db/schema.ts';
import type { HidableAsset } from '../../cloudflare/hidden-cleanup.ts';

withTestDb(`maple_test_discover_folder_hidden_${process.pid}`);

let suiteDb: Db | null = null;
let reachable = true;
beforeAll(async () => {
  try {
    await closeDb();
    suiteDb = await getDb();
  } catch {
    reachable = false;
  }
});
beforeEach(async () => {
  if (!reachable) return;
  await (await getDb()).collection('discover_frontier').deleteMany({});
  await (await assetsCollection()).deleteMany({});
});
afterAll(async () => {
  if (suiteDb) await suiteDb.dropDatabase();
  await closeDb();
});

function makeRoot(): string {
  return mkdtempSync(join(tmpdir(), 'maple-folder-hidden-'));
}

async function insertAsset(
  folderId: ObjectId,
  relDir: string,
  filename: string,
  extra: Record<string, unknown> = {},
): Promise<ObjectId> {
  const coll = await assetsCollection();
  const res = await coll.insertOne({
    maple_id: `${relDir}/${filename}`,
    fileinfo: [{ library_id: folderId, path: relDir, filename }],
    deleted_at: null,
    ...extra,
  } as never);
  return res.insertedId;
}

async function loadAsset(id: ObjectId): Promise<WithId<AssetDoc>> {
  const doc = await (await assetsCollection()).findOne({ _id: id });
  expect(doc).not.toBeNull();
  return doc as WithId<AssetDoc>;
}

async function visit(
  folderId: ObjectId,
  root: string,
  cleanupCalls?: HidableAsset[][],
): Promise<void> {
  const { visitDirectory } = await import('./sweeper.ts');
  const frontier = await import('./frontier.repo.ts');
  const dir = await frontier.claimNextDir(folderId, 1, 60_000);
  expect(dir).not.toBeNull();
  await visitDirectory(dir!, root, {
    handleEvent: async () => {},
    folderId,
    cleanupHidden: cleanupCalls
      ? async (assets) => {
          cleanupCalls.push(assets);
        }
      : undefined,
  });
}

describe('folder .hidden marker — hide pass', () => {
  it('hides visible recorded assets in a marked dir, with reason folder and R2 cleanup', async () => {
    if (!reachable) return;
    const frontier = await import('./frontier.repo.ts');
    const root = makeRoot();
    writeFileSync(join(root, '.hidden'), '');
    writeFileSync(join(root, 'a.dng'), 'x');
    const folderId = new ObjectId();
    const visibleId = await insertAsset(folderId, '', 'a.dng');

    await frontier.seedRoot(folderId, root, 1);
    const cleanupCalls: HidableAsset[][] = [];
    await visit(folderId, root, cleanupCalls);

    const doc = await loadAsset(visibleId);
    expect(doc.hidden).toBe(true);
    expect(doc.hidden_reason).toBe('folder');
    // Operator-initiated: never enters the AI-review list.
    expect(doc.hidden_ack).toBeUndefined();
    // Meilisearch must re-project the hidden flag.
    const stages = (doc as unknown as { stages?: Record<string, { version?: number }> }).stages;
    expect(stages?.meili?.version).toBe(0);
    // R2 mirror comes down for the newly hidden asset.
    expect(cleanupCalls.flat().map((a) => a._id.toHexString())).toEqual([visibleId.toHexString()]);
    rmSync(root, { recursive: true, force: true });
  });

  it('leaves assets with an explicit visible override untouched, and does not disturb existing hides', async () => {
    if (!reachable) return;
    const frontier = await import('./frontier.repo.ts');
    const root = makeRoot();
    writeFileSync(join(root, '.hidden'), '');
    writeFileSync(join(root, 'override.dng'), 'x');
    writeFileSync(join(root, 'manual.dng'), 'x');
    const folderId = new ObjectId();
    const overrideId = await insertAsset(folderId, '', 'override.dng', {
      metadata_override: { hidden: false },
    });
    const manualId = await insertAsset(folderId, '', 'manual.dng', {
      hidden: true,
      hidden_reason: 'manual',
    });

    await frontier.seedRoot(folderId, root, 1);
    const cleanupCalls: HidableAsset[][] = [];
    await visit(folderId, root, cleanupCalls);

    const overridden = await loadAsset(overrideId);
    expect(overridden.hidden).not.toBe(true);
    expect(overridden.hidden_reason).toBeUndefined();
    const manual = await loadAsset(manualId);
    expect(manual.hidden).toBe(true);
    expect(manual.hidden_reason).toBe('manual');
    expect(cleanupCalls.flat()).toHaveLength(0);
    rmSync(root, { recursive: true, force: true });
  });
});

describe('folder .hidden marker — un-hide pass', () => {
  it('un-hides only folder-hidden assets when the marker is gone, re-arming cf-thumb-sync', async () => {
    if (!reachable) return;
    const frontier = await import('./frontier.repo.ts');
    const root = makeRoot();
    writeFileSync(join(root, 'a.dng'), 'x');
    writeFileSync(join(root, 'manual.dng'), 'x');
    const folderId = new ObjectId();
    const folderHiddenId = await insertAsset(folderId, '', 'a.dng', {
      hidden: true,
      hidden_reason: 'folder',
      stages: { 'cf-thumb-sync': { version: 3 }, meili: { version: 2 } },
    });
    const manualId = await insertAsset(folderId, '', 'manual.dng', {
      hidden: true,
      hidden_reason: 'manual',
    });

    await frontier.seedRoot(folderId, root, 1);
    await visit(folderId, root);

    const unhidden = await loadAsset(folderHiddenId);
    expect(unhidden.hidden).toBe(false);
    expect(unhidden.hidden_reason).toBeNull();
    const stages = (unhidden as unknown as { stages?: Record<string, { version?: number }> })
      .stages;
    expect(stages?.['cf-thumb-sync']?.version).toBe(0);
    expect(stages?.meili?.version).toBe(0);
    const manual = await loadAsset(manualId);
    expect(manual.hidden).toBe(true);
    expect(manual.hidden_reason).toBe('manual');
    rmSync(root, { recursive: true, force: true });
  });

  it('does not un-hide a folder-hidden asset whose override has since forced hidden', async () => {
    if (!reachable) return;
    const frontier = await import('./frontier.repo.ts');
    const root = makeRoot();
    writeFileSync(join(root, 'a.dng'), 'x');
    const folderId = new ObjectId();
    const id = await insertAsset(folderId, '', 'a.dng', {
      hidden: true,
      hidden_reason: 'folder',
      metadata_override: { hidden: true },
    });

    await frontier.seedRoot(folderId, root, 1);
    await visit(folderId, root);

    const doc = await loadAsset(id);
    expect(doc.hidden).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });
});

describe('folder .hidden marker — deduplicated assets (multi-location)', () => {
  it('keeps a dup hidden when its other live location is still under a marked dir (no flapping)', async () => {
    if (!reachable) return;
    const frontier = await import('./frontier.repo.ts');
    const { setLibraryRootsForTests } = await import('../../indexer/libraries.cache.ts');
    const root = makeRoot();
    mkdirSync(join(root, 'hidden-src'));
    writeFileSync(join(root, 'hidden-src', '.hidden'), '');
    writeFileSync(join(root, 'hidden-src', 'dup.dng'), 'x');
    mkdirSync(join(root, 'visible-dup'));
    writeFileSync(join(root, 'visible-dup', 'dup.dng'), 'x');
    const folderId = new ObjectId();
    setLibraryRootsForTests(new Map([[folderId.toHexString(), root]]));
    const coll = await assetsCollection();
    const { insertedId } = await coll.insertOne({
      maple_id: 'dup',
      fileinfo: [
        { library_id: folderId, path: 'hidden-src', filename: 'dup.dng' },
        { library_id: folderId, path: 'visible-dup', filename: 'dup.dng' },
      ],
      deleted_at: null,
      hidden: true,
      hidden_reason: 'folder',
    } as never);

    // Visit ONLY the unmarked dir — the marker in hidden-src must still
    // keep the asset hidden, else every sweep generation flip-flops it.
    await frontier.enqueueDirs(folderId, [join(root, 'visible-dup')], 1, false);
    await visit(folderId, root);

    const doc = await loadAsset(insertedId);
    expect(doc.hidden).toBe(true);
    expect(doc.hidden_reason).toBe('folder');
    setLibraryRootsForTests(null);
    rmSync(root, { recursive: true, force: true });
  });
});

describe('folder .hidden marker — entry liveness', () => {
  it('does not hide an asset whose only entry in the marked dir is missing/dead', async () => {
    if (!reachable) return;
    const frontier = await import('./frontier.repo.ts');
    const root = makeRoot();
    writeFileSync(join(root, '.hidden'), '');
    const folderId = new ObjectId();
    const missingId = await insertAsset(folderId, '', 'gone.dng', {});
    await (
      await assetsCollection()
    ).updateOne(
      { _id: missingId },
      { $set: { 'fileinfo.0.missing_since': '2026-01-01T00:00:00Z' } },
    );
    const deadId = await insertAsset(folderId, '', 'dead.dng', {});
    await (
      await assetsCollection()
    ).updateOne({ _id: deadId }, { $set: { 'fileinfo.0.deleted_at': '2026-01-01T00:00:00Z' } });

    await frontier.seedRoot(folderId, root, 1);
    await visit(folderId, root);

    expect((await loadAsset(missingId)).hidden).not.toBe(true);
    expect((await loadAsset(deadId)).hidden).not.toBe(true);
    rmSync(root, { recursive: true, force: true });
  });
});

describe('folder .hidden marker — subtree propagation', () => {
  it('enqueues child dirs of a marked dir with hidden_ancestor, and hides their assets on visit', async () => {
    if (!reachable) return;
    const frontier = await import('./frontier.repo.ts');
    const root = makeRoot();
    writeFileSync(join(root, '.hidden'), '');
    mkdirSync(join(root, 'sub'));
    writeFileSync(join(root, 'sub', 'nested.dng'), 'x');
    const folderId = new ObjectId();
    const nestedId = await insertAsset(folderId, 'sub', 'nested.dng');

    await frontier.seedRoot(folderId, root, 1);
    await visit(folderId, root); // visits root, enqueues sub with the flag
    await visit(folderId, root); // visits sub (no marker of its own)

    const nested = await loadAsset(nestedId);
    expect(nested.hidden).toBe(true);
    expect(nested.hidden_reason).toBe('folder');
    rmSync(root, { recursive: true, force: true });
  });

  it('does not propagate hidden_ancestor from an unmarked dir', async () => {
    if (!reachable) return;
    const frontier = await import('./frontier.repo.ts');
    const root = makeRoot();
    mkdirSync(join(root, 'sub'));
    writeFileSync(join(root, 'sub', 'nested.dng'), 'x');
    const folderId = new ObjectId();
    const nestedId = await insertAsset(folderId, 'sub', 'nested.dng');

    await frontier.seedRoot(folderId, root, 1);
    await visit(folderId, root);
    await visit(folderId, root);

    const nested = await loadAsset(nestedId);
    expect(nested.hidden).not.toBe(true);
    rmSync(root, { recursive: true, force: true });
  });
});
