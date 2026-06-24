/**
 * Integration: `readExif` routes a video through the moov reader and produces a
 * normal `AssetExif` (date + GPS), so the geocode + refile pipeline treats videos
 * like photos.
 */
import { describe, it, expect } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { readExif } from './exif.ts';

// Minimal QuickTime box builders (just enough for one iPhone-style clip).
const box = (type: string, payload: Buffer): Buffer => {
  const h = Buffer.alloc(8);
  h.writeUInt32BE(8 + payload.length, 0);
  h.write(type, 4, 'latin1');
  return Buffer.concat([h, payload]);
};
const keysBox = (names: string[]): Buffer => {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(names.length, 4);
  const entries = names.map((n) => {
    const nb = Buffer.from(n, 'utf8');
    const e = Buffer.alloc(8 + nb.length);
    e.writeUInt32BE(8 + nb.length, 0);
    e.write('mdta', 4, 'latin1');
    nb.copy(e, 8);
    return e;
  });
  return box('keys', Buffer.concat([head, ...entries]));
};
const dataBox = (value: string): Buffer => {
  const v = Buffer.from(value, 'utf8');
  const p = Buffer.alloc(8 + v.length);
  p.writeUInt32BE(1, 0);
  v.copy(p, 8);
  return box('data', p);
};
const item = (idx: number, value: string): Buffer => {
  const t = Buffer.alloc(4);
  t.writeUInt32BE(idx, 0);
  return box(t.toString('latin1'), dataBox(value));
};

function iphoneMov(): Buffer {
  const keys = keysBox([
    'com.apple.quicktime.creationdate',
    'com.apple.quicktime.location.ISO6709',
  ]);
  const ilst = box(
    'ilst',
    Buffer.concat([item(1, '2026-04-05T11:26:20-0700'), item(2, '+48.8041+002.1176/')]),
  );
  const meta = box('meta', Buffer.concat([box('hdlr', Buffer.alloc(25)), keys, ilst]));
  const moov = box('moov', meta);
  const ftyp = box('ftyp', Buffer.from('qt  \x00\x00\x02\x00qt  ', 'latin1'));
  const mdat = box('mdat', Buffer.alloc(2048));
  return Buffer.concat([ftyp, mdat, moov]);
}

describe('readExif (video)', () => {
  it('extracts capture date + GPS from a .MOV', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'exif-vid-'));
    const file = path.join(dir, 'IMG_2693.MOV');
    try {
      await fs.writeFile(file, iphoneMov());
      const exif = await readExif(file);
      expect(exif).not.toBeNull();
      // -07:00 → 18:26 UTC, still 2026-04-05.
      expect(exif!.captured_year).toBe(2026);
      expect(exif!.captured_month).toBe(4);
      expect(exif!.gps).toEqual({ lat: 48.8041, lng: 2.1176 });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('returns null for a non-video container with no moov', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'exif-vid-'));
    const file = path.join(dir, 'empty.mp4');
    try {
      await fs.writeFile(file, box('ftyp', Buffer.alloc(8)));
      expect(await readExif(file)).toBeNull();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
