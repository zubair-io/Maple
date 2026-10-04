import { test, expect } from 'bun:test';
import {
  mkdtemp,
  realpath,
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
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { ObjectId } from '../db/object-id.ts';
import { createLiveTestDatabase } from '../db/sqlite/test-sqlite.test-helpers.ts';
import { registerRoot, unregisterRoot } from '../fs/root.ts';
import { recoverBackup, recoveryPreview } from './restore.ts';
import type { BackupManifest, BackupObject, BackupProvider } from './provider.ts';
import type { JobHandlerContext } from '../job-runner/handlers/index.ts';

const libraryId = 'a'.repeat(24),
  entryId = 'b'.repeat(24),
  assetId = 'c'.repeat(24);
const source = { destinationId: 'destination', rootId: 'google-root', accountId: 'google-account' };
class MemoryProvider implements BackupProvider {
  objects = new Map<string, { object: BackupObject; bytes: Uint8Array }>();
  downloads: string[] = [];
  stallKey: string | null = null;
  cancelled = false;
  put(key: string, value: string): BackupObject {
    const bytes = new TextEncoder().encode(value);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const actualKey = key.includes('/blobs/')
      ? key.slice(0, key.indexOf('/blobs/') + 7) + sha256
      : key;
    const object = {
      key: actualKey,
      locator: actualKey,
      size: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
    this.objects.set(actualKey, { object, bytes });
    return object;
  }
  manifest(sequence = 1, state: 'active' | 'trash' = 'active', id = entryId): BackupManifest {
    const prefix = `libraries/${libraryId}/entries/${id}/`;
    const name = state === 'trash' ? '.maple/trash/photo.jpg' : 'photo.jpg';
    const object = this.put(`${prefix}blobs/${sequence}-original`, `${id}-version-${sequence}`);
    const manifest: BackupManifest = {
      version: 1,
      libraryId,
      entryId: id,
      assetId,
      sequence,
      state,
      originalPath: 'photo.jpg',
      currentPath: name,
      deletedAt: state === 'trash' ? '2026-10-04T00:00:00Z' : null,
      hidden: false,
      files: [{ path: name, role: 'original', object }],
    };
    this.saveManifest(manifest);
    return manifest;
  }
  saveManifest(manifest: BackupManifest) {
    this.put(
      `libraries/${manifest.libraryId}/entries/${manifest.entryId}/manifests/${manifest.sequence}.json`,
      JSON.stringify(manifest),
    );
  }
  async probe() {}
  async *list(prefix: string) {
    for (const row of this.objects.values())
      if (row.object.key.startsWith(prefix)) yield row.object;
  }
  async inspect(key: string) {
    return this.objects.get(key)?.object ?? null;
  }
  async download(object: BackupObject) {
    this.downloads.push(object.key);
    if (object.key === this.stallKey)
      return new ReadableStream<Uint8Array>({
        cancel: () => {
          this.cancelled = true;
        },
      });
    const bytes = this.objects.get(object.key)!.bytes;
    return new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });
  }
  async publish(): Promise<BackupObject> {
    throw new Error('Read-only recovery test provider');
  }
  async remove(object: BackupObject) {
    this.objects.delete(object.key);
  }
  async abort() {}
}
async function fixture() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'maple-recovery-')));
  registerRoot(root);
  const live = await createLiveTestDatabase();
  const provider = new MemoryProvider();
  const jobId = new ObjectId();
  let checkpoint: Record<string, unknown> | undefined;
  const ctx: JobHandlerContext = {
    jobId,
    saveCheckpoint: async (value) => {
      checkpoint = value;
    },
    shouldCancel: async () => false,
    reportProgress: async () => {},
  };
  return {
    root,
    live,
    provider,
    ctx,
    request: { targetPath: root, includeTrash: true },
    checkpoint: () => checkpoint,
    async close() {
      live.close();
      unregisterRoot(root);
      await rm(root, { recursive: true, force: true });
    },
  };
}

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

test('checkpoint-before-first-file crash resumes the pinned manifest even after catalog advances', async () => {
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
    expect((await recoverBackup(f.provider, f.request, f.ctx, source)).kind).toBe('done');
    expect(await readFile(path.join(f.root, 'photo.jpg'), 'utf8')).toBe(`${entryId}-version-1`);
    expect(f.live.db.query('SELECT COUNT(*) AS n FROM assets').get()).toEqual({ n: 1 });
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
    ).rejects.toThrow('source or selection changed');
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
    const prefix = `libraries/${libraryId}/entries/${trash.entryId}/blobs/`;
    const xmp = '<x:xmpmeta>\n unknown-fields-exact \n</x:xmpmeta>';
    trash.hidden = true;
    trash.files.push(
      {
        path: '.maple/trash/photo.xmp',
        role: 'sidecar',
        object: f.provider.put(`${prefix}xmp`, xmp),
      },
      {
        path: '.maple/trash/photo-rendered.jpg',
        role: 'companion',
        object: f.provider.put(`${prefix}companion`, 'rendered-companion'),
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
      `libraries/${libraryId}/entries/${trash.entryId}/blobs/same-content`,
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

test('published-file crash resumes verified bytes and cleans only this job temporary journal', async () => {
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
    const before = f.provider.downloads.filter((key) => key.includes('/blobs/')).length;
    expect(
      (await recoverBackup(f.provider, f.request, { ...f.ctx, checkpoint: f.checkpoint() }, source))
        .kind,
    ).toBe('done');
    expect(f.provider.downloads.filter((key) => key.includes('/blobs/')).length).toBe(before);
    expect(await readFile(path.join(f.root, 'photo.jpg'), 'utf8')).toBe(`${entryId}-version-1`);
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
