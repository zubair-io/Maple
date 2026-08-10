/**
 * External-rename reconciliation (#2655) — integration coverage through the
 * real sweeper `visitDirectory` + the real `handleEvent`, against real Mongo
 * and real files in a temp directory. No mocking of the sidecar layer: every
 * assertion reads the actual `.xmp` file back off disk.
 *
 * Requires: MAPLE_MONGO_URI (or a local MongoDB on localhost:27017).
 * Skips gracefully when Mongo is unreachable.
 */
import { describe, expect, it, beforeAll, afterAll, afterEach, spyOn } from 'bun:test';
import { mkdtemp, writeFile, rm, readFile, stat } from 'node:fs/promises';
import type { MongoClient } from 'mongodb';
import { type Db, ObjectId } from 'mongodb';
import * as os from 'node:os';
import * as path from 'node:path';
import { tryConnect } from './_test-helpers.ts';
import { readExif } from '../../indexer/exif.ts';
import * as exifModule from '../../indexer/exif.ts';
import { reconcileRenamesInDirectory, type MissingFileCandidate } from './rename-reconcile.ts';
import type { Collection } from 'mongodb';
import type { AssetDoc } from '../../db/schema.ts';

const TEST_DB = `maple_test_rename_reconcile_${process.pid}`;
process.env.MAPLE_MONGO_DB = TEST_DB;

let mongo: MongoClient | null = null;
let mongoReachable = false;
let db: Db | null = null;

beforeAll(async () => {
  mongo = await tryConnect();
  mongoReachable = mongo !== null;
  if (!mongoReachable) {
    console.log('[rename-reconcile.test] skipping: MongoDB unreachable');
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

// Each test builds its own isolated temp directory but shares the one
// `assets` collection — wipe it between tests so one test's rows can never
// leak into another's fingerprint-matching pool.
afterEach(async () => {
  if (!mongoReachable || !db) return;
  await db.collection('assets').deleteMany({});
});

// ---------------------------------------------------------------------------
// A minimal hand-built big-endian TIFF, EXIF SubIFD included, so `readExif`
// (`exifr` under the hood) can pull DateTimeOriginal + SerialNumber out of a
// plain `.dng` without a real RAW decoder. Used as the whole file body — DNG
// is TIFF-based, and exifr sniffs content, not the extension.
// ---------------------------------------------------------------------------

function writeEntry(
  buf: Buffer,
  entryOff: number,
  id: number,
  type: number,
  count: number,
  value: number,
): void {
  buf.writeUInt16BE(id, entryOff);
  buf.writeUInt16BE(type, entryOff + 2);
  buf.writeUInt32BE(count, entryOff + 4);
  buf.writeUInt32BE(value, entryOff + 8);
}

/** Builds a TIFF with `Make` in IFD0 and `DateTimeOriginal`/`SerialNumber` in
 * the EXIF SubIFD (reached via the `0x8769` pointer tag) — exifr only reads
 * capture-time/serial tags from the SubIFD, not from IFD0 directly. */
function makeExifTiff(opts: { captureDate: string; serial?: string }): Buffer {
  const header = Buffer.alloc(8);
  header.write('MM', 0, 'latin1');
  header.writeUInt16BE(0x002a, 2);
  header.writeUInt32BE(8, 4);

  const makeVal = Buffer.from('TestCam\0', 'latin1');
  const ifd0N = 2;
  const ifd0Size = 2 + 12 * ifd0N + 4;
  const ifd0Start = 8;
  const makeDataOffset = ifd0Start + ifd0Size;
  const exifIfdStart = makeDataOffset + makeVal.length;

  const exifFields: Array<{ id: number; value: string }> = [
    { id: 0x9003, value: opts.captureDate },
  ];
  if (opts.serial !== undefined) exifFields.push({ id: 0xa431, value: opts.serial });

  const exifN = exifFields.length;
  const exifIfdSize = 2 + 12 * exifN + 4;
  let exifDataOffset = exifIfdStart + exifIfdSize;
  const exifValBufs = exifFields.map((f) => Buffer.from(f.value + '\0', 'latin1'));
  const exifValOffsets = exifValBufs.map((v) => {
    const off = exifDataOffset;
    exifDataOffset += v.length;
    return off;
  });

  const ifd0 = Buffer.alloc(ifd0Size);
  ifd0.writeUInt16BE(ifd0N, 0);
  writeEntry(ifd0, 2, 0x010f, 2, makeVal.length, makeDataOffset);
  writeEntry(ifd0, 14, 0x8769, 4, 1, exifIfdStart);
  ifd0.writeUInt32BE(0, 2 + ifd0N * 12);

  const exifIfd = Buffer.alloc(exifIfdSize);
  exifIfd.writeUInt16BE(exifN, 0);
  exifFields.forEach((f, i) => {
    writeEntry(exifIfd, 2 + i * 12, f.id, 2, exifValBufs[i]!.length, exifValOffsets[i]!);
  });
  exifIfd.writeUInt32BE(0, 2 + exifN * 12);

  return Buffer.concat([header, ifd0, makeVal, exifIfd, ...exifValBufs]);
}

async function sweepOnce(root: string, folderId: ObjectId): Promise<void> {
  const { visitDirectory } = await import('./sweeper.ts');
  const frontier = await import('./frontier.repo.ts');
  const { handleEvent } = await import('./handle-event.ts');
  await frontier.seedRoot(folderId, root, 1);
  const dir = await frontier.claimNextDir(folderId, 1, 60_000);
  await visitDirectory(dir!, root, { handleEvent, folderId });
}

// `AssetDoc` doesn't type its Mongo-only `stages` subdocument (a pre-existing
// gap shared by `library/relocate-asset.test.ts`), and this file's assertions
// want a non-optional `fileinfo[0]` rather than fighting
// `noUncheckedIndexedAccess` at every call site — a narrow local row shape,
// cast at the read boundary, matches that sibling test file's pattern.
interface AssetRow {
  _id: ObjectId;
  maple_id?: string;
  fileinfo: Array<{ path: string; filename: string; missing_since?: string | null }>;
  rating: number;
  flag: number;
  color_label: string;
  stages: Record<string, { version: number }>;
}

async function fetchRow(coll: Collection<AssetDoc>, id: ObjectId): Promise<AssetRow | null> {
  return (await coll.findOne({ _id: id })) as unknown as AssetRow | null;
}

describe('rename reconciliation (#2655)', () => {
  it('reconciles a same-folder rename: sidecar follows, DB row repoints, edits + maple_id survive, cache stages bump', async () => {
    if (!mongoReachable) return;
    const { assetsCollection } = await import('../../db/client.ts');

    const root = await mkdtemp(path.join(os.tmpdir(), 'maple-rename-'));
    const oldName = 'IMG_0001.dng';
    const newName = 'vacation-final.dng';
    const oldAbs = path.join(root, oldName);
    const bytes = makeExifTiff({ captureDate: '2024:06:01 12:00:00', serial: 'CAM-A-001' });
    await writeFile(oldAbs, bytes);

    // Index it first (a real discover pass), giving it edits + a real sidecar.
    const folderId = new ObjectId();
    await sweepOnce(root, folderId);

    const coll = await assetsCollection();
    const indexed = await coll.findOne({ 'fileinfo.filename': oldName });
    expect(indexed).not.toBeNull();
    const mapleId = indexed!.maple_id;
    // Simulate the `exif` stage having already run (it's a separate async
    // worker this test never starts) — the reconcile fingerprint's
    // captured-at/serial come from THIS field, exactly as they would in
    // production once the pipeline reaches the row.
    const exif = await readExif(oldAbs);
    await coll.updateOne(
      { _id: indexed!._id },
      {
        $set: {
          exif,
          rating: 4,
          flag: 1,
          color_label: 'red',
          'stages.thumb.version': 3,
          'stages.preview.version': 3,
        },
      },
    );
    const oldSidecar = path.join(root, 'IMG_0001.xmp');
    await writeFile(oldSidecar, '<xmp>edited</xmp>');
    await coll.updateOne({ _id: indexed!._id }, { $set: { has_xmp: true } });

    // Externally rename the file (and NOT the sidecar — Finder doesn't know
    // to) outside Maple, then rescan.
    await rm(oldAbs);
    await writeFile(path.join(root, newName), bytes);

    // Fresh frontier generation (gen-1's frontier row was already consumed
    // by the first sweep above) — reseed under the SAME folderId and sweep
    // again to simulate the rescan that discovers the external rename.
    const frontier = await import('./frontier.repo.ts');
    const { handleEvent } = await import('./handle-event.ts');
    const { visitDirectory } = await import('./sweeper.ts');
    await frontier.seedRoot(folderId, root, 2);
    const dir2 = await frontier.claimNextDir(folderId, 2, 60_000);
    await visitDirectory(dir2!, root, { handleEvent, folderId });

    const after = await fetchRow(coll, indexed!._id);
    expect(after).not.toBeNull();
    expect(after!.maple_id).toBe(mapleId);
    expect(after!.fileinfo[0]!.filename).toBe(newName);
    expect(after!.fileinfo[0]!.path).toBe('');
    expect(after!.fileinfo[0]!.missing_since ?? null).toBeNull();
    expect(after!.rating).toBe(4);
    expect(after!.flag).toBe(1);
    expect(after!.color_label).toBe('red');
    expect(after!.stages.thumb!.version).toBe(0);
    expect(after!.stages.preview!.version).toBe(0);

    // No duplicate row was created for the "new" filename.
    const count = await coll.countDocuments({ maple_id: mapleId });
    expect(count).toBe(1);

    // Sidecar physically followed the rename.
    await expect(stat(oldSidecar)).rejects.toThrow();
    const newSidecar = path.join(root, 'vacation-final.xmp');
    expect(await readFile(newSidecar, 'utf8')).toBe('<xmp>edited</xmp>');

    await rm(root, { recursive: true, force: true });
  });

  it('declines when two candidates share a fingerprint (ambiguous — logs and leaves both unmerged)', async () => {
    if (!mongoReachable) return;
    const { assetsCollection } = await import('../../db/client.ts');

    const root = await mkdtemp(path.join(os.tmpdir(), 'maple-rename-ambig-'));
    const bytes = makeExifTiff({ captureDate: '2024:07:04 09:00:00', serial: 'CAM-DUP' });
    const folderId = new ObjectId();

    const coll = await assetsCollection();
    // Two DISTINCT already-indexed rows (as if two genuinely different
    // photos, previously indexed under two different filenames) that
    // happen to share the SAME fingerprint — size + capture time + serial.
    // Both then go missing in this sweep, and two new same-fingerprint
    // files appear: the ambiguity the false-positive guard must catch.
    const now = new Date().toISOString();
    const missingIds = [new ObjectId(), new ObjectId()];
    await coll.insertMany([
      {
        _id: missingIds[0],
        maple_id: 'amb-missing-1',
        fileinfo: [{ library_id: folderId, path: '', filename: 'gone-1.dng' }],
        size: bytes.length,
        exif: { captured_at: '2024-07-04T09:00:00.000Z', camera_serial: 'CAM-DUP' },
        rating: 0,
        flag: 0,
        color_label: '',
        deleted_at: null,
        indexed_at: now,
        stages: {},
      },
      {
        _id: missingIds[1],
        maple_id: 'amb-missing-2',
        fileinfo: [{ library_id: folderId, path: '', filename: 'gone-2.dng' }],
        size: bytes.length,
        exif: { captured_at: '2024-07-04T09:00:00.000Z', camera_serial: 'CAM-DUP' },
        rating: 0,
        flag: 0,
        color_label: '',
        deleted_at: null,
        indexed_at: now,
        stages: {},
      },
    ] as never);
    // Two NEW files sharing the same fingerprint as both missing rows.
    // Neither "gone-1.dng" nor "gone-2.dng" was ever written to `root` — the
    // rows above are purely DB-side, so both read as genuinely absent.
    await writeFile(path.join(root, 'new-1.dng'), bytes);
    await writeFile(path.join(root, 'new-2.dng'), bytes);

    const frontier = await import('./frontier.repo.ts');
    const { handleEvent } = await import('./handle-event.ts');
    const { visitDirectory } = await import('./sweeper.ts');
    await frontier.seedRoot(folderId, root, 5);
    const dir = await frontier.claimNextDir(folderId, 5, 60_000);
    await visitDirectory(dir!, root, { handleEvent, folderId });

    // Declined: neither missing row was repointed to either new filename.
    const missing1 = await fetchRow(coll, missingIds[0]!);
    const missing2 = await fetchRow(coll, missingIds[1]!);
    expect(missing1!.fileinfo[0]!.filename).toBe('gone-1.dng');
    expect(missing1!.fileinfo[0]!.missing_since).not.toBeNull();
    expect(missing2!.fileinfo[0]!.filename).toBe('gone-2.dng');
    expect(missing2!.fileinfo[0]!.missing_since).not.toBeNull();

    // Both new files were indexed as their own (separate, unedited) row —
    // content-hash dedup folds them onto ONE row (identical bytes), but
    // that row is distinct from both original "missing" rows.
    const afterCount = await coll.countDocuments({});
    expect(afterCount).toBe(3); // 2 declined-missing rows + 1 for the new content

    await rm(root, { recursive: true, force: true });
  });

  it('false positive: same size, different DateTimeOriginal/serial never merges', async () => {
    if (!mongoReachable) return;
    const { assetsCollection } = await import('../../db/client.ts');

    const root = await mkdtemp(path.join(os.tmpdir(), 'maple-rename-fp-'));
    const oldBytes = makeExifTiff({ captureDate: '2024:01:01 08:00:00', serial: 'CAM-X' });
    const oldAbs = path.join(root, 'photo-old.dng');
    await writeFile(oldAbs, oldBytes);

    const folderId = new ObjectId();
    await sweepOnce(root, folderId);

    const coll = await assetsCollection();
    const indexed = await coll.findOne({ 'fileinfo.filename': 'photo-old.dng' });
    expect(indexed).not.toBeNull();
    // Same rationale as the reconcile-success test: populate `exif` the way
    // the (here, unstarted) exif stage would have by the time a rescan runs.
    await coll.updateOne({ _id: indexed!._id }, { $set: { exif: await readExif(oldAbs) } });

    await rm(oldAbs);
    // A genuinely DIFFERENT photo, padded to the exact same byte length as
    // `oldBytes`, but with a different capture date AND a different serial —
    // the false-positive case the fingerprint must not merge.
    const newBytesRaw = makeExifTiff({ captureDate: '2025:12:25 18:30:00', serial: 'CAM-Y' });
    const newBytes =
      newBytesRaw.length === oldBytes.length
        ? newBytesRaw
        : newBytesRaw.length < oldBytes.length
          ? Buffer.concat([newBytesRaw, Buffer.alloc(oldBytes.length - newBytesRaw.length)])
          : newBytesRaw.subarray(0, oldBytes.length);
    expect(newBytes.length).toBe(oldBytes.length);
    await writeFile(path.join(root, 'photo-new.dng'), newBytes);

    const frontier = await import('./frontier.repo.ts');
    const { handleEvent } = await import('./handle-event.ts');
    const { visitDirectory } = await import('./sweeper.ts');
    await frontier.seedRoot(folderId, root, 2);
    const dir = await frontier.claimNextDir(folderId, 2, 60_000);
    await visitDirectory(dir!, root, { handleEvent, folderId });

    const oldRow = await fetchRow(coll, indexed!._id);
    expect(oldRow!.fileinfo[0]!.filename).toBe('photo-old.dng');
    expect(oldRow!.fileinfo[0]!.missing_since).not.toBeNull();

    const newRow = await coll.findOne({ 'fileinfo.filename': 'photo-new.dng' });
    expect(newRow).not.toBeNull();
    expect(newRow!._id.toString()).not.toBe(indexed!._id.toString());

    await rm(root, { recursive: true, force: true });
  });

  it('declines when the fileinfo entry changed concurrently between discovery and repoint (sidecar left untouched)', async () => {
    if (!mongoReachable) return;
    const { assetsCollection } = await import('../../db/client.ts');

    const root = await mkdtemp(path.join(os.tmpdir(), 'maple-rename-race-'));
    const folderId = new ObjectId();
    const bytes = makeExifTiff({ captureDate: '2024:03:03 10:00:00', serial: 'CAM-RACE' });

    // The row's REAL current fileinfo entry — filename 'actual-current.dng'.
    // This stands in for a concurrent writer (another sweeper worker, a
    // manual rename route call, a dedupe move) having already changed this
    // exact entry after the sweeper's `find()` snapshotted it but before
    // reconciliation runs its repoint write.
    const coll = await assetsCollection();
    const docId = new ObjectId();
    await coll.insertOne({
      _id: docId,
      maple_id: 'race-1',
      fileinfo: [{ library_id: folderId, path: '', filename: 'actual-current.dng' }],
      size: bytes.length,
      exif: { captured_at: '2024-03-03T10:00:00.000Z', camera_serial: 'CAM-RACE' },
      rating: 0,
      flag: 0,
      color_label: '',
      deleted_at: null,
      indexed_at: new Date().toISOString(),
      stages: {},
    } as never);

    // A real sidecar sitting next to the STALE (pre-race) path the
    // candidate below still believes is current.
    const staleAbsPath = path.join(root, 'stale-snapshot.dng');
    const staleSidecar = path.join(root, 'stale-snapshot.xmp');
    await writeFile(staleSidecar, '<xmp>never touched</xmp>');

    const freshAbsPath = path.join(root, 'new-name.dng');
    await writeFile(freshAbsPath, bytes);

    const staleCandidate: MissingFileCandidate = {
      docId,
      // Deliberately mismatched vs. what's actually in Mongo right now —
      // the query's elemMatch (library_id/path/filename/deleted_at:null)
      // can never match, so the repoint must decline.
      fileinfo: { library_id: folderId, path: '', filename: 'stale-snapshot.dng' },
      filename: 'stale-snapshot.dng',
      absPath: staleAbsPath,
      size: bytes.length,
      exif: { captured_at: '2024-03-03T10:00:00.000Z', camera_serial: 'CAM-RACE' } as never,
    };

    const result = await reconcileRenamesInDirectory(
      [{ filename: 'new-name.dng', absPath: freshAbsPath }],
      [staleCandidate],
      root,
      folderId,
    );

    expect(result.reconciledMissingFilenames.size).toBe(0);
    expect(result.reconciledNewFilenames.size).toBe(0);

    // Row untouched: still the REAL current entry, not repointed to either
    // the stale candidate's belief or the fresh filename.
    const row = await fetchRow(coll, docId);
    expect(row!.fileinfo[0]!.filename).toBe('actual-current.dng');

    // Sidecar never moved — repoint-first ordering means the sidecar move
    // is never even attempted once the repoint itself declines.
    expect(await readFile(staleSidecar, 'utf8')).toBe('<xmp>never touched</xmp>');
    const wouldBeNewSidecar = path.join(root, 'new-name.xmp');
    await expect(stat(wouldBeNewSidecar)).rejects.toThrow();

    await rm(root, { recursive: true, force: true });
  });

  it('short-circuits before readExif for a new file whose size matches no missing candidate', async () => {
    if (!mongoReachable) return;
    const { assetsCollection } = await import('../../db/client.ts');

    const root = await mkdtemp(path.join(os.tmpdir(), 'maple-rename-sizecheck-'));
    const folderId = new ObjectId();
    const missingBytes = makeExifTiff({ captureDate: '2024:05:05 11:00:00', serial: 'CAM-SIZE' });

    const coll = await assetsCollection();
    const docId = new ObjectId();
    await coll.insertOne({
      _id: docId,
      maple_id: 'size-1',
      fileinfo: [{ library_id: folderId, path: '', filename: 'gone.dng' }],
      size: missingBytes.length,
      exif: { captured_at: '2024-05-05T11:00:00.000Z', camera_serial: 'CAM-SIZE' },
      rating: 0,
      flag: 0,
      color_label: '',
      deleted_at: null,
      indexed_at: new Date().toISOString(),
      stages: {},
    } as never);

    const matchingAbsPath = path.join(root, 'matches-size.dng');
    await writeFile(matchingAbsPath, missingBytes);
    // A wrong-size file — same directory, but its byte length can never
    // equal the one missing candidate's size, so the fingerprint's cheap
    // first key already rules it out before any EXIF parse.
    const wrongSizeAbsPath = path.join(root, 'wrong-size.dng');
    await writeFile(
      wrongSizeAbsPath,
      Buffer.concat([missingBytes, Buffer.from('extra-tail-bytes')]),
    );

    const readCalls: string[] = [];
    const spy = spyOn(exifModule, 'readExif').mockImplementation(async (absPath: string) => {
      readCalls.push(absPath);
      return readExif(absPath);
    });
    try {
      const missingCandidate: MissingFileCandidate = {
        docId,
        fileinfo: { library_id: folderId, path: '', filename: 'gone.dng' },
        filename: 'gone.dng',
        absPath: path.join(root, 'gone.dng'),
        size: missingBytes.length,
        exif: { captured_at: '2024-05-05T11:00:00.000Z', camera_serial: 'CAM-SIZE' } as never,
      };
      await reconcileRenamesInDirectory(
        [
          { filename: 'matches-size.dng', absPath: matchingAbsPath },
          { filename: 'wrong-size.dng', absPath: wrongSizeAbsPath },
        ],
        [missingCandidate],
        root,
        folderId,
      );
    } finally {
      spy.mockRestore();
    }

    expect(readCalls).toContain(matchingAbsPath);
    expect(readCalls).not.toContain(wrongSizeAbsPath);

    await rm(root, { recursive: true, force: true });
  });
});
