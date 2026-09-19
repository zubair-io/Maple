/**
 * Route-integration tests: DELETE /api/assets/:id `intent` parameter (#2749).
 *
 * The endpoint is dual-mode — a live asset is soft-deleted, an already-
 * trashed one is PERMANENTLY purged — decided by server-side state the
 * caller may hold a stale copy of. `intent=trash|purge` pins the caller's
 * meaning: a state mismatch becomes a 409 instead of a silent flip into
 * the other (possibly irreversible) branch. Omitting `intent` preserves
 * the legacy dual-mode contract the deployed File Provider extension
 * depends on.
 *
 * Real temp dirs, no fs mocks, and one real SQLite database per test (#3787)
 * installed as the process-wide handle the route resolves.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Elysia } from 'elysia';
import { mkdtemp, rm, mkdir, writeFile, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as nodePath from 'node:path';
import { trashRoutes } from './trash.ts';
import { fakeAuth } from '../../../tests/helpers/test-auth.ts';
import { assetRow, registerLibrary } from '../../../tests/helpers/assets-route-fixtures.ts';
import {
  createLiveTestDatabase,
  insertAsset,
  insertLocation,
  run,
  type LiveTestDatabase,
} from '../../db/sqlite/test-sqlite.test-helpers.ts';

describe('DELETE /api/assets/:id intent parameter', () => {
  let live: LiveTestDatabase;
  let libraryId: string;
  let folderPath: string;

  beforeEach(async () => {
    live = await createLiveTestDatabase();
    folderPath = await mkdtemp(nodePath.join(tmpdir(), 'trash-intent-route-'));
    libraryId = registerLibrary(live.db, folderPath, 'trash-intent-route-test');
  });

  afterEach(async () => {
    live.close();
    await rm(folderPath, { recursive: true, force: true }).catch(() => {});
  });

  /** Seed one asset; `trashed` controls whether it starts life in the trash
   * (both the catalogue flag and the physical `.maple/trash` location, so either
   * DELETE branch acts on a real file). Returns the asset id and the
   * current absolute path of its primary file. */
  async function seedAsset(trashed: boolean): Promise<{ id: string; absPath: string }> {
    const filename = 'IMG_1.dng';
    const relDir = trashed ? nodePath.join('.maple', 'trash', 'sub') : 'sub';
    const absDir = nodePath.join(folderPath, relDir);
    await mkdir(absDir, { recursive: true });
    const absPath = nodePath.join(absDir, filename);
    await writeFile(absPath, 'pixels');
    const id = insertAsset(live.db, {
      deletedAt: trashed ? new Date().toISOString() : null,
    });
    // A REAL trashed asset keeps its location live (deleted_at null) with the
    // path repointed into .maple/trash — only the ASSET's deleted_at is
    // stamped. See asset-trash.ts's markSoftDeleted doc comment; seeding the
    // location as deleted made assetAbsPath resolve nothing and 404 the purge
    // branch.
    insertLocation(live.db, {
      assetId: id,
      libraryId,
      path: relDir.split(nodePath.sep).join('/'),
      filename,
    });
    run(
      live.db,
      `UPDATE assets SET size = 6, mtime = 1700000000000, original_path = ? WHERE id = ?`,
      trashed ? `sub/${filename}` : null,
      id,
    );
    return { id, absPath };
  }

  function call(id: string, intent?: string): Promise<Response> {
    const app = new Elysia().use(fakeAuth()).group('/api/assets', (g) => g.use(trashRoutes));
    const q = intent === undefined ? '' : `?intent=${intent}`;
    return app.handle(new Request(`http://localhost/api/assets/${id}${q}`, { method: 'DELETE' }));
  }

  it('intent=trash on a live asset soft-deletes it (204)', async () => {
    const { id, absPath } = await seedAsset(false);
    const res = await call(id, 'trash');
    expect(res.status).toBe(204);
    // Original location vacated; catalogue row soft-deleted, not purged.
    await expect(stat(absPath)).rejects.toThrow();
    const row = assetRow(live.db, id);
    expect(row).not.toBeNull();
    expect(row!.deleted_at).not.toBeNull();
  });

  it('intent=trash on an ALREADY-TRASHED asset is a 409, never a purge', async () => {
    const { id, absPath } = await seedAsset(true);
    const res = await call(id, 'trash');
    expect(res.status).toBe(409);
    const body = (await res.json()) as { state?: string };
    expect(body.state).toBe('trashed');
    // The load-bearing half: the trashed file and its catalogue row both
    // survive — the legacy behavior here would have PERMANENTLY purged them.
    const s = await stat(absPath);
    expect(s.size).toBe(6);
    expect(assetRow(live.db, id)).not.toBeNull();
  });

  it('intent=purge on a REAPED asset deletes the row without unlinking its stored path (#2977)', async () => {
    // A reaped row's location points at the ORIGINAL library address (no
    // .maple/trash copy exists) — and the photo quietly returned there.
    // An explicit purge must delete the catalogue row only, never the file.
    const absDir = nodePath.join(folderPath, 'sub');
    await mkdir(absDir, { recursive: true });
    const absPath = nodePath.join(absDir, 'BACK.dng');
    await writeFile(absPath, 'returned-pixels');
    await writeFile(nodePath.join(absDir, 'BACK.xmp'), '<xmp/>');
    const id = insertAsset(live.db, { deletedAt: '2026-08-10T00:00:00.000Z' });
    insertLocation(live.db, {
      assetId: id,
      libraryId,
      path: 'sub',
      filename: 'BACK.dng',
      missingSince: '2026-08-01T00:00:00.000Z',
    });
    run(
      live.db,
      `UPDATE assets SET size = 6, mtime = 1700000000000, deleted_reason = 'reaped' WHERE id = ?`,
      id,
    );

    const res = await call(id, 'purge');
    expect(res.status).toBe(204);
    expect(assetRow(live.db, id)).toBeNull();
    // The returned photo + sidecar are untouched.
    expect(await readFile(absPath, 'utf8')).toBe('returned-pixels');
    expect(await readFile(nodePath.join(absDir, 'BACK.xmp'), 'utf8')).toBe('<xmp/>');
  });

  it('intent=purge on a trashed asset purges it (204)', async () => {
    const { id, absPath } = await seedAsset(true);
    const res = await call(id, 'purge');
    expect(res.status).toBe(204);
    await expect(stat(absPath)).rejects.toThrow();
    expect(assetRow(live.db, id)).toBeNull();
  });

  it('intent=purge on a LIVE asset is a 409, never a trash', async () => {
    const { id, absPath } = await seedAsset(false);
    const res = await call(id, 'purge');
    expect(res.status).toBe(409);
    const body = (await res.json()) as { state?: string };
    expect(body.state).toBe('live');
    // Untouched: still at its original path, still live in the catalogue.
    const s = await stat(absPath);
    expect(s.size).toBe(6);
    expect(assetRow(live.db, id)!.deleted_at).toBeNull();
  });

  it('rejects an unknown intent with 400', async () => {
    const { id } = await seedAsset(false);
    const res = await call(id, 'obliterate');
    expect(res.status).toBe(400);
  });

  it('legacy no-intent call keeps the dual-mode contract: live → trash', async () => {
    const { id, absPath } = await seedAsset(false);
    const res = await call(id);
    expect(res.status).toBe(204);
    await expect(stat(absPath)).rejects.toThrow();
    expect(assetRow(live.db, id)!.deleted_at).not.toBeNull();
  });

  it('legacy no-intent call keeps the dual-mode contract: trashed → purge', async () => {
    const { id, absPath } = await seedAsset(true);
    const res = await call(id);
    expect(res.status).toBe(204);
    await expect(stat(absPath)).rejects.toThrow();
    expect(assetRow(live.db, id)).toBeNull();
  });
});
