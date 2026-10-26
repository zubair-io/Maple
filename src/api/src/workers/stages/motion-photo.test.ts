import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from '../../fs/mirrored.ts';
import * as os from 'node:os';
import * as path from 'node:path';
import { ObjectId } from '../../db/object-id.ts';
import type { SqlStatement } from '../../db/sqlite/protocol.ts';
import {
  createLiveTestDatabase,
  insertAsset,
  insertFolder,
  run,
  type LiveTestDatabase,
} from '../../db/sqlite/test-sqlite.test-helpers.ts';
import { invalidateLibraryRoots } from '../../indexer/libraries.cache.ts';
import { containerXmp, jpeg, mp4 } from '../../indexer/motion-photo/motion-photo.fixtures.ts';
import motionPhotoStage, { motionPhotoHandler } from './motion-photo.ts';

const stageContext = () => ({ signal: new AbortController().signal, log: { debug() {} } }) as never;

function pixelMotionPhoto(clip: Buffer): Buffer {
  const xmp = containerXmp({ MotionPhoto: '1', MotionPhotoVersion: '1' }, [
    { mime: 'image/jpeg', semantic: 'Primary', length: 0, padding: 0 },
    {
      mime: 'video/mp4',
      semantic: 'MotionPhoto',
      length: clip.length,
      padding: 0,
    },
  ]);
  return Buffer.concat([jpeg(xmp), clip]);
}

describe('motion-photo stage', () => {
  let live: LiveTestDatabase;
  let dir: string;
  let libraryId: string;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'motion-photo-stage-'));
    await mkdir(path.join(dir, 'phone'), { recursive: true });
  });

  beforeEach(async () => {
    live = await createLiveTestDatabase();
    libraryId = insertFolder(live.db, { path: dir, slug: 'motion-photo-lib' });
    invalidateLibraryRoots();
  });

  afterEach(() => live.close());

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function assetDoc(id: string, filename: string) {
    return {
      _id: new ObjectId(id),
      fileinfo: [
        {
          path: 'phone',
          filename,
          library_id: new ObjectId(libraryId),
          deleted_at: null,
        },
      ],
    };
  }

  function apply(result: unknown): void {
    const { patch } = result as { patch: SqlStatement[] };
    for (const statement of patch) live.db.run(statement.sql, (statement.params ?? []) as never);
  }

  function motionColumns(id: string) {
    return live.db
      .query(
        `SELECT motion_video_start AS start, motion_video_length AS length,
                motion_video_mime AS mime, motion_source_size AS sourceSize
           FROM assets WHERE id = ?`,
      )
      .get(id);
  }

  it('records the verified clip range of a Motion Photo', async () => {
    const clip = mp4('stage-clip');
    const bytes = pixelMotionPhoto(clip);
    await writeFile(path.join(dir, 'phone', 'PXL_1.MP.jpg'), bytes);
    const id = insertAsset(live.db, {});

    apply(await motionPhotoHandler(assetDoc(id, 'PXL_1.MP.jpg') as never, stageContext()));

    expect(motionColumns(id)).toEqual({
      start: bytes.length - clip.length,
      length: clip.length,
      mime: 'video/mp4',
      sourceSize: bytes.length,
    });
  });

  it('clears a previously recorded clip once the original is a plain still', async () => {
    await writeFile(path.join(dir, 'phone', 'plain.jpg'), jpeg(null));
    const id = insertAsset(live.db, {});
    run(
      live.db,
      `UPDATE assets SET motion_video_start = 10, motion_video_length = 20,
              motion_video_mime = 'video/mp4', motion_source_size = 30 WHERE id = ?`,
      id,
    );

    apply(await motionPhotoHandler(assetDoc(id, 'plain.jpg') as never, stageContext()));

    expect(motionColumns(id)).toEqual({
      start: null,
      length: null,
      mime: null,
      sourceSize: null,
    });
  });

  it('skips files that cannot carry a Motion Photo without reading them', async () => {
    const id = insertAsset(live.db, {});
    const result = await motionPhotoHandler(assetDoc(id, 'clip.mp4') as never, stageContext());
    expect(result).toEqual({ skip: 'not-a-jpeg-or-heic' });
  });

  it('runs independently of every other stage', () => {
    expect(motionPhotoStage.name).toBe('motion-photo');
    expect(motionPhotoStage.dependsOn).toEqual([]);
  });
});
