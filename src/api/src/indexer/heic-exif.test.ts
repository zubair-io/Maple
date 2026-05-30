import { describe, expect, it } from 'bun:test';
import exifr from 'exifr';
import { extractHeicExifTiff, HeicTruncatedError, readHeicExifTiff } from './heic-exif.ts';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

/** A minimal but valid big-endian TIFF carrying a single Make tag. exifr
 * parses this as a bare TIFF. */
function makeTiff(make: string): Buffer {
  const value = Buffer.from(make + '\0', 'latin1'); // NUL-terminated ASCII
  const header = Buffer.alloc(8);
  header.write('MM', 0, 'latin1');
  header.writeUInt16BE(0x002a, 2);
  header.writeUInt32BE(8, 4); // IFD0 at offset 8

  const ifd = Buffer.alloc(2 + 12 + 4); // count + 1 entry + next-IFD
  ifd.writeUInt16BE(1, 0); // entry count
  ifd.writeUInt16BE(0x010f, 2); // tag = Make
  ifd.writeUInt16BE(2, 4); // type = ASCII
  ifd.writeUInt32BE(value.length, 6); // count
  ifd.writeUInt32BE(8 + ifd.length, 10); // value offset (data follows IFD)
  ifd.writeUInt32BE(0, 14); // next IFD = none
  return Buffer.concat([header, ifd, value]);
}

/** Build a synthetic HEIC: a 52-byte ftyp (9 brands → over exifr's 50-byte
 * cap), a meta box (iinf/infe Exif + iloc), and an mdat holding the Exif item
 * payload (`exif_tiff_header_offset` = 0, then the TIFF). */
function buildHeic(tiff: Buffer, opts: { baseOffset?: boolean } = {}): Buffer {
  const baseOffsetSize = opts.baseOffset ? 4 : 0;
  const ftyp = (() => {
    const brands = ['mif1', 'MiHB', 'MiHA', 'heix', 'MiHE', 'MiPr', 'miaf', 'heic', 'tmap'];
    const b = Buffer.alloc(16 + brands.length * 4);
    b.writeUInt32BE(b.length, 0); // 16 + 36 = 52
    b.write('ftyp', 4, 'latin1');
    b.write('heic', 8, 'latin1'); // major brand
    b.writeUInt32BE(0, 12); // minor version
    brands.forEach((br, i) => b.write(br, 16 + i * 4, 'latin1'));
    return b;
  })();

  const infe = (() => {
    const b = Buffer.alloc(20);
    b.writeUInt32BE(20, 0);
    b.write('infe', 4, 'latin1');
    b.writeUInt32BE(0x02000000, 8); // version 2, flags 0
    b.writeUInt16BE(1, 12); // item_ID
    b.writeUInt16BE(0, 14); // protection index
    b.write('Exif', 16, 'latin1'); // item_type
    return b;
  })();

  const iinf = (() => {
    const b = Buffer.alloc(8 + 4 + 2 + infe.length);
    b.writeUInt32BE(b.length, 0);
    b.write('iinf', 4, 'latin1');
    b.writeUInt32BE(0, 8); // version 0, flags 0
    b.writeUInt16BE(1, 12); // entry count
    infe.copy(b, 14);
    return b;
  })();

  // iloc layout; item length grows by base_offset_size when a base is used.
  const ilocLen = 8 + 4 + 1 + 1 + 2 + (2 + 2 + 2 + baseOffsetSize + 2 + 4 + 4);
  const metaLen = 8 + 4 + iinf.length + ilocLen;
  const payload = Buffer.concat([Buffer.from([0, 0, 0, 0]), tiff]); // nameSize=0 + TIFF
  const mdatOffset = ftyp.length + metaLen;
  const mdatBody = mdatOffset + 8; // absolute offset of the Exif payload
  // base_offset + extent_offset must resolve to mdatBody either way.
  const baseOffsetValue = opts.baseOffset ? mdatBody : 0;
  const extentOffset = opts.baseOffset ? 0 : mdatBody;

  const iloc = (() => {
    const b = Buffer.alloc(ilocLen);
    let o = 0;
    b.writeUInt32BE(ilocLen, o);
    o += 4;
    b.write('iloc', 4, 'latin1');
    o += 4;
    b.writeUInt32BE(0x01000000, o); // version 1, flags 0
    o += 4;
    b.writeUInt8(0x44, o++); // offset_size=4, length_size=4
    b.writeUInt8((baseOffsetSize << 4) | 0, o++); // base_offset_size, index_size=0
    b.writeUInt16BE(1, o); // item_count
    o += 2;
    b.writeUInt16BE(1, o); // item_ID
    o += 2;
    b.writeUInt16BE(0, o); // construction_method
    o += 2;
    b.writeUInt16BE(0, o); // data_reference_index
    o += 2;
    if (baseOffsetSize === 4) {
      b.writeUInt32BE(baseOffsetValue, o); // base_offset
      o += 4;
    }
    b.writeUInt16BE(1, o); // extent_count
    o += 2;
    b.writeUInt32BE(extentOffset, o); // extent_offset (relative to base_offset)
    o += 4;
    b.writeUInt32BE(payload.length, o); // extent_length
    return b;
  })();

  const meta = (() => {
    const b = Buffer.alloc(metaLen);
    b.writeUInt32BE(metaLen, 0);
    b.write('meta', 4, 'latin1');
    b.writeUInt32BE(0, 8); // version 0, flags 0
    iinf.copy(b, 12);
    iloc.copy(b, 12 + iinf.length);
    return b;
  })();

  const mdat = (() => {
    const b = Buffer.alloc(8 + payload.length);
    b.writeUInt32BE(b.length, 0);
    b.write('mdat', 4, 'latin1');
    payload.copy(b, 8);
    return b;
  })();

  return Buffer.concat([ftyp, meta, mdat]);
}

describe('extractHeicExifTiff', () => {
  it('regression: exifr rejects a 52-byte-ftyp HEIC outright', async () => {
    // This is the bug the module works around — proves the >50-byte gate.
    const heic = buildHeic(makeTiff('TESTCAM'));
    await expect(exifr.parse(heic)).rejects.toThrow(/Unknown file format/i);
  });

  it('extracts the embedded TIFF block, which exifr then parses', async () => {
    const heic = buildHeic(makeTiff('TESTCAM'));
    const tiff = extractHeicExifTiff(heic);
    expect(tiff).not.toBeNull();
    const parsed = (await exifr.parse(tiff as Buffer, { pick: ['Make'] })) as { Make?: string };
    expect(parsed.Make).toBe('TESTCAM');
  });

  it('readHeicExifTiff round-trips through a real file on disk', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'heic-exif-'));
    try {
      const file = path.join(dir, 'IMG_0001.heic');
      await writeFile(file, buildHeic(makeTiff('Apple')));
      const tiff = await readHeicExifTiff(file);
      expect(tiff).not.toBeNull();
      const parsed = (await exifr.parse(tiff as Buffer, { pick: ['Make'] })) as { Make?: string };
      expect(parsed.Make).toBe('Apple');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('resolves extents against a non-zero iloc base_offset', () => {
    // extent_offset is stored relative to a per-item base_offset; the absolute
    // location is base_offset + extent_offset. Dropping the base would slice
    // the wrong bytes (or false-throw truncation).
    const tiff = makeTiff('BaseCam');
    const out = extractHeicExifTiff(buildHeic(tiff, { baseOffset: true }));
    expect(out).not.toBeNull();
    expect((out as Buffer).equals(tiff)).toBe(true);
  });

  it('returns null when there is no meta box (not a HEIC)', () => {
    const notHeic = Buffer.from('this is plainly not an iso-bmff container at all', 'latin1');
    expect(extractHeicExifTiff(notHeic)).toBeNull();
  });

  it('throws HeicTruncatedError when the file is cut short mid-box', () => {
    const heic = buildHeic(makeTiff('TESTCAM'));
    // Lop off the mdat that holds the Exif payload — the iloc extent now
    // points past EOF, which is exactly the half-copied-file case.
    const truncated = heic.subarray(0, heic.length - 20);
    expect(() => extractHeicExifTiff(truncated)).toThrow(HeicTruncatedError);
  });
});

describe('readExif — HEIC end to end', () => {
  it('returns camera metadata for a modern HEIC exifr would reject', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'heic-readexif-'));
    try {
      const file = path.join(dir, 'IMG_4242.HEIC'); // uppercase ext on purpose
      await writeFile(file, buildHeic(makeTiff('Apple')));
      // Sanity: exifr alone still can't touch this file.
      await expect(exifr.parse(file)).rejects.toThrow(/Unknown file format/i);
      // ...but readExif routes through the box walker and gets the make.
      const { readExif } = await import('./exif.ts');
      const exif = await readExif(file);
      expect(exif?.camera_make).toBe('Apple');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
