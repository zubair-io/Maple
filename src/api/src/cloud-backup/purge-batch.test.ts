import { expect, test } from 'bun:test';
import {
  createLiveTestDatabase,
  insertAsset,
  insertFolder,
} from '../db/sqlite/test-sqlite.test-helpers.ts';
import { BackupRepository } from './repository.ts';
import { BackupEngine, entryPrefix, jsonSource } from './engine.ts';
import { preparePurge } from './lifecycle.ts';
import { drainPurges } from './purge.ts';
import { GoogleDriveProvider } from './google/provider.ts';
import { googleStore } from './google/google-store.test-helpers.ts';
import { createTestProvider } from './test-provider.test-helpers.ts';
import type { UploadCheckpoint } from './provider.ts';

async function batchFixture() {
  const live = await createLiveTestDatabase();
  const repo = new BackupRepository(live.handle);
  const libraryId = insertFolder(live.db);
  const destination = await repo.createDestination({
    libraryId,
    kind: 'google-drive',
    name: 'Drive',
    path: null,
  });
  const entries = [];
  for (let index = 0; index < 3; index++) {
    const assetId = insertAsset(live.db);
    const entry = await repo.ensureEntry(destination.id, assetId, 0, `photo-${index}.dng`);
    entries.push(entry);
    if (index < 2) await preparePurge(assetId, repo);
  }
  return { live, repo, libraryId, destination, entries };
}

test('Google purge batch shares two owned-tree inventories and removes manifests, blobs and lost-response reservations', async () => {
  const f = await batchFixture();
  try {
    const store = googleStore();
    const provider = new GoogleDriveProvider('maple-root', async () => 'token', store.transport);
    for (const [index, entry] of f.entries.entries()) {
      const prefix = entryPrefix(f.libraryId, entry.id);
      for (const suffix of ['manifests/1.json', 'manifests/2.json', 'blobs/old', 'blobs/current']) {
        const object = await provider.publish(prefix + suffix, jsonSource({ index, suffix }), {
          saveCheckpoint: async () => {},
        });
        // Earlier portable objects can have no newly-added per-entry index.
        store.files.get(object.locator)!.properties = undefined;
      }
    }
    const entry = f.entries[0]!;
    const key = entryPrefix(f.libraryId, entry.id) + 'blobs/lost-final';
    let checkpoint: UploadCheckpoint | null = null;
    store.loseFinal();
    await expect(
      provider.publish(key, jsonSource('lost final response'), {
        saveCheckpoint: async (value) => {
          checkpoint = value;
          await f.repo.saveObject(f.destination.id, entry.id, key, null, value);
        },
      }),
    ).rejects.toThrow();
    expect(checkpoint).not.toBeNull();
    const before = store.requests.length;
    await drainPurges(new BackupEngine(async () => provider, f.repo), f.destination);
    const inventory = store.requests
      .slice(before)
      .filter(
        (request) =>
          request.path === '/drive/v3/files' &&
          !!request.query &&
          !request.query.includes('mapleKeyHash'),
      );
    const folderIds = new Set([
      'maple-root',
      ...[...store.files.values()]
        .filter((file) => file.mimeType === 'application/vnd.google-apps.folder')
        .filter((file) => JSON.parse(file.description).rootId === 'maple-root')
        .map((file) => file.id),
    ]);
    expect(inventory.length).toBeGreaterThan(2);
    expect(
      inventory.every((request) => {
        const parentId = /'([^']+)' in parents/.exec(request.query ?? '')?.[1];
        return (
          request.query === `'${parentId}' in parents and trashed = false` &&
          folderIds.has(parentId ?? '')
        );
      }),
    ).toBe(true);
    expect((await f.repo.purges(f.destination.id)).every((row) => row.completed === 1)).toBe(true);
    const remaining = [...store.files.values()].flatMap((file) => {
      const marker = JSON.parse(file.description) as { key?: string };
      return marker.key ? [marker.key] : [];
    });
    const survivor = entryPrefix(f.libraryId, f.entries[2]!.id);
    expect(remaining.filter((value) => value.startsWith(survivor))).toHaveLength(4);
    for (const row of f.entries.slice(0, 2)) {
      expect(remaining.some((value) => value.startsWith(entryPrefix(f.libraryId, row.id)))).toBe(
        false,
      );
      expect(remaining).toContain(`purges/${row.id}.json`);
    }
  } finally {
    f.live.close();
  }
});

test('a moved saved object blocks only its entry while the batch cleans other entries', async () => {
  const f = await batchFixture();
  try {
    const provider = createTestProvider();
    for (const entry of f.entries.slice(0, 2)) {
      const key = entryPrefix(f.libraryId, entry.id) + 'blobs/bytes';
      const object = await provider.publish(key, jsonSource('original'), {
        saveCheckpoint: async () => {},
      });
      await f.repo.saveObject(f.destination.id, entry.id, key, object, null);
      if (entry === f.entries[0]) provider.objects.get(key)!.moved = true;
    }
    await drainPurges(new BackupEngine(async () => provider, f.repo), f.destination);
    const rows = await f.repo.purges(f.destination.id);
    expect(rows.find((row) => row.entry_id === f.entries[0]!.id)?.completed).toBe(0);
    expect(rows.find((row) => row.entry_id === f.entries[1]!.id)?.completed).toBe(1);
    expect(provider.objects.has(entryPrefix(f.libraryId, f.entries[0]!.id) + 'blobs/bytes')).toBe(
      true,
    );
    expect(provider.objects.has(entryPrefix(f.libraryId, f.entries[1]!.id) + 'blobs/bytes')).toBe(
      false,
    );
  } finally {
    f.live.close();
  }
});

test('permanent deletion removes a mirrored Trash path left by an interrupted catalog commit', async () => {
  const f = await batchFixture();
  try {
    const provider = createTestProvider();
    const entry = f.entries[0]!;
    const key = `mirror/${f.libraryId}/.maple/trash/photo-0.dng`;
    const object = await provider.mirrorFile(key, '.maple/trash/photo-0.dng', jsonSource('photo'), {
      saveCheckpoint: async () => {},
    });
    await f.repo.saveObject(f.destination.id, entry.id, key, object, null);

    await drainPurges(new BackupEngine(async () => provider, f.repo), f.destination);

    expect(provider.objects.has(key)).toBe(false);
    expect(
      (await f.repo.purges(f.destination.id)).find((row) => row.entry_id === entry.id)?.completed,
    ).toBe(1);
  } finally {
    f.live.close();
  }
});

test('permanent deletion reconciles a completed mirror replacement before removing it', async () => {
  const f = await batchFixture();
  try {
    const store = googleStore();
    const provider = new GoogleDriveProvider('maple-root', async () => 'token', store.transport);
    const entry = f.entries[0]!;
    const key = `mirror/${f.libraryId}/photo-0.dng`;
    const oldSource = jsonSource('old bytes');
    const oldObject = await provider.mirrorFile(key, 'photo-0.dng', oldSource, {
      saveCheckpoint: async () => {},
    });
    await f.repo.saveObject(f.destination.id, entry.id, key, oldObject, null);

    store.loseFinal();
    await expect(
      provider.mirrorFile(key, 'photo-0.dng', jsonSource('replacement bytes'), {
        saveCheckpoint: async (checkpoint) =>
          f.repo.saveObject(f.destination.id, entry.id, key, null, checkpoint),
      }),
    ).rejects.toThrow('request failed');
    expect(store.files.get(oldObject.locator)!.bytes).not.toEqual(
      new TextEncoder().encode('old bytes'),
    );

    await drainPurges(new BackupEngine(async () => provider, f.repo), f.destination);

    expect(store.files.has(oldObject.locator)).toBe(false);
    expect(
      (await f.repo.purges(f.destination.id)).find((row) => row.entry_id === entry.id)?.completed,
    ).toBe(1);
  } finally {
    f.live.close();
  }
});

test('an incomplete shared absence scan leaves all unfinished purge obligations pending', async () => {
  const f = await batchFixture();
  try {
    const provider = createTestProvider();
    const list = provider.list.bind(provider);
    let scans = 0;
    provider.list = async function* (prefix, signal) {
      yield* list(prefix, signal);
      if (++scans === 2) throw new Error('lost final inventory page');
    };
    await drainPurges(new BackupEngine(async () => provider, f.repo), f.destination);
    expect((await f.repo.purges(f.destination.id)).every((row) => row.completed === 0)).toBe(true);
    expect(scans).toBe(2);
  } finally {
    f.live.close();
  }
});

test('saved entry cleanup uses exact key-prefix and entry indexes', async () => {
  const f = await batchFixture();
  try {
    const prefix = entryPrefix(f.libraryId, f.entries[0]!.id);
    const plan = f.live.db
      .query(
        `EXPLAIN QUERY PLAN SELECT key,object,checkpoint FROM backup_objects
      WHERE destination_id=? AND key>=? AND key<?`,
      )
      .all(f.destination.id, prefix, prefix.slice(0, -1) + '0') as Array<{
      detail: string;
    }>;
    expect(plan.map((row) => row.detail).join(' ')).toMatch(
      /SEARCH backup_objects USING PRIMARY KEY/,
    );
    expect(plan.map((row) => row.detail).join(' ')).toContain(
      'destination_id=? AND key>? AND key<?',
    );
    const entryPlan = f.live.db
      .query(
        `EXPLAIN QUERY PLAN SELECT key,object,checkpoint FROM backup_objects INDEXED BY backup_objects_entry
        WHERE destination_id=? AND entry_id=?`,
      )
      .all(f.destination.id, f.entries[0]!.id) as Array<{ detail: string }>;
    expect(entryPlan.map((row) => row.detail).join(' ')).toContain('backup_objects_entry');
  } finally {
    f.live.close();
  }
});
