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

  it('returns null (no throw) for metadata-only stub image formats (#1835)', async () => {
    for (const ext of ['eip', 'braw', 'afphoto', 'ai']) {
      const file = path.join(dir, `stub.${ext}`);
      await writeFile(file, Buffer.from([0x00, 0x01, 0x02, 0x03]));
      expect(await readExif(file)).toBeNull();
    }
  });

  it('returns null (no throw) for audio formats (#1835)', async () => {
    for (const ext of ['mp3', 'wav', 'm4a', 'aac']) {
      const file = path.join(dir, `track.${ext}`);
      await writeFile(file, Buffer.from([0x00, 0x01, 0x02, 0x03]));
      expect(await readExif(file)).toBeNull();
    }
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

  it("throws a clear, named error for a 0-byte file (not exifr's opaque crash)", async () => {
    // Regression: a zero-byte DNG (interrupted copy / unmaterialized sync
    // placeholder) made exifr throw "undefined is not an object (evaluating
    // 'this.dataView.getUint16')" and dead-letter the asset with a useless
    // message. readExif now detects the empty file up front. The throw (vs a
    // null return) keeps it on the retry path so a mid-copy file recovers; a
    // permanently-empty file dead-letters with a message that names the cause.
    const file = path.join(dir, 'DJI_interrupted_copy_0430_D.DNG');
    await writeFile(file, Buffer.alloc(0));
    await expect(readExif(file)).rejects.toThrow(/empty \(0 bytes\)/i);
    // And specifically NOT the opaque exifr crash.
    await expect(readExif(file)).rejects.not.toThrow(/getUint16/);
  });

  it('throws the empty-file error for a 0-byte .jpg too (covers all formats)', async () => {
    const file = path.join(dir, 'truncated.jpg');
    await writeFile(file, Buffer.alloc(0));
    await expect(readExif(file)).rejects.toThrow(/empty \(0 bytes\)/i);
  });

  it('cleanup', async () => {
    await rm(dir, { recursive: true, force: true });
    expect(true).toBe(true);
  });
});
