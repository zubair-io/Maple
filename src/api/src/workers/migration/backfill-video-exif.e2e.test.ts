/**
 * End-to-end coverage for the video-metadata backfill (#1525).
 *
 * Seeds a backup video with a real `.MOV` on disk — QuickTime `moov` atoms
 * built by hand below, so the reader is genuinely exercised rather than mocked
 * — runs a batch, and asserts that the recovered date and GPS land on the
 * asset and that the right downstream work is nudged: geocode re-runs when GPS
 * was recovered, and the refile marker is cleared when only a date was.
 */
import { describe, it, expect } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { backfillVideoExif, VIDEO_META_VERSION } from './backfill-video-exif.ts';
import { setLibraryRootsForTests } from '../../indexer/libraries.cache.ts';
import {
  assetRow,
  createLibrary,
  seedAsset,
  seedLocation,
  stageRow,
  type MigrationLibrary,
} from './migration.test-helpers.ts';

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

/**
 * A library whose root is registered with the in-memory cache the migration
 * resolves absolute paths through, and which un-registers itself on exit.
 */
async function createVideoLibrary(): Promise<MigrationLibrary & { restore(): void }> {
  const library = await createLibrary('backfill-vid-');
  setLibraryRootsForTests(new Map([[library.folderId.toHexString(), library.root]]));
  return {
    ...library,
    restore: () => setLibraryRootsForTests(null),
    [Symbol.dispose]: () => {
      setLibraryRootsForTests(null);
      library[Symbol.dispose]();
    },
  };
}

/** A backup-origin video asset with its `.MOV` genuinely on disk. */
async function seedVideo(
  library: MigrationLibrary,
  opts: { movBytes: Buffer; rel: string; filename: string },
): Promise<string> {
  await fs.mkdir(path.join(library.root, ...opts.rel.split('/')), { recursive: true });
  await fs.writeFile(path.join(library.root, opts.rel, opts.filename), opts.movBytes);
  const id = seedAsset(library.db, {
    mediaKind: 'video',
    phassetDevices: ['dev'],
    backupLayoutVersion: 4,
    stages: ['geocode'],
    location: { libraryId: library.folderId, path: opts.rel, filename: opts.filename },
  });
  library.db.run(`UPDATE stage_state SET version = 2 WHERE asset_id = ? AND stage = 'geocode'`, [
    id,
  ]);
  return id;
}

/** The EXIF payload the migration wrote back, parsed. */
function exifOf(library: MigrationLibrary, id: string): Record<string, unknown> | null {
  const raw = assetRow(library.db, id)!.exif;
  return raw === null ? null : (JSON.parse(raw) as Record<string, unknown>);
}

const GPS_MOV = { date: '2026-04-05T11:26:20-0700', gps: '+48.8041+002.1176/' };
const REL = '2026/2595';

describe('backfill-video-exif end-to-end', () => {
  it('GPS video → writes the coordinate and re-arms geocode', async () => {
    using library = await createVideoLibrary();
    const id = await seedVideo(library, {
      movBytes: mov(GPS_MOV),
      rel: REL,
      filename: 'IMG_2693.MOV',
    });

    const result = await backfillVideoExif.runBatch(50);
    expect(result.processed).toBeGreaterThanOrEqual(1);

    const exif = exifOf(library, id)!;
    expect(exif.gps).toEqual({ lat: 48.8041, lng: 2.1176 });
    expect(exif.captured_year).toBe(2026);
    expect(assetRow(library.db, id)!.video_meta_version).toBe(VIDEO_META_VERSION);
    expect(stageRow(library.db, id, 'geocode')!.version).toBe(0); // re-geocode
  });

  it('dated video with no GPS → becomes a refile candidate for <year>/<MM>', async () => {
    using library = await createVideoLibrary();
    const id = await seedVideo(library, {
      movBytes: mov({ date: '2026-05-31T10:00:00-0400' }),
      rel: REL,
      filename: 'IMG_X.MOV',
    });

    await backfillVideoExif.runBatch(50);

    const exif = exifOf(library, id)!;
    expect(exif.gps ?? null).toBeNull();
    expect(exif.captured_month).toBe(5);
    expect(assetRow(library.db, id)!.backup_layout_version).toBe(0);
    expect(assetRow(library.db, id)!.video_meta_version).toBe(VIDEO_META_VERSION);
  });

  it('stamps the marker so the asset drops out of the candidate set', async () => {
    using library = await createVideoLibrary();
    await seedVideo(library, { movBytes: mov(GPS_MOV), rel: REL, filename: 'IMG_Z.MOV' });

    await backfillVideoExif.runBatch(50);

    expect(await backfillVideoExif.countRemaining()).toBe(0);
    expect(await backfillVideoExif.runBatch(50)).toEqual({ processed: 0, errors: 0 });
  });

  it('reads the live VIDEO location, not the canonical still', async () => {
    using library = await createVideoLibrary();
    await fs.mkdir(path.join(library.root, ...REL.split('/')), { recursive: true });
    await fs.writeFile(path.join(library.root, REL, 'clip.MOV'), mov(GPS_MOV));

    // The first live location is the STILL; the video is second. The migration
    // must still read the `.MOV`, not the `.HEIC` — which does not even exist
    // on disk. `media_kind` is video because ANY location is a video (#3492).
    const id = seedAsset(library.db, {
      mediaKind: 'video',
      phassetDevices: ['dev'],
      backupLayoutVersion: 4,
      stages: ['geocode'],
    });
    seedLocation(library.db, {
      assetId: id,
      libraryId: library.folderId,
      ordinal: 0,
      path: REL,
      filename: 'still.HEIC',
    });
    seedLocation(library.db, {
      assetId: id,
      libraryId: library.folderId,
      ordinal: 1,
      path: REL,
      filename: 'clip.MOV',
    });

    await backfillVideoExif.runBatch(50);

    expect(exifOf(library, id)!.gps).toEqual({ lat: 48.8041, lng: 2.1176 });
    expect(assetRow(library.db, id)!.video_meta_version).toBe(VIDEO_META_VERSION);
  });
});
