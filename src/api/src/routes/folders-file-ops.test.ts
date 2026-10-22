/**
 * Route-integration tests for the path-addressed non-asset file
 * delete/relocate routes (#2535):
 *
 *   DELETE /api/folders/:id/file?path=<rel>
 *   POST   /api/folders/:id/file/relocate
 *
 * Both are addressed by `(folderID, relativePath)` — non-asset files
 * (`FileChild`) have no catalog id to key on.
 *
 * The handlers reach `sqliteDb()` with no override, so each test installs its
 * own database as the process-wide handle for the block.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Elysia } from 'elysia';
import { lstat, mkdtemp, readFile, rm, symlink, writeFile, mkdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as nodePath from 'node:path';
import {
  createLiveTestDatabase,
  insertAsset,
  insertFolder,
  insertLocation,
  type LiveTestDatabase,
} from '../db/sqlite/test-sqlite.test-helpers.ts';
import { foldersFileOpsRoutes } from './folders-file-ops.ts';
import { fakeAuth } from '../../tests/helpers/test-auth.ts';
import { serializeSidecarWrite } from '../fs/sidecar-write-order.ts';

/** One row of the change feed, as the table stores it. */
interface ChangeRow {
  kind: string;
  asset_id: string | null;
  folder_id: string | null;
  abs_path: string | null;
  relative_path: string | null;
}

describe('non-asset file delete/relocate routes', () => {
  const buildApp = () => new Elysia().use(fakeAuth()).use(foldersFileOpsRoutes);

  let live: LiveTestDatabase;
  let folderId: string;
  let folderPath: string;
  // Inferred from the construction below rather than annotated as a bare
  // `Elysia`: composing `.use(...)` widens the instance's route generics,
  // so the concrete value is not assignable to the default-generic type
  // (`tsc --noEmit` TS2322). Same Elysia quirk `changes.poll.test.ts` hits.
  let app: ReturnType<typeof buildApp>;

  beforeEach(async () => {
    live = await createLiveTestDatabase();
    folderPath = await mkdtemp(nodePath.join(tmpdir(), 'maple-file-ops-test-'));
    folderId = insertFolder(live.db, { path: folderPath, slug: 'file-ops-test' });
    app = buildApp();
  });

  afterEach(async () => {
    live.close();
    await rm(folderPath, { recursive: true, force: true }).catch(() => {});
  });

  /** Every change row, oldest first. */
  function changeRows(): ChangeRow[] {
    return live.db
      .query(
        `SELECT kind, asset_id, folder_id, abs_path, relative_path
           FROM asset_changes ORDER BY cursor ASC`,
      )
      .all() as ChangeRow[];
  }

  /** An indexed asset holding one location at `filename` in the test library. */
  function seedIndexedAsset(filename: string, missingSince?: string): string {
    const assetId = insertAsset(live.db);
    insertLocation(live.db, {
      assetId,
      libraryId: folderId,
      path: '',
      filename,
      missingSince: missingSince ?? null,
    });
    return assetId;
  }

  // -------------------------------------------------------------------
  // DELETE /:id/file — trash
  // -------------------------------------------------------------------

  it('trashes a non-asset file and emits a delete change with asset_id null', async () => {
    const target = 'notes.pdf';
    const absPath = nodePath.join(folderPath, target);
    await writeFile(absPath, 'not a real pdf');

    const url = `http://localhost/api/folders/${folderId}/file?path=${encodeURIComponent(target)}`;
    const res = await app.handle(new Request(url, { method: 'DELETE' }));
    expect(res.status).toBe(204);

    // The file must be gone from its original location...
    await expect(stat(absPath)).rejects.toThrow();
    // ...and present in the library's trash dir.
    const trashPath = nodePath.join(folderPath, '.maple', 'trash', target);
    const trashedStat = await stat(trashPath);
    expect(trashedStat.isFile()).toBe(true);

    const changes = changeRows();
    expect(changes.length).toBe(1);
    const change = changes[0]!;
    expect(change.kind).toBe('delete');
    expect(change.asset_id).toBeNull();
    expect(change.folder_id).toBe(folderId);
    expect(change.abs_path).toBe(absPath);
    expect(change.relative_path).toBe(target);
  });

  it('returns 404 when the target file does not exist', async () => {
    const url = `http://localhost/api/folders/${folderId}/file?path=missing.pdf`;
    const res = await app.handle(new Request(url, { method: 'DELETE' }));
    expect(res.status).toBe(404);
  });

  it('rejects a path-traversal attempt with 400', async () => {
    const url = `http://localhost/api/folders/${folderId}/file?path=${encodeURIComponent('../../etc/passwd')}`;
    const res = await app.handle(new Request(url, { method: 'DELETE' }));
    expect(res.status).toBe(400);
  });

  it('rejects deleting a path inside .maple/', async () => {
    await mkdir(nodePath.join(folderPath, '.maple', 'trash'), { recursive: true });
    await writeFile(nodePath.join(folderPath, '.maple', 'trash', 'ghost.pdf'), 'x');
    const url = `http://localhost/api/folders/${folderId}/file?path=${encodeURIComponent('.maple/trash/ghost.pdf')}`;
    const res = await app.handle(new Request(url, { method: 'DELETE' }));
    expect(res.status).toBe(400);
  });

  it('refuses to trash a path that is a LIVE indexed asset', async () => {
    const target = 'photo.jpg';
    const absPath = nodePath.join(folderPath, target);
    await writeFile(absPath, 'jpeg-ish bytes');
    seedIndexedAsset(target);

    const url = `http://localhost/api/folders/${folderId}/file?path=${encodeURIComponent(target)}`;
    const res = await app.handle(new Request(url, { method: 'DELETE' }));
    expect(res.status).toBe(409);
    // File must be untouched.
    const st = await stat(absPath);
    expect(st.isFile()).toBe(true);
  });

  it('trashes a path whose only asset row was reaped as missing', async () => {
    // The reaper stamps `missing_since` when a file disappears from disk; the
    // asset doc stays around (soft state, not a delete). A NEW non-asset file
    // that later lands on that same path is genuinely a `FileChild` and must
    // NOT be refused with a 409 pointing at the stale doc — "live" has to mean
    // both not-soft-deleted AND not-reaped.
    const target = 'reaped.jpg';
    const absPath = nodePath.join(folderPath, target);
    await writeFile(absPath, 'new bytes at an old path');
    seedIndexedAsset(target, new Date().toISOString());

    const url = `http://localhost/api/folders/${folderId}/file?path=${encodeURIComponent(target)}`;
    const res = await app.handle(new Request(url, { method: 'DELETE' }));
    expect(res.status).toBe(204);
  });

  it('refuses a dot-segment path that would smuggle past the indexed-asset guard', async () => {
    // Locks in that dot segments are rejected outright rather than resolved.
    // If they were ever allowed through, `sub/../photo.jpg` would collapse
    // back inside the root while `refuseIfIndexedAsset` split the RAW string
    // and looked for a literal `dir: "sub/.."` row that can never match — the
    // indexed-asset guard would silently miss, the file would be trashed, and
    // its live asset row would be orphaned in the catalog. Today `realpathJailCheck`
    // (library/address.ts) rejects `.`/`..` segments BEFORE calling realpath,
    // so this passes; the test exists so that ordering can't regress unnoticed.
    const target = 'photo.jpg';
    const absPath = nodePath.join(folderPath, target);
    await writeFile(absPath, 'jpeg-ish bytes');
    await mkdir(nodePath.join(folderPath, 'sub'), { recursive: true });
    seedIndexedAsset(target);

    const smuggled = `sub/../${target}`;
    const url = `http://localhost/api/folders/${folderId}/file?path=${encodeURIComponent(smuggled)}`;
    const res = await app.handle(new Request(url, { method: 'DELETE' }));
    expect(res.status).toBe(400);
    // The live asset's file must still be on disk — never trashed behind the guard.
    const st = await stat(absPath);
    expect(st.isFile()).toBe(true);
  });

  // -------------------------------------------------------------------
  // POST /:id/file/relocate — move/rename/copy
  // -------------------------------------------------------------------

  async function postRelocate(body: unknown): Promise<Response> {
    const url = `http://localhost/api/folders/${folderId}/file/relocate`;
    return app.handle(
      new Request(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    );
  }

  async function holdSave(sidecar: string, bytes: string) {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let entered!: () => void;
    const inside = new Promise<void>((resolve) => (entered = resolve));
    const save = serializeSidecarWrite(sidecar, async () => {
      entered();
      await gate;
      await writeFile(sidecar, bytes);
    });
    await inside;
    return { release, save };
  }

  it('a raw .xmp move waits for a save to its source, so the saved bytes move (#5134)', async () => {
    const sourceAbs = nodePath.join(folderPath, 'loose.xmp');
    await writeFile(sourceAbs, 'before');
    const held = await holdSave(sourceAbs, 'saved meanwhile');

    const moving = postRelocate({
      source_path: 'loose.xmp',
      mode: 'move',
      collision: 'auto-suffix',
      destination_path: '',
      destination_filename: 'moved.xmp',
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    held.release();
    await held.save;

    expect((await moving).status).toBe(200);
    expect(await readFile(nodePath.join(folderPath, 'moved.xmp'), 'utf8')).toBe('saved meanwhile');
    await expect(stat(sourceAbs)).rejects.toThrow();
  });

  it('a raw .xmp Replace through a symlinked folder waits for a save to the real file (#5134)', async () => {
    await mkdir(nodePath.join(folderPath, 'real'), { recursive: true });
    await symlink(nodePath.join(folderPath, 'real'), nodePath.join(folderPath, 'alias'));
    const realTarget = nodePath.join(folderPath, 'real/target.xmp');
    await writeFile(nodePath.join(folderPath, 'incoming.xmp'), 'incoming');
    await writeFile(realTarget, 'old');
    const held = await holdSave(realTarget, 'saved meanwhile');

    const replacing = postRelocate({
      source_path: 'incoming.xmp',
      mode: 'copy',
      collision: 'replace',
      destination_path: 'alias',
      destination_filename: 'target.xmp',
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await readFile(realTarget, 'utf8')).toBe('old');
    held.release();
    await held.save;

    expect((await replacing).status).toBe(200);
    expect(await readFile(realTarget, 'utf8')).toBe('incoming');
  });

  it('an alias retargeted while the save barrier is held cannot redirect a sidecar Replace', async () => {
    await mkdir(nodePath.join(folderPath, 'real'));
    await mkdir(nodePath.join(folderPath, 'other'));
    const alias = nodePath.join(folderPath, 'alias');
    await symlink(nodePath.join(folderPath, 'real'), alias);
    const target = nodePath.join(folderPath, 'real/target.xmp');
    const other = nodePath.join(folderPath, 'other/target.xmp');
    await writeFile(target, 'old');
    await writeFile(other, 'unrelated');
    await writeFile(nodePath.join(folderPath, 'incoming.xmp'), 'incoming');
    const held = await holdSave(target, 'saved meanwhile');
    const replacing = postRelocate({
      source_path: 'incoming.xmp',
      mode: 'copy',
      collision: 'replace',
      destination_path: 'alias',
      destination_filename: 'target.xmp',
    });
    try {
      await Bun.sleep(100);
      await rm(alias);
      await symlink(nodePath.join(folderPath, 'other'), alias);
      held.release();
      await held.save;
      const res = await replacing;
      expect(res.status).toBe(200);
      expect((await res.json()).new_path).toBe('real');
      expect(await readFile(target, 'utf8')).toBe('incoming');
      expect(await readFile(other, 'utf8')).toBe('unrelated');
    } finally {
      held.release();
      await held.save;
      await replacing;
    }
  });

  for (const mode of ['move', 'copy'] as const) {
    it(`a raw .xmp that is a symlink to a photo is refused (${mode}) (#5134)`, async () => {
      await writeFile(nodePath.join(folderPath, 'photo.dng'), 'original pixels');
      const link = nodePath.join(folderPath, 'photo.xmp');
      await symlink(nodePath.join(folderPath, 'photo.dng'), link);

      const res = await postRelocate({
        source_path: 'photo.xmp',
        mode,
        collision: 'auto-suffix',
        destination_path: 'elsewhere',
        destination_filename: 'photo.xmp',
      });

      expect(res.status).toBe(403);
      expect(await readFile(nodePath.join(folderPath, 'photo.dng'), 'utf8')).toBe(
        'original pixels',
      );
      expect((await lstat(link)).isSymbolicLink()).toBe(true);
      await expect(stat(nodePath.join(folderPath, 'elsewhere'))).rejects.toThrow();
    });
  }

  it('a raw .xmp moves into a folder that does not exist yet (#5134)', async () => {
    await writeFile(nodePath.join(folderPath, 'stray.xmp'), 'edit');

    const res = await postRelocate({
      source_path: 'stray.xmp',
      mode: 'move',
      collision: 'auto-suffix',
      destination_path: 'new/folder',
      destination_filename: 'stray.xmp',
    });

    expect(res.status).toBe(200);
    expect(await readFile(nodePath.join(folderPath, 'new/folder/stray.xmp'), 'utf8')).toBe('edit');
  });

  it('a raw .xmp Replace waits for a save to its destination, never racing it (#5134)', async () => {
    const sourceAbs = nodePath.join(folderPath, 'incoming.xmp');
    const destAbs = nodePath.join(folderPath, 'target.xmp');
    await writeFile(sourceAbs, 'incoming');
    await writeFile(destAbs, 'old');
    const held = await holdSave(destAbs, 'saved meanwhile');

    const replacing = postRelocate({
      source_path: 'incoming.xmp',
      mode: 'copy',
      collision: 'replace',
      destination_path: '',
      destination_filename: 'target.xmp',
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await readFile(destAbs, 'utf8')).toBe('old');
    held.release();
    await held.save;

    expect((await replacing).status).toBe(200);
    expect(await readFile(destAbs, 'utf8')).toBe('incoming');
  });

  it('renames a non-asset file (move, same dir) and emits delete+create changes', async () => {
    const source = 'clip.mov';
    const sourceAbs = nodePath.join(folderPath, source);
    await writeFile(sourceAbs, 'not a real mov');

    const res = await postRelocate({
      source_path: source,
      mode: 'move',
      collision: 'auto-suffix',
      destination_path: '',
      destination_filename: 'renamed.mov',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      new_abs_path: string;
      new_path: string;
      new_filename: string;
    };
    expect(body.new_filename).toBe('renamed.mov');
    expect(body.new_path).toBe('');

    await expect(stat(sourceAbs)).rejects.toThrow();
    const newAbs = nodePath.join(folderPath, 'renamed.mov');
    const st = await stat(newAbs);
    expect(st.isFile()).toBe(true);

    const changes = changeRows();
    expect(changes.length).toBe(2);
    expect(changes[0]!.kind).toBe('delete');
    expect(changes[0]!.relative_path).toBe(source);
    expect(changes[0]!.asset_id).toBeNull();
    expect(changes[1]!.kind).toBe('create');
    expect(changes[1]!.relative_path).toBe('renamed.mov');
    expect(changes[1]!.asset_id).toBeNull();
  });

  it('moves a non-asset file into a subdirectory', async () => {
    const source = 'doc.pdf';
    await writeFile(nodePath.join(folderPath, source), 'pdf bytes');
    await mkdir(nodePath.join(folderPath, 'archive'), { recursive: true });

    const res = await postRelocate({
      source_path: source,
      mode: 'move',
      collision: 'auto-suffix',
      destination_path: 'archive',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { new_path: string; new_filename: string };
    expect(body.new_path).toBe('archive');
    expect(body.new_filename).toBe(source);
    const st = await stat(nodePath.join(folderPath, 'archive', source));
    expect(st.isFile()).toBe(true);
  });

  it('copies a non-asset file and emits only a create change', async () => {
    const source = 'archive.zip';
    const sourceAbs = nodePath.join(folderPath, source);
    await writeFile(sourceAbs, 'zip bytes');

    const res = await postRelocate({
      source_path: source,
      mode: 'copy',
      collision: 'auto-suffix',
      destination_path: '',
      destination_filename: 'archive-copy.zip',
    });
    expect(res.status).toBe(200);

    // Source survives a copy.
    const srcStat = await stat(sourceAbs);
    expect(srcStat.isFile()).toBe(true);
    const dstStat = await stat(nodePath.join(folderPath, 'archive-copy.zip'));
    expect(dstStat.isFile()).toBe(true);

    const changes = changeRows();
    expect(changes.length).toBe(1);
    expect(changes[0]!.kind).toBe('create');
    expect(changes[0]!.relative_path).toBe('archive-copy.zip');
  });

  it('refuses to relocate a path that is a LIVE indexed asset', async () => {
    const source = 'photo.jpg';
    await writeFile(nodePath.join(folderPath, source), 'jpeg-ish');
    seedIndexedAsset(source);

    const res = await postRelocate({
      source_path: source,
      mode: 'move',
      collision: 'auto-suffix',
      destination_path: '',
      destination_filename: 'moved.jpg',
    });
    expect(res.status).toBe(409);
  });

  it('rejects a destination_path traversal attempt with 400', async () => {
    const source = 'doc.pdf';
    await writeFile(nodePath.join(folderPath, source), 'pdf bytes');
    const res = await postRelocate({
      source_path: source,
      mode: 'move',
      collision: 'auto-suffix',
      destination_path: '../../etc',
    });
    expect(res.status).toBe(400);
  });
});
