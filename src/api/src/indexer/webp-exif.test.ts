import { describe, expect, it } from 'bun:test';
import exifr from 'exifr';
import { extractWebpExifTiff, readWebpExifTiff, WebpTruncatedError } from './webp-exif.ts';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

/** A minimal but valid big-endian TIFF carrying a single Make tag. exifr
 * parses this as a bare TIFF. (Same helper shape as heic-exif.test.) */
function makeTiff(make: string): Buffer {
  const value = Buffer.from(make + '\0', 'latin1');
  const header = Buffer.alloc(8);
  header.write('MM', 0, 'latin1');
  header.writeUInt16BE(0x002a, 2);
  header.writeUInt32BE(8, 4); // IFD0 at offset 8

  const ifd = Buffer.alloc(2 + 12 + 4);
  ifd.writeUInt16BE(1, 0); // entry count
  ifd.writeUInt16BE(0x010f, 2); // tag = Make
  ifd.writeUInt16BE(2, 4); // type = ASCII
  ifd.writeUInt32BE(value.length, 6); // count
  ifd.writeUInt32BE(8 + ifd.length, 10); // value offset
  ifd.writeUInt32BE(0, 14); // next IFD = none
  return Buffer.concat([header, ifd, value]);
}

/** Wrap an EXIF payload in a RIFF/WEBP container. `payload` is whatever goes
 * inside the `EXIF` chunk (a bare TIFF, or `Exif\0\0` + TIFF). An optional
 * leading `VP8X` chunk mimics a real WebP where EXIF isn't the first chunk. */
function buildWebp(payload: Buffer, opts: { leadingChunk?: boolean } = {}): Buffer {
  const chunks: Buffer[] = [];
  if (opts.leadingChunk) {
    const vp8x = Buffer.alloc(8 + 10);
    vp8x.write('VP8X', 0, 'latin1');
    vp8x.writeUInt32LE(10, 4);
    chunks.push(vp8x);
  }
  const exifHeader = Buffer.alloc(8);
  exifHeader.write('EXIF', 0, 'latin1');
  exifHeader.writeUInt32LE(payload.length, 4);
  // RIFF chunks pad to an even length.
  const pad = payload.length & 1 ? Buffer.from([0]) : Buffer.alloc(0);
  chunks.push(exifHeader, payload, pad);

  const body = Buffer.concat(chunks);
  const riff = Buffer.alloc(12);
  riff.write('RIFF', 0, 'latin1');
  riff.writeUInt32LE(4 + body.length, 4); // "WEBP" + chunks
  riff.write('WEBP', 8, 'latin1');
  return Buffer.concat([riff, body]);
}

describe('extractWebpExifTiff', () => {
  it('slices a bare-TIFF EXIF chunk that exifr can then parse', async () => {
    const tiff = makeTiff('Canon');
    const webp = buildWebp(tiff, { leadingChunk: true });
    const sliced = extractWebpExifTiff(webp);
    expect(sliced).not.toBeNull();
    const parsed = (await exifr.parse(sliced as Buffer, { pick: ['Make'] })) as { Make?: string };
    expect(parsed.Make).toBe('Canon');
  });

  it('strips the optional `Exif\\0\\0` marker before the TIFF', async () => {
    const tiff = makeTiff('Nikon');
    const withMarker = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
    const webp = buildWebp(withMarker);
    const sliced = extractWebpExifTiff(webp);
    expect(sliced).not.toBeNull();
    // The slice must start on the TIFF byte-order mark, not the marker.
    expect(sliced!.toString('latin1', 0, 2)).toBe('MM');
    const parsed = (await exifr.parse(sliced as Buffer, { pick: ['Make'] })) as { Make?: string };
    expect(parsed.Make).toBe('Nikon');
  });

  it('returns null for a WebP without an EXIF chunk', () => {
    // A container whose only chunk is VP8X — no EXIF.
    const vp8x = Buffer.alloc(8 + 10);
    vp8x.write('VP8X', 0, 'latin1');
    vp8x.writeUInt32LE(10, 4);
    const riff = Buffer.alloc(12);
    riff.write('RIFF', 0, 'latin1');
    riff.writeUInt32LE(4 + vp8x.length, 4);
    riff.write('WEBP', 8, 'latin1');
    expect(extractWebpExifTiff(Buffer.concat([riff, vp8x]))).toBeNull();
  });

  it('returns null (not a throw) for non-RIFF / mislabelled bytes', () => {
    expect(extractWebpExifTiff(Buffer.from('not a webp at all', 'latin1'))).toBeNull();
    expect(extractWebpExifTiff(Buffer.alloc(4))).toBeNull();
  });

  it('throws WebpTruncatedError when a chunk runs past EOF', () => {
    const webp = buildWebp(makeTiff('Sony'));
    // Lop off the tail so the EXIF chunk claims more bytes than remain.
    const truncated = webp.subarray(0, webp.length - 8);
    expect(() => extractWebpExifTiff(truncated)).toThrow(WebpTruncatedError);
  });
});

describe('readWebpExifTiff', () => {
  it('reads a WebP off disk and returns its TIFF block', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'webp-exif-'));
    try {
      const file = path.join(dir, 'IMG_5526.WEBP');
      await writeFile(file, buildWebp(makeTiff('FUJIFILM')));
      const tiff = await readWebpExifTiff(file);
      expect(tiff).not.toBeNull();
      const parsed = (await exifr.parse(tiff as Buffer, { pick: ['Make'] })) as { Make?: string };
      expect(parsed.Make).toBe('FUJIFILM');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
