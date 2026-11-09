import { test, expect } from 'bun:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readExif } from '../src/indexer/exif.ts';
import { videoCaptureDate } from '../../web/projects/maple-common/src/lib/addressing/video-capture-date.ts';

// #5079: the browser's moov reader must date every container shape exactly as
// the server's `readExif` does, because both feed the primary maple_id form.

const box = (type: string, payload: Buffer): Buffer => {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(8 + payload.length, 0);
  header.write(type, 4, 'latin1');
  return Buffer.concat([header, payload]);
};

const keysBox = (names: string[]): Buffer => {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(names.length, 4);
  const entries = names.map((name) => {
    const nameBytes = Buffer.from(name, 'utf8');
    const entry = Buffer.alloc(8 + nameBytes.length);
    entry.writeUInt32BE(8 + nameBytes.length, 0);
    entry.write('mdta', 4, 'latin1');
    nameBytes.copy(entry, 8);
    return entry;
  });
  return box('keys', Buffer.concat([head, ...entries]));
};

const item = (index: number, value: string): Buffer => {
  const data = Buffer.alloc(8 + Buffer.byteLength(value));
  data.writeUInt32BE(1, 0);
  data.write(value, 8, 'utf8');
  const type = Buffer.alloc(4);
  type.writeUInt32BE(index, 0);
  return box(type.toString('latin1'), box('data', data));
};

const CREATION = 'com.apple.quicktime.creationdate';
const quickTimeMeta = (value: string): Buffer =>
  box(
    'meta',
    Buffer.concat([
      box('hdlr', Buffer.alloc(25)),
      keysBox([CREATION]),
      box('ilst', item(1, value)),
    ]),
  );
const isoMeta = (value: string): Buffer =>
  box(
    'meta',
    Buffer.concat([
      Buffer.alloc(4),
      box('hdlr', Buffer.alloc(25)),
      keysBox([CREATION]),
      box('ilst', item(1, value)),
    ]),
  );

const mvhd = (iso: string, version: 0 | 1 = 0): Buffer => {
  const seconds = Math.floor(Date.parse(iso) / 1000) + 2_082_844_800;
  const payload = Buffer.alloc(version === 1 ? 112 : 100);
  payload[0] = version;
  if (version === 1) payload.writeBigUInt64BE(BigInt(seconds), 4);
  else payload.writeUInt32BE(seconds, 4);
  return box('mvhd', payload);
};

const ftyp = box('ftyp', Buffer.from('qt  \x00\x00\x02\x00qt  ', 'latin1'));
const mdat = box('mdat', Buffer.alloc(512, 7));
const largeMdat = (): Buffer => {
  const header = Buffer.alloc(16);
  header.writeUInt32BE(1, 0);
  header.write('mdat', 4, 'latin1');
  header.writeBigUInt64BE(BigInt(16 + 512), 8);
  return Buffer.concat([header, Buffer.alloc(512, 9)]);
};

const cases: Record<string, Buffer> = {
  'creationdate with a bare zone, moov after mdat': Buffer.concat([
    ftyp,
    mdat,
    box(
      'moov',
      Buffer.concat([mvhd('2020-01-01T00:00:00Z'), quickTimeMeta('2026-04-05T11:26:20-0700')]),
    ),
  ]),
  'creationdate with a colon zone': Buffer.concat([
    ftyp,
    box('moov', quickTimeMeta('2026-04-05T11:26:20+05:30')),
    mdat,
  ]),
  'creationdate with fractional seconds': Buffer.concat([
    ftyp,
    box('moov', quickTimeMeta('2026-04-05T11:26:20.123456Z')),
  ]),
  'mvhd version 0 only': Buffer.concat([ftyp, box('moov', mvhd('2024-03-01T09:00:00Z')), mdat]),
  'mvhd version 1 only': Buffer.concat([ftyp, box('moov', mvhd('2024-03-01T10:00:00Z', 1))]),
  'an unusable creationdate falls back to mvhd': Buffer.concat([
    ftyp,
    box('moov', Buffer.concat([mvhd('2023-11-14T22:13:20Z'), quickTimeMeta('not a date')])),
  ]),
  'the last meta carrying the key wins': Buffer.concat([
    ftyp,
    box(
      'moov',
      Buffer.concat([quickTimeMeta('2025-01-01T00:00:00Z'), quickTimeMeta('2025-02-02T00:00:00Z')]),
    ),
  ]),
  'an unusable later creationdate overrides an earlier one': Buffer.concat([
    ftyp,
    box(
      'moov',
      Buffer.concat([
        mvhd('2023-11-14T22:13:20Z'),
        quickTimeMeta('2025-01-01T00:00:00Z'),
        quickTimeMeta('garbage'),
      ]),
    ),
  ]),
  'meta nested under udta': Buffer.concat([
    ftyp,
    box('moov', box('udta', quickTimeMeta('2024-07-04T12:00:00Z'))),
  ]),
  'ISO-MP4 full-box meta': Buffer.concat([ftyp, box('moov', isoMeta('2024-08-09T10:11:12Z'))]),
  'a 64-bit mdat before moov': Buffer.concat([
    ftyp,
    largeMdat(),
    box('moov', mvhd('2022-02-02T02:02:02Z')),
  ]),
  'no moov': Buffer.concat([ftyp, mdat]),
  'a moov without a date': Buffer.concat([ftyp, box('moov', box('free', Buffer.alloc(16)))]),
  'a truncated moov': Buffer.concat([
    ftyp,
    box('moov', mvhd('2022-02-02T02:02:02Z')).subarray(0, 40),
  ]),
};

test('the web moov reader dates every container shape as the server does', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'maple-id-video-parity-'));
  try {
    const dated: Record<string, string | null> = {};
    for (const [name, bytes] of Object.entries(cases)) {
      const path = join(dir, 'clip.mov');
      await writeFile(path, bytes);
      const server = (await readExif(path))?.captured_at ?? null;
      expect(await videoCaptureDate(new Blob([new Uint8Array(bytes)])), name).toBe(server);
      dated[name] = server;
    }
    expect(dated['creationdate with a bare zone, moov after mdat']).toBe(
      '2026-04-05T18:26:20.000Z',
    );
    expect(dated['mvhd version 1 only']).toBe('2024-03-01T10:00:00.000Z');
    expect(dated['an unusable creationdate falls back to mvhd']).toBe('2023-11-14T22:13:20.000Z');
    expect(dated['no moov']).toBeNull();
  } finally {
    await rm(dir, { recursive: true });
  }
});
