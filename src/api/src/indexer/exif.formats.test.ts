import { describe, expect, it } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { readExif } from './exif.ts';

/** Minimal big-endian TIFF with a Make tag (shared with webp-exif.test). */
function makeTiff(make: string): Buffer {
  const value = Buffer.from(make + '\0', 'latin1');
  const header = Buffer.alloc(8);
  header.write('MM', 0, 'latin1');
  header.writeUInt16BE(0x002a, 2);
  header.writeUInt32BE(8, 4);
  const ifd = Buffer.alloc(2 + 12 + 4);
  ifd.writeUInt16BE(1, 0);
  ifd.writeUInt16BE(0x010f, 2);
  ifd.writeUInt16BE(2, 4);
  ifd.writeUInt32BE(value.length, 6);
  ifd.writeUInt32BE(8 + ifd.length, 10);
  ifd.writeUInt32BE(0, 14);
  return Buffer.concat([header, ifd, value]);
}

/**
 * Big-endian TIFF whose single Make tag stores its value at a large file
 * offset (`valueAt` bytes in), with the gap zero-padded. This mirrors the
 * real-world RAW/DNG layout that crashes exifr's chunked *file* reader:
 * IFD0 sits in the first chunk but the tag value lives far beyond it, so a
 * lazily-read path-based parse dereferences a chunk it never fetched
 * (`undefined is not an object (evaluating 'this.dataView.getUint16')`).
 * Feeding exifr the whole Buffer side-steps the chunked reader entirely.
 */
function makeTiffFarValue(make: string, valueAt: number): Buffer {
  const value = Buffer.from(make + '\0', 'latin1');
  const buf = Buffer.alloc(valueAt + value.length);
  buf.write('MM', 0, 'latin1');
  buf.writeUInt16BE(0x002a, 2);
  buf.writeUInt32BE(8, 4); // IFD0 at offset 8
  buf.writeUInt16BE(1, 8); // one entry
  buf.writeUInt16BE(0x010f, 10); // Make
  buf.writeUInt16BE(2, 12); // ASCII
  buf.writeUInt32BE(value.length, 14);
  buf.writeUInt32BE(valueAt, 18); // value offset — far past any first chunk
  buf.writeUInt32BE(0, 22); // next IFD
  value.copy(buf, valueAt);
  return buf;
}

function buildWebp(tiff: Buffer): Buffer {
  const exifHeader = Buffer.alloc(8);
  exifHeader.write('EXIF', 0, 'latin1');
  exifHeader.writeUInt32LE(tiff.length, 4);
  const pad = tiff.length & 1 ? Buffer.from([0]) : Buffer.alloc(0);
  const body = Buffer.concat([exifHeader, tiff, pad]);
  const riff = Buffer.alloc(12);
  riff.write('RIFF', 0, 'latin1');
  riff.writeUInt32LE(4 + body.length, 4);
  riff.write('WEBP', 8, 'latin1');
  return Buffer.concat([riff, body]);
}

describe('readExif — format routing', () => {
  let dir: string;
  it('setup', async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'exif-formats-'));
    expect(dir).toBeTruthy();
  });

  it('returns null (no throw) for a .gif — a no-EXIF format we ingest but never parse', async () => {
    const file = path.join(dir, '20171120_111646-ANIMATION.gif');
    // GIF89a header + minimal garbage. readExif must not even hand this to
    // exifr (which would throw "Unknown file format" and dead-letter it).
    await writeFile(file, Buffer.from('GIF89a\x01\x00\x01\x00\x00\x00\x00', 'latin1'));
    expect(await readExif(file)).toBeNull();
  });

  it('returns null for a .bmp', async () => {
    const file = path.join(dir, 'tile.bmp');
    await writeFile(file, Buffer.from('BM', 'latin1'));
    expect(await readExif(file)).toBeNull();
  });

  it('parses EXIF out of a .webp via the RIFF walker', async () => {
    const file = path.join(dir, 'IMG_5368.WEBP');
    await writeFile(file, buildWebp(makeTiff('Apple')));
    const exif = await readExif(file);
    expect(exif?.camera_make).toBe('Apple');
  });

  it('returns null for a .webp with no EXIF chunk (rather than throwing)', async () => {
    const file = path.join(dir, 'plain.webp');
    const riff = Buffer.alloc(12);
    riff.write('RIFF', 0, 'latin1');
    riff.writeUInt32LE(4, 4);
    riff.write('WEBP', 8, 'latin1');
    await writeFile(file, riff);
    expect(await readExif(file)).toBeNull();
  });

  it('parses a .dng whose tag value lives far past exifr\'s first chunk', async () => {
    // Regression: DJI DNGs dead-lettered with "undefined is not an object
    // (evaluating 'this.dataView.getUint16')" because the path-based chunked
    // reader never fetched the chunk holding the value. Routing RAW/TIFF
    // extensions through a full Buffer read fixes it.
    const file = path.join(dir, 'DJI_20260521203805_0430_D.DNG');
    await writeFile(file, makeTiffFarValue('Hasselblad', 200_000));
    const exif = await readExif(file);
    expect(exif?.camera_make).toBe('Hasselblad');
  });

  it('parses EXIF out of a plain .tiff via the Buffer path', async () => {
    const file = path.join(dir, 'scan.tiff');
    await writeFile(file, makeTiff('Canon'));
    const exif = await readExif(file);
    expect(exif?.camera_make).toBe('Canon');
  });

  it('cleanup', async () => {
    await rm(dir, { recursive: true, force: true });
    expect(true).toBe(true);
  });
});
