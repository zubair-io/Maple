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
import {
  appleTiff,
  heicWithExif,
  jpegWithExif,
  quickTimeClip,
} from '../../indexer/live-photo/live-photo.fixtures.ts';
import livePhotoStage, { livePhotoHandler } from './live-photo.ts';

const ID = '3F2A8C1E-9B47-4D55-A6E0-0C7D1B2E4F90';
const stageContext = () => ({ signal: new AbortController().signal, log: { debug() {} } }) as never;

describe('live-photo stage', () => {
  let live: LiveTestDatabase;
  let dir: string;
  let libraryId: string;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'live-photo-stage-'));
    await mkdir(path.join(dir, 'phone'), { recursive: true });
  });

  beforeEach(async () => {
    live = await createLiveTestDatabase();
    libraryId = insertFolder(live.db, { path: dir, slug: 'live-photo-lib' });
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
        { path: 'phone', filename, library_id: new ObjectId(libraryId), deleted_at: null },
      ],
    };
  }

  function apply(result: unknown): void {
    const { patch } = result as { patch: SqlStatement[] };
    for (const statement of patch) live.db.run(statement.sql, (statement.params ?? []) as never);
  }

  function contentId(id: string): string | null {
    const row = live.db.query('SELECT live_content_id AS id FROM assets WHERE id = ?').get(id) as {
      id: string | null;
    };
    return row.id;
  }

  async function runOn(filename: string, bytes: Buffer): Promise<string | null> {
    await writeFile(path.join(dir, 'phone', filename), bytes);
    const id = insertAsset(live.db, {});
    apply(await livePhotoHandler(assetDoc(id, filename) as never, stageContext()));
    return contentId(id);
  }

  it('records the identifier of a JPEG still', async () => {
    expect(await runOn('a.JPG', jpegWithExif(appleTiff({ contentId: ID })))).toBe(ID);
  });

  it('records the identifier of a HEIC still', async () => {
    expect(await runOn('a.HEIC', heicWithExif(appleTiff({ contentId: ID })))).toBe(ID);
  });

  it('records the identifier of a clip', async () => {
    expect(await runOn('a.MOV', quickTimeClip({ contentId: ID }))).toBe(ID);
  });

  it('records nothing for a still or clip that carries no identifier', async () => {
    expect(await runOn('b.JPG', jpegWithExif(appleTiff({ contentId: null })))).toBeNull();
    expect(await runOn('b.MOV', quickTimeClip({ contentId: null }))).toBeNull();
  });

  it('clears a previously recorded identifier once the original no longer carries one', async () => {
    await writeFile(path.join(dir, 'phone', 'edited.jpg'), jpegWithExif(null));
    const id = insertAsset(live.db, {});
    run(live.db, 'UPDATE assets SET live_content_id = ? WHERE id = ?', ID, id);

    apply(await livePhotoHandler(assetDoc(id, 'edited.jpg') as never, stageContext()));

    expect(contentId(id)).toBeNull();
  });

  it('skips files that cannot be half of a Live Photo without reading them', async () => {
    const id = insertAsset(live.db, {});
    const result = await livePhotoHandler(assetDoc(id, 'raw.dng') as never, stageContext());
    expect(result).toEqual({ skip: 'not-a-live-photo-candidate' });
  });

  it('runs independently of every other stage', () => {
    expect(livePhotoStage.name).toBe('live-photo');
    expect(livePhotoStage.dependsOn).toEqual([]);
  });
});
