/**
 * Unit tests for the pure-JS QuickTime/MP4 metadata reader. Atom buffers are
 * hand-built so the parser is exercised without needing a real (large) `.MOV`.
 */
import { describe, it, expect } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  parseMoov,
  parseISO6709,
  normalizeCreationDate,
  readVideoMetadata,
} from './video-metadata.ts';

// ── byte builders (mirror the on-disk box format) ──────────────────────────
function box(type: string, payload: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(8 + payload.length, 0);
  header.write(type, 4, 'latin1');
  return Buffer.concat([header, payload]);
}

function mvhdBox(unixSeconds: number): Buffer {
  // version(1) + flags(3) + creation_time(4) + modification(4) + timescale(4) + duration(4)
  const p = Buffer.alloc(20);
  p.writeUInt8(0, 0); // version 0
  p.writeUInt32BE(unixSeconds + 2_082_844_800, 4); // QuickTime epoch
  return box('mvhd', p);
}

function keysBox(names: string[]): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(0, 0); // version + flags
  head.writeUInt32BE(names.length, 4); // entry_count
  const entries = names.map((n) => {
    const nameBuf = Buffer.from(n, 'utf8');
    const e = Buffer.alloc(8 + nameBuf.length);
    e.writeUInt32BE(8 + nameBuf.length, 0); // key_size (incl header)
    e.write('mdta', 4, 'latin1'); // namespace
    nameBuf.copy(e, 8);
    return e;
  });
  return box('keys', Buffer.concat([head, ...entries]));
}

function dataBox(value: string): Buffer {
  const v = Buffer.from(value, 'utf8');
  const p = Buffer.alloc(8 + v.length);
  p.writeUInt32BE(1, 0); // type indicator (UTF-8) — not parsed
  p.writeUInt32BE(0, 4); // locale
  v.copy(p, 8);
  return box('data', p);
}

function ilstItem(keyIndex: number, value: string): Buffer {
  const typeBuf = Buffer.alloc(4);
  typeBuf.writeUInt32BE(keyIndex, 0);
  return box(typeBuf.toString('latin1'), dataBox(value));
}

function ilstBox(items: Buffer[]): Buffer {
  return box('ilst', Buffer.concat(items));
}

const hdlr = () => box('hdlr', Buffer.alloc(25));

/** Plain QuickTime `meta` (no version/flags; first child is hdlr). */
function metaPlain(children: Buffer[]): Buffer {
  return box('meta', Buffer.concat([hdlr(), ...children]));
}

/** ISO-MP4 `meta` FullBox (4-byte version/flags before children). */
function metaFullbox(children: Buffer[]): Buffer {
  return box('meta', Buffer.concat([Buffer.alloc(4), hdlr(), ...children]));
}

// keys are 1-indexed; this ordering matches the ilst indices below.
const KEYS = [
  'com.apple.quicktime.make',
  'com.apple.quicktime.model',
  'com.apple.quicktime.creationdate',
  'com.apple.quicktime.location.ISO6709',
];

function iphoneIlst(): Buffer {
  return ilstBox([
    ilstItem(1, 'Apple'),
    ilstItem(2, 'iPhone 17 Pro Max'),
    ilstItem(3, '2026-04-05T11:26:20-0700'),
    ilstItem(4, '+48.8041+002.1176+010.000/'),
  ]);
}

describe('parseISO6709', () => {
  it('parses signed lat/lng with altitude', () => {
    expect(parseISO6709('+48.8041+002.1176+010.000/')).toEqual({ lat: 48.8041, lng: 2.1176 });
  });
  it('parses a western/southern coordinate', () => {
    expect(parseISO6709('-33.8688-151.2093/')).toEqual({ lat: -33.8688, lng: -151.2093 });
  });
  it('rejects garbage', () => {
    expect(parseISO6709('not-a-coord')).toBeNull();
  });
});

describe('normalizeCreationDate', () => {
  it('inserts a colon into a bare ±HHMM offset', () => {
    expect(normalizeCreationDate('2026-04-05T11:26:20-0700')).toBe('2026-04-05T11:26:20-07:00');
  });
  it('leaves a Z suffix alone', () => {
    expect(normalizeCreationDate('2026-04-05T18:26:20Z')).toBe('2026-04-05T18:26:20Z');
  });
  it('returns null for unparseable input', () => {
    expect(normalizeCreationDate('nope')).toBeNull();
  });
});

// `parseMoov` takes the moov PAYLOAD (its child boxes), not the wrapped box.
const moovPayload = (...children: Buffer[]) => Buffer.concat(children);

describe('parseMoov', () => {
  it('extracts date + GPS + make/model from a plain QuickTime meta', () => {
    const md = parseMoov(moovPayload(mvhdBox(0), metaPlain([keysBox(KEYS), iphoneIlst()])));
    expect(md.creationDate).toBe('2026-04-05T11:26:20-07:00');
    expect(md.latitude).toBe(48.8041);
    expect(md.longitude).toBe(2.1176);
    expect(md.make).toBe('Apple');
    expect(md.model).toBe('iPhone 17 Pro Max');
  });

  it('handles an ISO-MP4 fullbox meta the same way', () => {
    expect(parseMoov(moovPayload(metaFullbox([keysBox(KEYS), iphoneIlst()]))).latitude).toBe(
      48.8041,
    );
  });

  it('prefers the keys creationdate over the mvhd fallback', () => {
    const md = parseMoov(moovPayload(mvhdBox(0), metaPlain([keysBox(KEYS), iphoneIlst()])));
    expect(md.creationDate).toBe('2026-04-05T11:26:20-07:00');
  });

  it('falls back to mvhd creation_time when there is no keys/ilst date', () => {
    const unix = Date.UTC(2026, 3, 5, 11, 26, 20) / 1000;
    expect(parseMoov(moovPayload(mvhdBox(unix))).creationDate).toBe(
      new Date(unix * 1000).toISOString(),
    );
  });

  it('returns nulls for a moov with no recognizable metadata', () => {
    expect(parseMoov(moovPayload(box('trak', Buffer.alloc(10))))).toEqual({
      creationDate: null,
      latitude: null,
      longitude: null,
      make: null,
      model: null,
    });
  });
});

describe('readVideoMetadata (file-level: seeks past mdat)', () => {
  it('reads moov that sits AFTER a large mdat without reading the mdat body', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vidmeta-'));
    const file = path.join(dir, 'IMG_TEST.MOV');
    try {
      const ftyp = box('ftyp', Buffer.from('qt  \x00\x00\x02\x00qt  ', 'latin1'));
      const mdat = box('mdat', Buffer.alloc(64 * 1024)); // body never read
      const moov = box(
        'moov',
        Buffer.concat([mvhdBox(0), metaPlain([keysBox(KEYS), iphoneIlst()])]),
      );
      await fs.writeFile(file, Buffer.concat([ftyp, mdat, moov]));

      const md = await readVideoMetadata(file);
      expect(md).not.toBeNull();
      expect(md!.creationDate).toBe('2026-04-05T11:26:20-07:00');
      expect(md!.latitude).toBe(48.8041);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('returns null for a file with no moov', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vidmeta-'));
    const file = path.join(dir, 'broken.MOV');
    try {
      await fs.writeFile(file, box('ftyp', Buffer.alloc(8)));
      expect(await readVideoMetadata(file)).toBeNull();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
