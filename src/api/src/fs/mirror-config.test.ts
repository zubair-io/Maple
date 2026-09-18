/**
 * loadMirrorConfig tests — verifies the persisted `FolderDoc.mirrors` config is
 * hydrated into the in-memory registry the mirror-aware fs shim consults.
 *
 * This is the call the worker tier was missing: without it `isMirroringActive()`
 * is false in the worker process, so every mirror-aware write there (backup-
 * folder migrations, imports, trash deletes) silently resolves to zero targets
 * and the mirror drifts — and the scan/copy reconcile that should catch the
 * drift is itself gated off. A regression here would re-break worker-side
 * mirroring, so it is worth a direct test.
 *
 * `loadMirrorConfig` reaches the process-wide handle with no override, so the
 * database is installed as that handle for the duration of each test.
 */

import { describe, it, expect, afterEach, beforeEach } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createLiveTestDatabase,
  insertFolder,
  run,
  type LiveTestDatabase,
} from '../db/sqlite/test-sqlite.test-helpers.ts';
import { clearMirrorRoots, isMirroringActive, snapshotMirrorRoots } from './mirror-registry.ts';
import { loadMirrorConfig } from './mirror-config.ts';

let live: LiveTestDatabase;

/** Register a library with one mirror, enabled or not. */
function libraryWithMirror(enabled: boolean): { primary: string; mirror: string } {
  const primary = mkdtempSync(join(tmpdir(), 'cfg-primary-'));
  const mirror = mkdtempSync(join(tmpdir(), 'cfg-mirror-'));
  const id = insertFolder(live.db, { path: primary });
  run(
    live.db,
    `UPDATE folders SET mirrors = ? WHERE id = ?`,
    JSON.stringify([{ path: mirror, enabled }]),
    id,
  );
  return { primary, mirror };
}

describe('loadMirrorConfig', () => {
  beforeEach(async () => {
    live = await createLiveTestDatabase();
    clearMirrorRoots();
  });

  afterEach(() => {
    clearMirrorRoots();
    live.close();
  });

  it('hydrates enabled mirror roots into the registry', async () => {
    const { primary, mirror } = libraryWithMirror(true);
    expect(isMirroringActive()).toBe(false); // nothing loaded yet

    await loadMirrorConfig();

    expect(isMirroringActive()).toBe(true);
    expect(snapshotMirrorRoots()[primary]).toEqual([mirror]);
  });

  it('excludes disabled mirrors', async () => {
    libraryWithMirror(false);

    await loadMirrorConfig();

    expect(isMirroringActive()).toBe(false);
  });

  it('ignores a library whose mirror list is empty', async () => {
    const primary = mkdtempSync(join(tmpdir(), 'cfg-primary-'));
    const id = insertFolder(live.db, { path: primary });
    run(live.db, `UPDATE folders SET mirrors = ? WHERE id = ?`, '[]', id);

    await loadMirrorConfig();

    expect(isMirroringActive()).toBe(false);
  });
});
