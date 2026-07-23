/**
 * Discover producer — content-addressing / dedup tests.
 *
 * Split from the original discover.test.ts (#251). Covers PR 2 of the
 * content-addressing migration: dedup by `maple_id`, concurrent
 * dedup-append races, in-place soft-delete when bytes change under a
 * known path, and direct population of `maple_id` + `sha1_head` at
 * insert (no post-insert hash stage).
 *
 * Requires: MAPLE_MONGO_URI (or a local MongoDB on localhost:27017).
 * Skips gracefully when Mongo is unreachable.
 */
import { describe, expect, it, beforeAll, afterAll } from 'bun:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import type { MongoClient } from 'mongodb';
import { type Db } from 'mongodb';
import * as os from 'node:os';
import * as path from 'node:path';
import { tryConnect } from './_test-helpers.ts';

const TEST_DB = `maple_test_discover_dedup_${process.pid}`;
process.env.MAPLE_MONGO_DB = TEST_DB;

let mongo: MongoClient | null = null;
let mongoReachable = false;
let db: Db | null = null;

beforeAll(async () => {
  mongo = await tryConnect();
  mongoReachable = mongo !== null;
  if (!mongoReachable) {
    console.log('[discover.dedup.test] skipping: MongoDB unreachable');
    return;
  }
  db = mongo!.db(TEST_DB);
  await db.dropDatabase();
  const { closeDb } = await import('../../db/client.ts');
  await closeDb();
});

afterAll(async () => {
  if (mongo) {
    try {
      await mongo.db(TEST_DB).dropDatabase();
    } catch {}
    try {
      await mongo.close();
    } catch {}
  }
  const { closeDb } = await import('../../db/client.ts');
  await closeDb();
});

describe('discover producer — dedup', () => {
  it('dedups two files with identical content into one row with two fileinfo entries', async () => {
    if (!mongoReachable) return;

    const { handleEvent } = await import('./index.ts');
    const { assetsCollection, foldersCollection } = await import('../../db/client.ts');
    const { mkdir } = await import('node:fs/promises');

    const root = await mkdtemp(path.join(os.tmpdir(), 'discover-dedup-'));
    const dirA = path.join(root, 'a');
    const dirB = path.join(root, 'b');
    await mkdir(dirA, { recursive: true });
    await mkdir(dirB, { recursive: true });
    const fileA = path.join(dirA, 'IMG.dng');
    const fileB = path.join(dirB, 'IMG.dng');
    // Byte-identical content → same maple_id.
    const bytes = Buffer.alloc(70 * 1024, 0xab);
    await writeFile(fileA, bytes);
    await writeFile(fileB, bytes);

    const foldersColl = await foldersCollection();
    const folderResult = await foldersColl.insertOne({
      path: root,
      label: 'dedup-test',
      last_scan: null,
      file_count: 0,
      created_at: new Date().toISOString(),
    } as never);
    const folderId = folderResult.insertedId;
    const coll = await assetsCollection();
    // Wipe any previous run's row at this maple_id.
    const { hashFileForId } = await import('../../indexer/id.ts');
    const { maple_id } = await hashFileForId(fileA);
    await coll.deleteMany({ maple_id });

    await handleEvent({ kind: 'created', absPath: fileA }, folderId, root);
    await handleEvent({ kind: 'created', absPath: fileB }, folderId, root);

    const rows = await coll.find({ maple_id }).toArray();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.fileinfo).toHaveLength(2);
    const entries = (rows[0]!.fileinfo ?? []).map((e: any) => `${e.path}/${e.filename}`).sort();
    expect(entries).toEqual(['a/IMG.dng', 'b/IMG.dng']);
    expect(rows[0]!.maple_id).toMatch(/^[0-9a-f]{32}$/);

    await coll.deleteMany({ maple_id });
    await foldersColl.deleteOne({ _id: folderId });
    await rm(root, { recursive: true, force: true });
  });

  it("modified file with new content marks old row's fileinfo entry deleted", async () => {
    if (!mongoReachable) return;

    const { handleEvent } = await import('./index.ts');
    const { assetsCollection, foldersCollection } = await import('../../db/client.ts');

    const root = await mkdtemp(path.join(os.tmpdir(), 'discover-modnew-'));
    const file = path.join(root, 'shifty.jpg');
    // Write original content, discover, then OVERWRITE with different bytes.
    const oldContent = Buffer.alloc(80 * 1024, 0x11);
    const newContent = Buffer.alloc(80 * 1024, 0x99);
    await writeFile(file, oldContent);

    const foldersColl = await foldersCollection();
    const folderResult = await foldersColl.insertOne({
      path: root,
      label: 'mod-new-content',
      last_scan: null,
      file_count: 0,
      created_at: new Date().toISOString(),
    } as never);
    const folderId = folderResult.insertedId;
    const coll = await assetsCollection();
    const { hashFileForId } = await import('../../indexer/id.ts');
    const oldHashed = await hashFileForId(file);
    await coll.deleteMany({ maple_id: { $in: [oldHashed.maple_id] } });

    await handleEvent({ kind: 'created', absPath: file }, folderId, root);
    // Replace file with different content → different maple_id.
    await writeFile(file, newContent);
    const newHashed = await hashFileForId(file);
    expect(newHashed.maple_id).not.toBe(oldHashed.maple_id);

    await handleEvent({ kind: 'modified', absPath: file }, folderId, root);

    // Old row should still exist (originals are sacred — soft-delete only),
    // with its fileinfo entry at this location marked deleted.
    const oldRow = await coll.findOne({ maple_id: oldHashed.maple_id });
    expect(oldRow).not.toBeNull();
    const oldEntry = (oldRow!.fileinfo ?? []).find(
      (e: any) => e.library_id.equals(folderId) && e.path === '' && e.filename === 'shifty.jpg',
    );
    expect(oldEntry).toBeDefined();
    expect(oldEntry!.deleted_at).not.toBeNull();
    // Structured provenance for the dual-flag (#2171).
    expect((oldEntry as { missing_reason?: string }).missing_reason).toBe('content-changed');

    // New row exists with the new maple_id and a live fileinfo entry.
    const newRow = await coll.findOne({ maple_id: newHashed.maple_id });
    expect(newRow).not.toBeNull();
    expect(newRow!.maple_id).toBe(newHashed.maple_id);
    expect(newRow!.fileinfo).toHaveLength(1);
    expect((newRow!.fileinfo![0] as any).filename).toBe('shifty.jpg');
    expect((newRow!.fileinfo![0] as any).deleted_at ?? null).toBeNull();

    await coll.deleteMany({ maple_id: { $in: [oldHashed.maple_id, newHashed.maple_id] } });
    await foldersColl.deleteOne({ _id: folderId });
    await rm(root, { recursive: true, force: true });
  });

  it('legacy row without sha1_head ADOPTS the hash on re-discover — never orphaned (#2171)', async () => {
    if (!mongoReachable) return;

    // A row that predates content hashing has NO sha1_head. Re-discovering its
    // (present, unchanged) file used to satisfy `sha1_head !== hashed.sha1_head`
    // (undefined ≠ hash), dual-flagging the entry deleted_at+missing_since and
    // inserting a duplicate row — every sweep generation, forever. The guard
    // must instead adopt the computed hash onto the legacy row and treat the
    // event as an idempotent re-discover.
    const { handleEvent } = await import('./index.ts');
    const { assetsCollection, foldersCollection } = await import('../../db/client.ts');

    const root = await mkdtemp(path.join(os.tmpdir(), 'discover-legacy-'));
    const file = path.join(root, 'legacy.jpg');
    await writeFile(file, Buffer.alloc(80 * 1024, 0x42));

    const foldersColl = await foldersCollection();
    const folderId = (
      await foldersColl.insertOne({
        path: root,
        label: 'legacy-adopt',
        last_scan: null,
        file_count: 0,
        created_at: new Date().toISOString(),
      } as never)
    ).insertedId;
    const coll = await assetsCollection();
    const { hashFileForId } = await import('../../indexer/id.ts');
    const hashed = await hashFileForId(file);
    await coll.deleteMany({ maple_id: { $in: ['legacy-primary-id', hashed.maple_id] } });

    // Legacy row: upgraded/primary-form maple_id, NO sha1_head field at all.
    await coll.insertOne({
      maple_id: 'legacy-primary-id',
      fileinfo: [{ library_id: folderId, path: '', filename: 'legacy.jpg', deleted_at: null }],
      deleted_at: null,
      live_location_count: 1,
    } as never);

    await handleEvent({ kind: 'created', absPath: file }, folderId, root);

    // No duplicate row inserted — the legacy row absorbed the event.
    expect(await coll.countDocuments({ 'fileinfo.filename': 'legacy.jpg' })).toBe(1);
    const row = await coll.findOne({ maple_id: 'legacy-primary-id' });
    expect(row).not.toBeNull();
    // Hash adopted in place.
    expect(row!.sha1_head).toBe(hashed.sha1_head);
    // Entry stays fully live — no orphan flags.
    const entry = (row!.fileinfo ?? [])[0] as {
      deleted_at?: string | null;
      missing_since?: string | null;
    };
    expect(entry.deleted_at ?? null).toBeNull();
    expect(entry.missing_since ?? null).toBeNull();

    await coll.deleteMany({ maple_id: 'legacy-primary-id' });
    await foldersColl.deleteOne({ _id: folderId });
    await rm(root, { recursive: true, force: true });
  });

  it('concurrent dedup-append: race-loser becomes a silent no-op', async () => {
    if (!mongoReachable) return;

    // Two worker calls process the SAME event simultaneously. Both read
    // the existing row, both see dupIdx === -1 against the same stale
    // snapshot, both attempt to $push the same fileinfo entry. The
    // conditional $push (filter: no entry already matches) must ensure
    // exactly one append wins — the other becomes a no-op (modifiedCount
    // === 0). Fileinfo length stays at exactly 2 (the existing entry +
    // the one new one), not 3.
    const { handleEvent } = await import('./index.ts');
    const { assetsCollection, foldersCollection } = await import('../../db/client.ts');
    const { mkdir } = await import('node:fs/promises');

    const root = await mkdtemp(path.join(os.tmpdir(), 'discover-race-'));
    const dirA = path.join(root, 'a');
    const dirB = path.join(root, 'b');
    await mkdir(dirA, { recursive: true });
    await mkdir(dirB, { recursive: true });
    const fileA = path.join(dirA, 'IMG.dng');
    const fileB = path.join(dirB, 'IMG.dng');
    const bytes = Buffer.alloc(70 * 1024, 0x77);
    await writeFile(fileA, bytes);
    await writeFile(fileB, bytes);

    const foldersColl = await foldersCollection();
    const folderResult = await foldersColl.insertOne({
      path: root,
      label: 'race-test',
      last_scan: null,
      file_count: 0,
      created_at: new Date().toISOString(),
    } as never);
    const folderId = folderResult.insertedId;
    const coll = await assetsCollection();
    const { hashFileForId } = await import('../../indexer/id.ts');
    const { maple_id } = await hashFileForId(fileA);
    await coll.deleteMany({ maple_id });

    // First event lands the row with fileinfo[fileA].
    await handleEvent({ kind: 'created', absPath: fileA }, folderId, root);

    // Two concurrent appends for fileB — race them so both see dupIdx === -1.
    await Promise.all([
      handleEvent({ kind: 'created', absPath: fileB }, folderId, root),
      handleEvent({ kind: 'created', absPath: fileB }, folderId, root),
    ]);

    const rows = await coll.find({ maple_id }).toArray();
    expect(rows).toHaveLength(1);
    const entries = (rows[0]!.fileinfo ?? []).map((e: any) => `${e.path}/${e.filename}`).sort();
    expect(entries).toEqual(['a/IMG.dng', 'b/IMG.dng']);

    await coll.deleteMany({ maple_id });
    await foldersColl.deleteOne({ _id: folderId });
    await rm(root, { recursive: true, force: true });
  });

  it('dedups by sha1_head when the existing row has been upgraded to a primary maple_id', async () => {
    if (!mongoReachable) return;

    // The exif stage upgrades a row's maple_id from the discover-time
    // fallback form to the primary form once captured_at is available.
    // A duplicate file discovered AFTER that upgrade can no longer
    // match the existing row by maple_id alone — the lookup would miss
    // and we'd insert a second row that the exif stage later tries to
    // upgrade into the same primary id, hitting E11000 and ending up
    // dead-lettered. The sha1_head fallback lookup is what keeps the
    // duplicate dedup'd into the canonical row.
    const { handleEvent } = await import('./index.ts');
    const { assetsCollection, foldersCollection } = await import('../../db/client.ts');
    const { mkdir } = await import('node:fs/promises');

    const root = await mkdtemp(path.join(os.tmpdir(), 'discover-sha1-'));
    const dirA = path.join(root, 'a');
    const dirB = path.join(root, 'b');
    await mkdir(dirA, { recursive: true });
    await mkdir(dirB, { recursive: true });
    const fileA = path.join(dirA, 'IMG.dng');
    const fileB = path.join(dirB, 'IMG.dng');
    const bytes = Buffer.alloc(70 * 1024, 0xcd);
    await writeFile(fileA, bytes);
    await writeFile(fileB, bytes);

    const foldersColl = await foldersCollection();
    const folderResult = await foldersColl.insertOne({
      path: root,
      label: 'sha1-fallback-test',
      last_scan: null,
      file_count: 0,
      created_at: new Date().toISOString(),
    } as never);
    const folderId = folderResult.insertedId;
    const coll = await assetsCollection();
    const { hashFileForId } = await import('../../indexer/id.ts');
    const { maple_id: fallbackId, sha1_head } = await hashFileForId(fileA);
    const upgradedId = `01${'f'.repeat(30)}`;
    await coll.deleteMany({
      $or: [{ maple_id: fallbackId }, { maple_id: upgradedId }, { sha1_head }],
    });

    // Discover fileA → row inserted with fallback id.
    await handleEvent({ kind: 'created', absPath: fileA }, folderId, root);
    // Simulate the exif stage upgrading the maple_id. sha1_head is
    // left untouched, mirroring the real upgrade in workers/stages/exif.ts.
    await coll.updateOne({ maple_id: fallbackId }, { $set: { maple_id: upgradedId } });
    // Discover fileB — must dedup into the existing row via sha1_head,
    // not insert a fresh row.
    await handleEvent({ kind: 'created', absPath: fileB }, folderId, root);

    const rowsByUpgraded = await coll.find({ maple_id: upgradedId }).toArray();
    expect(rowsByUpgraded).toHaveLength(1);
    expect(rowsByUpgraded[0]!.fileinfo).toHaveLength(2);
    const entries = (rowsByUpgraded[0]!.fileinfo ?? [])
      .map((e: any) => `${e.path}/${e.filename}`)
      .sort();
    expect(entries).toEqual(['a/IMG.dng', 'b/IMG.dng']);
    // No row was inserted with the fallback id (the dedup hit caught it).
    const rowsByFallback = await coll.find({ maple_id: fallbackId }).toArray();
    expect(rowsByFallback).toHaveLength(0);

    await coll.deleteMany({ sha1_head });
    await foldersColl.deleteOne({ _id: folderId });
    await rm(root, { recursive: true, force: true });
  });

  it('insert path populates maple_id directly (no post-insert hash stage needed)', async () => {
    if (!mongoReachable) return;

    const { handleEvent } = await import('./index.ts');
    const { assetsCollection, foldersCollection } = await import('../../db/client.ts');

    const root = await mkdtemp(path.join(os.tmpdir(), 'discover-mid-'));
    const file = path.join(root, 'y.jpg');
    await writeFile(file, Buffer.alloc(50 * 1024, 0xef));

    const foldersColl = await foldersCollection();
    const folderResult = await foldersColl.insertOne({
      path: root,
      label: 'maple-id-test',
      last_scan: null,
      file_count: 0,
      created_at: new Date().toISOString(),
    } as never);
    const folderId = folderResult.insertedId;
    const coll = await assetsCollection();
    const { hashFileForId } = await import('../../indexer/id.ts');
    const expected = await hashFileForId(file);
    await coll.deleteMany({ maple_id: expected.maple_id });

    await handleEvent({ kind: 'created', absPath: file }, folderId, root);

    const doc = await coll.findOne({ maple_id: expected.maple_id });
    expect(doc).not.toBeNull();
    expect(doc!.maple_id).toBe(expected.maple_id);
    expect((doc as any).sha1_head).toBe(expected.sha1_head);
    expect(doc!.size).toBe(expected.size);

    await coll.deleteMany({ maple_id: expected.maple_id });
    await foldersColl.deleteOne({ _id: folderId });
    await rm(root, { recursive: true, force: true });
  });

  it('modified file on a multi-location asset flags entry missing_since and deleted_at unconditionally', async () => {
    if (!mongoReachable) return;

    const { handleEvent } = await import('./index.ts');
    const { assetsCollection, foldersCollection } = await import('../../db/client.ts');
    const { runMissingReaperOnce } = await import('../missing-reaper.ts');

    const root = await mkdtemp(path.join(os.tmpdir(), 'discover-modmulti-'));
    const fileA = path.join(root, 'photoA.jpg');
    const fileB = path.join(root, 'photoB.jpg');

    // Both files have identical original bytes.
    const originalBytes = Buffer.alloc(64 * 1024, 0xaa);
    const newBytes = Buffer.alloc(64 * 1024, 0x55);

    await writeFile(fileA, originalBytes);
    await writeFile(fileB, originalBytes);

    const foldersColl = await foldersCollection();
    const folderId = (
      await foldersColl.insertOne({
        path: root,
        label: 'mod-multi-content',
        last_scan: null,
        file_count: 0,
        created_at: new Date().toISOString(),
      } as never)
    ).insertedId;

    const coll = await assetsCollection();
    const { hashFileForId } = await import('../../indexer/id.ts');
    const originalHashed = await hashFileForId(fileA);
    await coll.deleteMany({ maple_id: originalHashed.maple_id });

    // 1. Discover both files -> deduped onto a single row with 2 entries in fileinfo
    await handleEvent({ kind: 'created', absPath: fileA }, folderId, root);
    await handleEvent({ kind: 'created', absPath: fileB }, folderId, root);

    // Verify deduped row has 2 entries.
    const row = await coll.findOne({ maple_id: originalHashed.maple_id });
    expect(row).not.toBeNull();
    expect(row!.fileinfo).toHaveLength(2);

    // 2. Overwrite fileA with new content (modified-content guard trigger)
    await writeFile(fileA, newBytes);
    await handleEvent({ kind: 'modified', absPath: fileA }, folderId, root);

    // Old row (with originalHashed.maple_id) must still carry the fileA entry,
    // but now it has BOTH deleted_at AND missing_since set to a string.
    const updatedRow = await coll.findOne({ maple_id: originalHashed.maple_id });
    expect(updatedRow).not.toBeNull();
    const fileAEntry = updatedRow!.fileinfo!.find((e: any) => e.filename === 'photoA.jpg');
    expect(fileAEntry).toBeDefined();
    expect(typeof fileAEntry!.deleted_at).toBe('string');
    expect(typeof fileAEntry!.missing_since).toBe('string');

    // 3. Run missing-reaper with an immediate deleteBeforeIso to bypass the cooldown.
    const deleteBeforeIso = new Date(Date.now() + 60_000).toISOString(); // future timestamp so cooldown is satisfied
    await runMissingReaperOnce({
      batchSize: 10,
      deleteBeforeIso,
      allowDelete: true,
    });

    // Old row should still exist (photoB keeps it live), but photoA entry must be pruned/pulled.
    const reapedRow = await coll.findOne({ maple_id: originalHashed.maple_id });
    expect(reapedRow).not.toBeNull();
    expect(reapedRow!.fileinfo).toHaveLength(1);
    expect(reapedRow!.fileinfo![0].filename).toBe('photoB.jpg');

    // Clean up.
    const newHashed = await hashFileForId(fileA);
    await coll.deleteMany({ maple_id: { $in: [originalHashed.maple_id, newHashed.maple_id] } });
    await foldersColl.deleteOne({ _id: folderId });
    await rm(root, { recursive: true, force: true });
  });
});
