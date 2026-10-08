import { expect, spyOn, test } from 'bun:test';
import * as path from 'node:path';
import { readFile, readdir } from '../../fs/mirrored.ts';
import { insertFolder } from '../../db/sqlite/test-sqlite.test-helpers.ts';
import { backupEngine } from '../../cloud-backup/runtime.ts';
import { providerForDestination } from '../../cloud-backup/google/factory.ts';
import { recoveryFixture, entryId } from '../../cloud-backup/restore.test-helpers.ts';
import type { BackupDestination } from '../../cloud-backup/repository.ts';
import { cloudBackupRestoreHandler } from './cloud-backup-restore.ts';

async function fixture() {
  const f = await recoveryFixture();
  const libraryId = insertFolder(f.live.db, { path: path.join(f.root, 'source-library') });
  const destination = await backupEngine.repo.createDestination({
    libraryId,
    kind: 'google-drive',
    name: 'Drive recovery',
    path: null,
  });
  await backupEngine.repo.db.write(
    'UPDATE backup_destinations SET root_id=?,account_id=? WHERE id=?',
    ['drive-root', 'drive-account', destination.id],
  );
  const providerSpy = spyOn(backupEngine, 'provider').mockResolvedValue(f.provider);
  const payload = { destinationId: destination.id, ...f.request };
  return {
    ...f,
    destination,
    providerSpy,
    payload,
    async close() {
      providerSpy.mockRestore();
      await f.close();
    },
  };
}

test.each([
  { destinationId: undefined },
  { destinationId: 42 },
  { targetPath: undefined },
  { targetPath: 42 },
  { includeTrash: undefined },
  { includeTrash: 'true' },
])('restore handler rejects malformed required job fields: %j', async (patch) => {
  const f = await fixture();
  try {
    f.provider.manifest();
    await expect(cloudBackupRestoreHandler.run({ ...f.payload, ...patch }, f.ctx)).rejects.toThrow(
      'Invalid recovery request',
    );
    expect(f.providerSpy).not.toHaveBeenCalled();
    expect(await readdir(f.root)).toEqual([]);
  } finally {
    await f.close();
  }
});

test.each([
  { entryId },
  { sequence: 1 },
  { entryId, sequence: '1' },
  { entryId: 42, sequence: 1 },
  { entryId: '', sequence: 1 },
  { entryId: null, sequence: null },
])('restore handler never broadens a malformed version selection: %j', async (patch) => {
  const f = await fixture();
  try {
    f.provider.manifest();
    await expect(cloudBackupRestoreHandler.run({ ...f.payload, ...patch }, f.ctx)).rejects.toThrow(
      'Invalid recovery version selection',
    );
    expect(f.providerSpy).not.toHaveBeenCalled();
    expect(await readdir(f.root)).toEqual([]);
    expect(f.live.db.query('SELECT COUNT(*) AS n FROM assets').get()).toEqual({ n: 0 });
  } finally {
    await f.close();
  }
});

test.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
  'restore handler rejects an invalid numeric version %j before publishing files',
  async (sequence) => {
    const f = await fixture();
    try {
      f.provider.manifest();
      await expect(
        cloudBackupRestoreHandler.run({ ...f.payload, entryId, sequence }, f.ctx),
      ).rejects.toThrow('Invalid recovery version selection');
      expect(await readdir(f.root)).toEqual([]);
      expect(f.provider.downloads).toEqual([]);
    } finally {
      await f.close();
    }
  },
);

test.each([
  { kind: 'folder' },
  { root_id: null },
  { root_id: '' },
  { account_id: null },
  { account_id: '' },
])('restore handler rejects local mirrors and incomplete Drive destinations: %j', async (patch) => {
  const f = await fixture();
  try {
    for (const [column, value] of Object.entries(patch))
      await backupEngine.repo.db.write(`UPDATE backup_destinations SET ${column}=? WHERE id=?`, [
        value,
        f.destination.id,
      ]);
    await expect(cloudBackupRestoreHandler.run(f.payload, f.ctx)).rejects.toThrow(
      'Recovery destination unavailable',
    );
    expect(f.providerSpy).not.toHaveBeenCalled();
    expect(await readdir(f.root)).toEqual([]);
  } finally {
    await f.close();
  }
});

test('restore handler rejects an unknown destination without opening a provider', async () => {
  const f = await fixture();
  try {
    await expect(
      cloudBackupRestoreHandler.run({ ...f.payload, destinationId: crypto.randomUUID() }, f.ctx),
    ).rejects.toThrow('Recovery destination unavailable');
    expect(f.providerSpy).not.toHaveBeenCalled();
    expect(await readdir(f.root)).toEqual([]);
  } finally {
    await f.close();
  }
});

test('restore handler restores the current mirror version and binds its durable source journal', async () => {
  const f = await fixture();
  try {
    f.provider.manifest(1);
    f.provider.manifest(2);
    const payload = { ...f.payload, includeTrash: false, entryId, sequence: 2 };
    expect((await cloudBackupRestoreHandler.run(payload, f.ctx)).kind).toBe('done');
    expect(await readFile(path.join(f.root, 'photo.jpg'), 'utf8')).toBe(`${entryId}-version-2`);
    const journal = JSON.parse(
      await readFile(
        path.join(f.root, `.maple-recovery-${f.ctx.jobId.toHexString()}.json`),
        'utf8',
      ),
    );
    expect(journal.source).toEqual({
      destinationId: f.destination.id,
      rootId: 'drive-root',
      accountId: 'drive-account',
    });
    expect(journal.selection).toEqual({ includeTrash: false, entryId, sequence: 2 });
    expect(f.checkpoint()).toEqual({ targetPath: f.root, journal: f.ctx.jobId.toHexString() });
    expect(f.live.db.query('SELECT COUNT(*) AS n FROM assets').get()).toEqual({ n: 1 });
    expect(f.providerSpy.mock.calls[0]![0]).toMatchObject({
      id: f.destination.id,
      generation: f.destination.generation,
      rootId: 'drive-root',
      accountId: 'drive-account',
    });
  } finally {
    await f.close();
  }
});

test.each(['root_id', 'account_id'])(
  'restore resume rejects a changed %s in the current destination',
  async (column) => {
    const f = await fixture();
    try {
      f.provider.manifest();
      await expect(
        cloudBackupRestoreHandler.run(f.payload, {
          ...f.ctx,
          saveCheckpoint: async () => {
            throw new Error('simulated checkpoint crash');
          },
        }),
      ).rejects.toThrow('simulated checkpoint crash');
      await backupEngine.repo.db.write(
        `UPDATE backup_destinations SET ${column}=?,generation=generation+1 WHERE id=?`,
        ['replacement', f.destination.id],
      );
      await expect(cloudBackupRestoreHandler.run(f.payload, f.ctx)).rejects.toThrow(
        'Recovery source or selection changed',
      );
      expect(f.provider.downloads.every((key) => !key.includes('/blobs/'))).toBe(true);
      expect(f.live.db.query('SELECT COUNT(*) AS n FROM assets').get()).toEqual({ n: 0 });
    } finally {
      await f.close();
    }
  },
);

test('restore handler passes the captured destination generation to the real Google provider fence', async () => {
  const f = await fixture();
  try {
    f.providerSpy.mockImplementation(async (destination: BackupDestination) => {
      const provider = providerForDestination(destination);
      await backupEngine.repo.updateDestination(destination.id, { name: 'Reconfigured Drive' });
      return provider;
    });
    await expect(cloudBackupRestoreHandler.run(f.payload, f.ctx)).rejects.toThrow(
      'Google backup destination changed; retry with current settings',
    );
    expect((await backupEngine.repo.destination(f.destination.id))!.generation).toBe(
      f.destination.generation + 1,
    );
    expect(await readdir(f.root)).toEqual([]);
  } finally {
    await f.close();
  }
});
