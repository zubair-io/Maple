import { test, expect } from 'bun:test';
import {
  rm,
  readFile,
  readdir,
  mkdir,
  rename,
  symlink,
  copyFile,
  unlink,
  writeFile,
} from '../fs/mirrored.ts';
import * as path from 'node:path';
import { recoverBackup, recoveryPreview } from './restore.ts';
import { recoveryFixture as fixture, libraryId, entryId, source } from './restore.test-helpers.ts';
import type { BackupManifest } from './provider.ts';

test('recovery continues to read manifests created before the mirror layout', async () => {
  const f = await fixture();
  try {
    const current = f.provider.manifest(1);
    const file = current.files[0]!;
    const oldKey = `libraries/${libraryId}/entries/${entryId}/blobs/${file.object.sha256}`;
    const stored = f.provider.objects.get(file.object.key)!;
    f.provider.objects.delete(file.object.key);
    stored.object.key = oldKey;
    f.provider.objects.set(oldKey, stored);
    const legacy: BackupManifest = {
      ...current,
      files: [{ ...file, object: { ...file.object, key: oldKey } }],
    };
    f.provider.saveManifest(legacy);

    expect((await recoverBackup(f.provider, f.request, f.ctx, source)).kind).toBe('done');
    expect(await readFile(path.join(f.root, 'photo.jpg'), 'utf8')).toBe(`${entryId}-version-1`);
  } finally {
    await f.close();
  }
});

test('preview rejects a partial version selection instead of broadening to a whole library', async () => {
  const f = await fixture();
  try {
    f.provider.manifest(1);
    await expect(recoveryPreview(f.provider, { ...f.request, entryId })).rejects.toThrow(
      'Invalid recovery version selection',
    );
    await expect(recoveryPreview(f.provider, { ...f.request, sequence: 1 })).rejects.toThrow(
      'Invalid recovery version selection',
    );
    expect(await readdir(f.root)).toEqual([]);
  } finally {
    await f.close();
  }
});

test('a recovery checkpoint refuses to continue after the mirrored source version changes', async () => {
  const f = await fixture();
  try {
    f.provider.manifest(1);
    await expect(
      recoverBackup(
        f.provider,
        f.request,
        {
          ...f.ctx,
          saveCheckpoint: async () => {
            throw new Error('crash');
          },
        },
        source,
      ),
    ).rejects.toThrow('crash');
    f.provider.manifest(2);
    await expect(recoverBackup(f.provider, f.request, f.ctx, source)).rejects.toThrow(
      'coverage is incomplete',
    );
    expect(f.live.db.query('SELECT COUNT(*) AS n FROM assets').get()).toEqual({ n: 0 });
  } finally {
    await f.close();
  }
});

test('resume rejects changed cloud root and a replacement local recovery directory', async () => {
  const f = await fixture();
  const displaced = `${f.root}-old`;
  try {
    f.provider.manifest();
    await expect(
      recoverBackup(
        f.provider,
        f.request,
        {
          ...f.ctx,
          saveCheckpoint: async () => {
            throw new Error('crash');
          },
        },
        source,
      ),
    ).rejects.toThrow();
    await expect(
      recoverBackup(f.provider, f.request, f.ctx, { ...source, rootId: 'replacement' }),
    ).rejects.toThrow();
    await rename(f.root, displaced);
    await mkdir(f.root);
    await symlink(
      path.join(displaced, `.maple-recovery-${f.ctx.jobId.toHexString()}.json`),
      path.join(f.root, `.maple-recovery-${f.ctx.jobId.toHexString()}.json`),
    );
    await expect(recoverBackup(f.provider, f.request, f.ctx, source)).rejects.toThrow();
    const marker = `.maple-recovery-${f.ctx.jobId.toHexString()}.json`;
    await unlink(path.join(f.root, marker));
    await copyFile(path.join(displaced, marker), path.join(f.root, marker));
    await expect(recoverBackup(f.provider, f.request, f.ctx, source)).rejects.toThrow(
      'directory ownership changed',
    );
  } finally {
    await f.close();
    await rm(displaced, { recursive: true, force: true });
  }
});

test('resumed already verified files are checked against purge records', async () => {
  const f = await fixture();
  try {
    f.provider.manifest();
    await expect(
      recoverBackup(
        f.provider,
        f.request,
        {
          ...f.ctx,
          reportProgress: async () => {
            throw new Error('crash');
          },
        },
        source,
      ),
    ).rejects.toThrow();
    f.provider.put(
      `purges/${entryId}.json`,
      JSON.stringify({
        version: 1,
        libraryId,
        entryId,
        sequence: 2,
        purgedAt: '2026-10-04T00:00:00Z',
      }),
    );
    await expect(
      recoverBackup(f.provider, f.request, { ...f.ctx, checkpoint: f.checkpoint() }, source),
    ).rejects.toThrow('purged during recovery');
    expect(f.live.db.query('SELECT COUNT(*) AS n FROM assets').get()).toEqual({ n: 0 });
  } finally {
    await f.close();
  }
});

test('indexes actual Trash path alongside same original name, restores hidden and Apple companion, preserves XMP bytes', async () => {
  const f = await fixture();
  try {
    f.provider.manifest();
    const trash = f.provider.manifest(1, 'trash', 'd'.repeat(24));
    const xmp = '<x:xmpmeta>\n unknown-fields-exact \n</x:xmpmeta>';
    trash.hidden = true;
    trash.files.push(
      {
        path: '.maple/trash/photo.xmp',
        role: 'sidecar',
        object: f.provider.put(`mirror/${libraryId}/.maple/trash/photo.xmp`, xmp),
      },
      {
        path: '.maple/trash/photo-rendered.jpg',
        role: 'companion',
        object: f.provider.put(
          `mirror/${libraryId}/.maple/trash/photo-rendered.jpg`,
          'rendered-companion',
        ),
      },
    );
    f.provider.saveManifest(trash);
    expect((await recoverBackup(f.provider, f.request, f.ctx, source)).kind).toBe('done');
    expect(await readFile(path.join(f.root, '.maple/trash/photo.xmp'), 'utf8')).toBe(xmp);
    const row = f.live.db
      .query(
        `SELECT a.hidden,a.deleted_at,a.original_path,a.apple_rendered_path,l.path
      FROM assets a JOIN asset_locations l ON a.id=l.asset_id WHERE l.path='.maple/trash'`,
      )
      .get();
    expect(row).toEqual({
      hidden: 1,
      deleted_at: trash.deletedAt,
      original_path: path.join(f.root, 'photo.jpg'),
      apple_rendered_path: '.maple/trash/photo-rendered.jpg',
      path: '.maple/trash',
    });
    expect(await readFile(path.join(f.root, 'photo.jpg'), 'utf8')).toBe(`${entryId}-version-1`);
  } finally {
    await f.close();
  }
});

test('cancels a stalled download reader without publishing partial bytes', async () => {
  const f = await fixture();
  try {
    const manifest = f.provider.manifest();
    f.provider.stallKey = manifest.files[0]!.object.key;
    const result = await recoverBackup(
      f.provider,
      f.request,
      { ...f.ctx, shouldCancel: async () => f.provider.downloads.includes(f.provider.stallKey!) },
      source,
    );
    expect(result.kind).toBe('cancelled');
    expect(f.provider.cancelled).toBe(true);
    expect((await readdir(f.root)).filter((name) => !name.endsWith('.json'))).toEqual([]);
  } finally {
    await f.close();
  }
});

test('metadata conflict rolls back indexing without deleting an existing live dedup photo', async () => {
  const f = await fixture();
  try {
    const active = f.provider.manifest();
    const trash = f.provider.manifest(1, 'trash', 'd'.repeat(24));
    trash.files[0]!.object = f.provider.put(
      `mirror/${libraryId}/${trash.currentPath}`,
      `${entryId}-version-1`,
    );
    f.provider.saveManifest(trash);
    await expect(recoverBackup(f.provider, f.request, f.ctx, source)).rejects.toThrow(
      'metadata conflicts',
    );
    const row = f.live.db.query('SELECT deleted_at,hidden FROM assets').get();
    expect(row).toEqual({ deleted_at: null, hidden: 0 });
    expect(f.live.db.query('SELECT COUNT(*) AS n FROM asset_locations').get()).toEqual({ n: 1 });
    expect(await readFile(path.join(f.root, active.currentPath), 'utf8')).toBe(
      `${entryId}-version-1`,
    );
    expect(await readFile(path.join(f.root, trash.currentPath), 'utf8')).toBe(
      `${entryId}-version-1`,
    );
  } finally {
    await f.close();
  }
});

test('checksum failure leaves no final photo and replay rejects a symlink at an owned file path', async () => {
  const f = await fixture();
  try {
    const manifest = f.provider.manifest();
    const row = f.provider.objects.get(manifest.files[0]!.object.key)!;
    row.bytes = new TextEncoder().encode('wrong-bytes');
    await expect(recoverBackup(f.provider, f.request, f.ctx, source)).rejects.toThrow(
      'checksum mismatch',
    );
    expect((await readdir(f.root)).filter((name) => name.endsWith('.jpg'))).toEqual([]);
    await symlink('/etc/hosts', path.join(f.root, 'photo.jpg'));
    await expect(
      recoverBackup(f.provider, f.request, { ...f.ctx, checkpoint: f.checkpoint() }, source),
    ).rejects.toThrow('overwrite');
  } finally {
    await f.close();
  }
});

test('published-file recovery refuses to resume after the current mirrored file changes', async () => {
  const f = await fixture();
  try {
    f.provider.manifest();
    await expect(
      recoverBackup(
        f.provider,
        f.request,
        {
          ...f.ctx,
          reportProgress: async () => {
            throw new Error('crash');
          },
        },
        source,
      ),
    ).rejects.toThrow();
    await writeFile(
      path.join(f.root, `.maple-recovery-${f.ctx.jobId.toHexString()}.json.pending`),
      'partial journal',
    );
    f.provider.manifest(2);
    const before = f.provider.downloads.filter((key) => key.startsWith('mirror/')).length;
    await expect(
      recoverBackup(f.provider, f.request, { ...f.ctx, checkpoint: f.checkpoint() }, source),
    ).rejects.toThrow('coverage is incomplete');
    expect(f.provider.downloads.filter((key) => key.startsWith('mirror/')).length).toBe(before);
    expect((await readdir(f.root)).filter((name) => name.endsWith('.pending'))).toEqual([]);
  } finally {
    await f.close();
  }
});

test('preview reports missing backup bytes and recovery refuses to begin publishing', async () => {
  const f = await fixture();
  try {
    const manifest = f.provider.manifest();
    f.provider.objects.delete(manifest.files[0]!.object.key);
    const preview = await recoveryPreview(f.provider, f.request);
    expect(preview.files).toBe(1);
    expect(preview.gaps).toEqual([
      'photo.jpg: backup object is missing or outside the backup root',
    ]);
    await expect(recoverBackup(f.provider, f.request, f.ctx, source)).rejects.toThrow(
      'coverage is incomplete',
    );
    expect(await readdir(f.root)).toEqual([]);
    expect(f.live.db.query('SELECT COUNT(*) AS n FROM assets').get()).toEqual({ n: 0 });
  } finally {
    await f.close();
  }
});

test('preview verifies exact object locator, key, size and checksum and names unverifiable files', async () => {
  const f = await fixture();
  try {
    const manifest = f.provider.manifest();
    const expected = manifest.files[0]!.object;
    for (const patch of [
      { key: 'different-key' },
      { locator: 'replacement-id' },
      { size: expected.size + 1 },
      { sha256: '0'.repeat(64) },
    ]) {
      f.provider.objects.set(expected.key, {
        object: { ...expected, ...patch },
        bytes: new Uint8Array(),
      });
      expect((await recoveryPreview(f.provider, f.request)).gaps).toEqual([
        'photo.jpg: backup object identity changed',
      ]);
    }
    f.provider.inspect = async () => {
      throw new Error('Provider unavailable');
    };
    expect((await recoveryPreview(f.provider, f.request)).gaps).toEqual([
      'photo.jpg: backup object could not be verified',
    ]);
  } finally {
    await f.close();
  }
});

test('export and batch sync on an existing library still work after a cloud-backup restore with MAPLE_ROOTS unset (#4747)', async () => {
  const f = await fixture();
  const originalMapleRoots = process.env.MAPLE_ROOTS;
  const { mkdtemp, realpath } = await import('../fs/mirrored.ts');
  const { tmpdir } = await import('node:os');
  const { createHash, randomUUID } = await import('node:crypto');
  const { unregisterRoot } = await import('../fs/root.ts');
  const { insertFolder } = await import('../db/sqlite/test-sqlite.test-helpers.ts');
  const { invalidateLibraryRoots } = await import('../indexer/libraries.cache.ts');
  const { batchAdjustmentSyncHandler } =
    await import('../job-runner/handlers/batch-adjustment-sync.ts');
  const { publishExport } = await import('../export/export-files.ts');
  const { exportOriginals } = await import('../export/export-originals.ts');
  const { DEFAULT_EXPORT_RECIPE } = await import('../generated/export-recipe.generated.ts');

  const existingRoot = await realpath(await mkdtemp(path.join(tmpdir(), 'maple-existing-lib-')));
  try {
    delete process.env.MAPLE_ROOTS;
    insertFolder(f.live.db, { path: existingRoot, slug: 'existing' });
    invalidateLibraryRoots();

    const existingPhoto = path.join(existingRoot, 'existing.jpg');
    const existingSidecar = path.join(existingRoot, 'existing.xmp');
    await writeFile(existingPhoto, 'existing-original-bytes');
    await writeFile(
      existingSidecar,
      '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about=""/></rdf:RDF>',
    );

    // Run cloud-backup restore into f.root. Previously this called registerRoot(f.root)
    // in the worker and locked out every other library root in SQLite.
    f.provider.manifest(1);
    expect((await recoverBackup(f.provider, f.request, f.ctx, source)).kind).toBe('done');
    // Clear the test-fixture's in-memory root registration so authorization relies
    // exclusively on the shared SQLite `folders` rows for both existingRoot and f.root.
    unregisterRoot(f.root);

    // 1. Batch adjustment sync on the pre-existing library still succeeds.
    let syncCheckpoint: Record<string, unknown> | undefined;
    const syncOutcome = await batchAdjustmentSyncHandler.run(
      {
        targets: [{ id: 'existing:existing.jpg', path: existingPhoto }],
        patch: { attributes: { 'crs:Exposure2012': '0.75' }, elements: {} },
      },
      {
        jobId: f.ctx.jobId,
        checkpoint: syncCheckpoint,
        saveCheckpoint: async (value) => {
          syncCheckpoint = value;
        },
        reportProgress: async () => {},
        shouldCancel: async () => false,
      },
    );
    expect(syncOutcome.kind).toBe('done');
    expect(syncOutcome.result['applied']).toEqual(['existing:existing.jpg']);
    expect(await readFile(existingSidecar, 'utf8')).toContain('crs:Exposure2012="0.75"');

    // 2. Export publication into the pre-existing library still succeeds.
    const exportDir = path.join(existingRoot, 'exports');
    await mkdir(exportDir, { recursive: true });
    const jobIdHex = f.ctx.jobId.toHexString();
    const stagedBytes = 'exported-jpeg-bytes';
    const tempPath = path.join(exportDir, `.maple-export-${jobIdHex}-${randomUUID()}.tmp`);
    const outputPath = path.join(exportDir, 'existing.jpg');
    await writeFile(tempPath, stagedBytes);
    const afterHash = createHash('sha256').update(stagedBytes).digest('hex');

    const recipe = {
      ...DEFAULT_EXPORT_RECIPE,
      destination: 'directory' as const,
      directory: exportDir,
      overwritePolicy: 'error' as const,
    };
    const originals = await exportOriginals(
      {
        targets: [
          {
            id: 'existing:existing.jpg',
            path: existingPhoto,
            xmp: '',
            index: 0,
            capturedAt: null,
          },
        ],
        recipe,
      },
      { originalPaths: [existingPhoto] },
    );

    const published = await publishExport(
      {
        id: 'existing:existing.jpg',
        status: 'prepared',
        tempPath,
        outputPath,
        beforeHash: null,
        afterHash,
      },
      recipe,
      jobIdHex,
      originals,
    );
    expect(published.status).toBe('applied');
    expect(await readFile(outputPath, 'utf8')).toBe(stagedBytes);
  } finally {
    if (originalMapleRoots === undefined) delete process.env.MAPLE_ROOTS;
    else process.env.MAPLE_ROOTS = originalMapleRoots;
    await f.close();
    await rm(existingRoot, { recursive: true, force: true });
    invalidateLibraryRoots();
  }
});
