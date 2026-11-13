/** Fixtures shared by the rename-reconciliation suites. */
import { expect } from 'bun:test';
import { locationsOf, type DiscoverLibrary } from './discover.test-helpers.ts';

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
export function makeExifTiff(opts: { captureDate: string; serial?: string }): Buffer {
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
export async function sweepOnce(library: DiscoverLibrary, gen: number): Promise<void> {
  const frontier = await import('./frontier.repo.ts');
  const { handleEvent } = await import('./handle-event.ts');
  const { visitDirectory } = await import('./sweeper.ts');
  await frontier.seedRoot(library.folderId, library.root, gen);
  const dir = await frontier.claimNextDir(library.folderId, gen, 60_000);
  expect(dir).not.toBeNull();
  await visitDirectory(dir!, library.root, { handleEvent, folderId: library.folderId });
}

/** The one location of an asset, which every rename assertion reads. */
export function onlyLocation(library: DiscoverLibrary, id: string) {
  const rows = locationsOf(library.db, id);
  expect(rows).toHaveLength(1);
  return rows[0]!;
}
