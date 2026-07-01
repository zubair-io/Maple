/**
 * End-to-end tests for the backfill-video-exif migration (#1525, Mongo-gated).
 *
 * Seeds a backup video with a real `.MOV` on disk (QuickTime moov atoms), runs a
 * batch, and asserts the recovered date/GPS land on `exif` and the right
 * downstream stage is nudged (geocode reset for GPS, blv reset for no-GPS).
 */
import { describe, it, expect, afterEach } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { ObjectId, type Collection } from 'mongodb';
import { backfillVideoExif, VIDEO_META_VERSION } from './backfill-video-exif.ts';

// ── minimal QuickTime box builders ─────────────────────────────────────────
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

/** Build a .MOV carrying a creationdate and optionally a GPS ISO6709 string. */
function mov(opts: { date: string; gps?: string }): Buffer {
  const names = ['com.apple.quicktime.creationdate'];
  const items = [item(1, opts.date)];
  if (opts.gps) {
    names.push('com.apple.quicktime.location.ISO6709');
    items.push(item(2, opts.gps));
  }
  const meta = box(
    'meta',
    Buffer.concat([
      box('hdlr', Buffer.alloc(25)),
      keysBox(names),
      box('ilst', Buffer.concat(items)),
    ]),
  );
  const ftyp = box('ftyp', Buffer.from('qt  \x00\x00\x02\x00qt  ', 'latin1'));
  const mdat = box('mdat', Buffer.alloc(2048));
  return Buffer.concat([ftyp, mdat, box('moov', meta)]);
}

async function connectOrSkip(label: string) {
  try {
    const { getDb } = await import('../../db/client.ts');
    return await getDb();
  } catch {
    console.log(`MongoDB unreachable — skipping ${label}`);
    return null;
  }
}

describe('backfill-video-exif end-to-end', () => {
  let dir: string | null = null;
  afterEach(async () => {
    if (dir) await fs.rm(dir, { recursive: true, force: true });
    dir = null;
  });

  async function seed(opts: {
    movBytes: Buffer;
    rel: string;
    filename: string;
  }): Promise<{ id: ObjectId; assets: Collection }> {
    const { getDb } = await import('../../db/client.ts');
    const { setLibraryRootsForTests } = await import('../../indexer/libraries.cache.ts');
    const db = await getDb();
    const assets = db.collection('assets');
    const libId = new ObjectId();
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'backfill-vid-'));
    setLibraryRootsForTests(new Map([[libId.toHexString(), dir]]));
    await fs.mkdir(path.join(dir, ...opts.rel.split('/')), { recursive: true });
    await fs.writeFile(path.join(dir, opts.rel, opts.filename), opts.movBytes);
    const id = new ObjectId();
    await assets.insertOne({
      _id: id,
      maple_id: 'backfill-vid-' + id.toHexString(),
      fileinfo: [{ path: opts.rel, filename: opts.filename, library_id: libId, deleted_at: null }],
      phasset_links: [{ device_id: 'dev', phasset_local_id: 'ph', first_seen: new Date() }],
      backup_layout_version: 4,
      stages: { geocode: { version: 2 } },
      size: opts.movBytes.length,
      mtime: Date.now(),
      rating: 0,
      flag: 0,
      color_label: '',
      indexed_at: new Date().toISOString(),
    } as never);
    return { id, assets };
  }

  it('GPS video → writes exif.gps + resets geocode for re-run', async () => {
    if (!(await connectOrSkip('gps video'))) return;
    const { setLibraryRootsForTests } = await import('../../indexer/libraries.cache.ts');
    const { id, assets } = await seed({
      movBytes: mov({ date: '2026-04-05T11:26:20-0700', gps: '+48.8041+002.1176/' }),
      rel: '2026/2595',
      filename: 'IMG_2693.MOV',
    });
    try {
      const res = await backfillVideoExif.runBatch(50);
      expect(res.processed).toBeGreaterThanOrEqual(1);
      const doc = (await assets.findOne({ _id: id })) as {
        exif?: { gps?: unknown; captured_year?: number };
        video_meta_version?: number;
        stages?: { geocode?: { version?: number } };
      } | null;
      expect(doc?.exif?.gps).toEqual({ lat: 48.8041, lng: 2.1176 });
      expect(doc?.exif?.captured_year).toBe(2026);
      expect(doc?.video_meta_version).toBe(VIDEO_META_VERSION);
      expect(doc?.stages?.geocode?.version).toBe(0); // re-geocode
    } finally {
      await assets.deleteOne({ _id: id });
      setLibraryRootsForTests(null);
    }
  });

  it('no-GPS dated video → resets backup_layout_version for <year>/<MM> refile', async () => {
    if (!(await connectOrSkip('no-gps video'))) return;
    const { setLibraryRootsForTests } = await import('../../indexer/libraries.cache.ts');
    const { id, assets } = await seed({
      movBytes: mov({ date: '2026-05-31T10:00:00-0400' }),
      rel: '2026/2595',
      filename: 'IMG_X.MOV',
    });
    try {
      await backfillVideoExif.runBatch(50);
      const doc = (await assets.findOne({ _id: id })) as {
        exif?: { captured_month?: number; gps?: unknown };
        backup_layout_version?: number;
        video_meta_version?: number;
      } | null;
      expect(doc?.exif?.gps ?? null).toBeNull();
      expect(doc?.exif?.captured_month).toBe(5);
      expect(doc?.backup_layout_version).toBe(0); // becomes a refile candidate
      expect(doc?.video_meta_version).toBe(VIDEO_META_VERSION);
    } finally {
      await assets.deleteOne({ _id: id });
      setLibraryRootsForTests(null);
    }
  });

  it('stamps the marker so the asset drops out of the candidate set', async () => {
    if (!(await connectOrSkip('idempotent'))) return;
    const { setLibraryRootsForTests } = await import('../../indexer/libraries.cache.ts');
    const { id, assets } = await seed({
      movBytes: mov({ date: '2026-04-05T11:26:20-0700', gps: '+48.8041+002.1176/' }),
      rel: '2026/2595',
      filename: 'IMG_Z.MOV',
    });
    try {
      await backfillVideoExif.runBatch(50);
      // A second batch must not re-process this asset (marker present).
      expect(
        await assets.countDocuments({ _id: id, video_meta_version: { $ne: VIDEO_META_VERSION } }),
      ).toBe(0);
    } finally {
      await assets.deleteOne({ _id: id });
      setLibraryRootsForTests(null);
    }
  });

  it('reads the live VIDEO entry, not the primary still (still+video asset)', async () => {
    if (!(await connectOrSkip('still+video'))) return;
    const { getDb } = await import('../../db/client.ts');
    const { setLibraryRootsForTests } = await import('../../indexer/libraries.cache.ts');
    const db = await getDb();
    const assets = db.collection('assets');
    const libId = new ObjectId();
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'backfill-vid-'));
    setLibraryRootsForTests(new Map([[libId.toHexString(), dir]]));
    const rel = '2026/2595';
    await fs.mkdir(path.join(dir, ...rel.split('/')), { recursive: true });
    await fs.writeFile(
      path.join(dir, rel, 'clip.MOV'),
      mov({ date: '2026-04-05T11:26:20-0700', gps: '+48.8041+002.1176/' }),
    );
    const id = new ObjectId();
    await assets.insertOne({
      _id: id,
      maple_id: 'still-video-' + id.toHexString(),
      // Primary live entry is the STILL; the video is second — the migration must
      // still read the .MOV, not the .HEIC (which doesn't even exist on disk).
      fileinfo: [
        { path: rel, filename: 'still.HEIC', library_id: libId, deleted_at: null },
        { path: rel, filename: 'clip.MOV', library_id: libId, deleted_at: null },
      ],
      phasset_links: [{ device_id: 'dev', phasset_local_id: 'ph', first_seen: new Date() }],
      backup_layout_version: 4,
      stages: { geocode: { version: 2 } },
      size: 1,
      mtime: Date.now(),
      rating: 0,
      flag: 0,
      color_label: '',
      indexed_at: new Date().toISOString(),
    } as never);
    try {
      await backfillVideoExif.runBatch(50);
      const doc = (await assets.findOne({ _id: id })) as {
        exif?: { gps?: unknown };
        video_meta_version?: number;
      } | null;
      expect(doc?.exif?.gps).toEqual({ lat: 48.8041, lng: 2.1176 });
      expect(doc?.video_meta_version).toBe(VIDEO_META_VERSION);
    } finally {
      await assets.deleteOne({ _id: id });
      setLibraryRootsForTests(null);
    }
  });
});
