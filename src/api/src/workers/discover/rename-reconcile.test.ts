/**
 * External-rename reconciliation (#2655) — integration coverage through the
 * real sweep and the real event handler, against real files in a temp
 * directory. No mocking of the sidecar layer: every assertion reads the actual
 * `.xmp` file back off disk.
 *
 * The property under test is that a file renamed OUTSIDE Maple between two
 * rescans keeps its edits and its sidecar, instead of reading as one asset
 * vanishing and an unrelated one appearing. The guard against getting that
 * wrong is structural: candidates are bucketed by a cheap fingerprint and a
 * bucket with more than one member on either side is declined outright, so an
 * ambiguous pair falls through to the ordinary created/removed handling rather
 * than attaching one photo's history to another.
 */
import { describe, expect, it, spyOn } from 'bun:test';
import { writeFile, rm, readFile, stat } from 'node:fs/promises';
import { ObjectId } from '../../db/object-id.ts';
import * as path from 'node:path';
import { newObjectIdHex } from '../../db/object-id.ts';
import { readExif } from '../../indexer/exif.ts';
import * as exifModule from '../../indexer/exif.ts';
import { reconcileRenamesInDirectory, type MissingFileCandidate } from './rename-reconcile.ts';
import {
  allAssets,
  assetIdAt,
  assetRow,
  createDiscoverLibrary,
  locationsOf,
  seedAsset,
  seedLocation,
  stageRow,
  type DiscoverLibrary,
} from './discover.test-helpers.ts';

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

/** One sweep generation over the library root. */
async function sweepOnce(library: DiscoverLibrary, gen: number): Promise<void> {
  const frontier = await import('./frontier.repo.ts');
  const { handleEvent } = await import('./handle-event.ts');
  const { visitDirectory } = await import('./sweeper.ts');
  await frontier.seedRoot(library.folderId, library.root, gen);
  const dir = await frontier.claimNextDir(library.folderId, gen, 60_000);
  expect(dir).not.toBeNull();
  await visitDirectory(dir!, library.root, { handleEvent, folderId: library.folderId });
}

/** The one location of an asset, which every assertion below reads. */
function onlyLocation(library: DiscoverLibrary, id: string) {
  const rows = locationsOf(library.db, id);
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

describe('rename reconciliation (#2655)', () => {
  it('reconciles a same-folder rename: sidecar follows, row repoints, edits survive', async () => {
    using library = await createDiscoverLibrary('maple-rename-');
    const oldName = 'IMG_0001.dng';
    const newName = 'vacation-final.dng';
    const oldAbs = path.join(library.root, oldName);
    const bytes = makeExifTiff({ captureDate: '2024:06:01 12:00:00', serial: 'CAM-A-001' });
    await writeFile(oldAbs, bytes);

    // Index it first (a real discover pass), then give it edits and a sidecar.
    await sweepOnce(library, 1);
    const id = assetIdAt(library.db, '', oldName);
    expect(id).not.toBeNull();
    const mapleId = assetRow(library.db, id!)!.maple_id;

    // Stand in for the exif stage having already run — it is a separate async
    // worker this test never starts, and the reconcile fingerprint's capture
    // time and serial come from exactly this field.
    library.db.run(
      `UPDATE assets SET exif = json(?), rating = 4, flag = 1, color_label = 'red', has_xmp = 1
        WHERE id = ?`,
      [JSON.stringify(await readExif(oldAbs)), id!],
    );
    library.db.run(
      `UPDATE stage_state SET version = 3 WHERE asset_id = ? AND stage IN ('thumb', 'preview')`,
      [id!],
    );
    const oldSidecar = path.join(library.root, 'IMG_0001.xmp');
    await writeFile(oldSidecar, '<xmp>edited</xmp>');

    // Rename the file outside Maple — and NOT the sidecar, which Finder does
    // not know to move — then rescan under a fresh generation.
    await rm(oldAbs);
    await writeFile(path.join(library.root, newName), bytes);
    await sweepOnce(library, 2);

    expect(assetRow(library.db, id!)!.maple_id).toBe(mapleId);
    const location = onlyLocation(library, id!);
    expect(location.filename).toBe(newName);
    expect(location.path).toBe('');
    expect(location.missing_since).toBeNull();

    const edits = library.db
      .query(`SELECT rating, flag, color_label FROM assets WHERE id = ?`)
      .get(id!) as { rating: number; flag: number; color_label: string };
    expect(edits).toEqual({ rating: 4, flag: 1, color_label: 'red' });
    // The path-keyed caches were dropped with the move, so both re-arm.
    expect(stageRow(library.db, id!, 'thumb')!.version).toBe(0);
    expect(stageRow(library.db, id!, 'preview')!.version).toBe(0);

    // No second row was created for the "new" filename.
    expect(allAssets(library.db)).toHaveLength(1);

    // The sidecar physically followed the rename.
    await expect(stat(oldSidecar)).rejects.toThrow();
    const newSidecar = path.join(library.root, 'vacation-final.xmp');
    expect(await readFile(newSidecar, 'utf8')).toBe('<xmp>edited</xmp>');
  });

  it('declines when two candidates share a fingerprint, leaving both unmerged', async () => {
    using library = await createDiscoverLibrary('maple-rename-ambig-');
    const bytes = makeExifTiff({ captureDate: '2024:07:04 09:00:00', serial: 'CAM-DUP' });
    const exif = { captured_at: '2024-07-04T09:00:00.000Z', camera_serial: 'CAM-DUP' };

    // Two genuinely different photos, previously indexed under two filenames,
    // that happen to share a fingerprint — size, capture time and serial. Both
    // go missing in this sweep while two same-fingerprint files appear: the
    // ambiguity the false-positive guard exists for. Neither old filename is
    // ever written to disk, so both read as genuinely absent.
    const missingIds = ['gone-1.dng', 'gone-2.dng'].map((filename, index) => {
      const id = seedAsset(library.db, {
        id: newObjectIdHex(),
        mapleId: `amb-missing-${index + 1}`,
        size: bytes.length,
        exif,
      });
      seedLocation(library.db, {
        assetId: id,
        libraryId: library.folderId.toHexString(),
        filename,
      });
      return id;
    });
    await writeFile(path.join(library.root, 'new-1.dng'), bytes);
    await writeFile(path.join(library.root, 'new-2.dng'), bytes);

    await sweepOnce(library, 5);

    // Declined: neither missing row was repointed to either new filename.
    expect(onlyLocation(library, missingIds[0]!).filename).toBe('gone-1.dng');
    expect(onlyLocation(library, missingIds[0]!).missing_since).not.toBeNull();
    expect(onlyLocation(library, missingIds[1]!).filename).toBe('gone-2.dng');
    expect(onlyLocation(library, missingIds[1]!).missing_since).not.toBeNull();

    // Both new files were indexed as their own unedited asset — content dedup
    // folds them onto one row, distinct from both declined rows.
    expect(allAssets(library.db)).toHaveLength(3);
  });

  it('false positive: same size, different capture time and serial never merges', async () => {
    using library = await createDiscoverLibrary('maple-rename-fp-');
    const oldBytes = makeExifTiff({ captureDate: '2024:01:01 08:00:00', serial: 'CAM-X' });
    const oldAbs = path.join(library.root, 'photo-old.dng');
    await writeFile(oldAbs, oldBytes);

    await sweepOnce(library, 1);
    const oldId = assetIdAt(library.db, '', 'photo-old.dng');
    expect(oldId).not.toBeNull();
    // Same rationale as the reconcile-success test: populate the EXIF the way
    // the (here, unstarted) exif stage would have by the time a rescan runs.
    library.db.run(`UPDATE assets SET exif = json(?) WHERE id = ?`, [
      JSON.stringify(await readExif(oldAbs)),
      oldId!,
    ]);

    await rm(oldAbs);
    // A genuinely different photo padded to the exact same byte length, with a
    // different capture date AND serial — the case the fingerprint must not merge.
    const newBytesRaw = makeExifTiff({ captureDate: '2025:12:25 18:30:00', serial: 'CAM-Y' });
    const newBytes =
      newBytesRaw.length === oldBytes.length
        ? newBytesRaw
        : newBytesRaw.length < oldBytes.length
          ? Buffer.concat([newBytesRaw, Buffer.alloc(oldBytes.length - newBytesRaw.length)])
          : newBytesRaw.subarray(0, oldBytes.length);
    expect(newBytes.length).toBe(oldBytes.length);
    await writeFile(path.join(library.root, 'photo-new.dng'), newBytes);

    await sweepOnce(library, 2);

    expect(onlyLocation(library, oldId!).filename).toBe('photo-old.dng');
    expect(onlyLocation(library, oldId!).missing_since).not.toBeNull();
    const newId = assetIdAt(library.db, '', 'photo-new.dng');
    expect(newId).not.toBeNull();
    expect(newId).not.toBe(oldId);
  });

  it('declines when the location changed between discovery and repoint', async () => {
    using library = await createDiscoverLibrary('maple-rename-race-');
    const bytes = makeExifTiff({ captureDate: '2024:03:03 10:00:00', serial: 'CAM-RACE' });
    const exif = { captured_at: '2024-03-03T10:00:00.000Z', camera_serial: 'CAM-RACE' };

    // The row's real current location is `actual-current.dng`. That stands in
    // for a concurrent writer — another sweeper, a manual rename, a dedupe move
    // — having changed this exact location after the sweep snapshotted it but
    // before reconciliation runs its repoint.
    const docId = seedAsset(library.db, {
      id: newObjectIdHex(),
      mapleId: 'race-1',
      size: bytes.length,
      exif,
    });
    seedLocation(library.db, {
      assetId: docId,
      libraryId: library.folderId.toHexString(),
      filename: 'actual-current.dng',
    });

    // A real sidecar next to the stale path the candidate still believes in.
    const staleAbsPath = path.join(library.root, 'stale-snapshot.dng');
    const staleSidecar = path.join(library.root, 'stale-snapshot.xmp');
    await writeFile(staleSidecar, '<xmp>never touched</xmp>');
    const freshAbsPath = path.join(library.root, 'new-name.dng');
    await writeFile(freshAbsPath, bytes);

    const staleCandidate: MissingFileCandidate = {
      docId: new ObjectId(docId),
      // Deliberately mismatched against what the database holds right now, so
      // the repoint's own guard can never match and it must decline.
      fileinfo: { library_id: library.folderId, path: '', filename: 'stale-snapshot.dng' },
      filename: 'stale-snapshot.dng',
      absPath: staleAbsPath,
      size: bytes.length,
      exif: exif as never,
    };

    const result = await reconcileRenamesInDirectory(
      [{ filename: 'new-name.dng', absPath: freshAbsPath }],
      [staleCandidate],
      library.root,
      library.folderId,
    );

    expect(result.reconciledMissingFilenames.size).toBe(0);
    expect(result.reconciledNewFilenames.size).toBe(0);
    // Untouched: still the real current location, repointed to neither.
    expect(onlyLocation(library, docId).filename).toBe('actual-current.dng');

    // The sidecar never moved — repoint-first ordering means the move is not
    // even attempted once the repoint declines.
    expect(await readFile(staleSidecar, 'utf8')).toBe('<xmp>never touched</xmp>');
    await expect(stat(path.join(library.root, 'new-name.xmp'))).rejects.toThrow();
  });

  it('short-circuits before readExif for a new file whose size matches no candidate', async () => {
    using library = await createDiscoverLibrary('maple-rename-sizecheck-');
    const missingBytes = makeExifTiff({ captureDate: '2024:05:05 11:00:00', serial: 'CAM-SIZE' });
    const exif = { captured_at: '2024-05-05T11:00:00.000Z', camera_serial: 'CAM-SIZE' };

    const docId = seedAsset(library.db, {
      id: newObjectIdHex(),
      mapleId: 'size-1',
      size: missingBytes.length,
      exif,
    });
    seedLocation(library.db, {
      assetId: docId,
      libraryId: library.folderId.toHexString(),
      filename: 'gone.dng',
    });

    const matchingAbsPath = path.join(library.root, 'matches-size.dng');
    await writeFile(matchingAbsPath, missingBytes);
    // A wrong-size file in the same directory: its byte length can never equal
    // the one missing candidate's, so the fingerprint's cheap first key rules
    // it out before any EXIF parse.
    const wrongSizeAbsPath = path.join(library.root, 'wrong-size.dng');
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
        docId: new ObjectId(docId),
        fileinfo: { library_id: library.folderId, path: '', filename: 'gone.dng' },
        filename: 'gone.dng',
        absPath: path.join(library.root, 'gone.dng'),
        size: missingBytes.length,
        exif: exif as never,
      };
      await reconcileRenamesInDirectory(
        [
          { filename: 'matches-size.dng', absPath: matchingAbsPath },
          { filename: 'wrong-size.dng', absPath: wrongSizeAbsPath },
        ],
        [missingCandidate],
        library.root,
        library.folderId,
      );
    } finally {
      spy.mockRestore();
    }

    expect(readCalls).toContain(matchingAbsPath);
    expect(readCalls).not.toContain(wrongSizeAbsPath);
  });
});
