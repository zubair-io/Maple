import { test, expect } from 'bun:test';
import { readFile, readdir } from '../fs/mirrored.ts';
import * as path from 'node:path';
import { recoverBackup } from './restore.ts';
import {
  recoveryFixture as fixture,
  libraryId,
  entryId,
  source,
  publishTestPurge,
} from './restore.test-helpers.ts';
test('per-file purge fences do not list or download unrelated purge journals', async () => {
  const f = await fixture();
  try {
    const manifest = f.provider.manifest();
    const prefix = `libraries/${libraryId}/entries/${entryId}/blobs/`;
    manifest.files.push(
      {
        path: 'photo.xmp',
        role: 'sidecar',
        object: f.provider.put(prefix + 'sidecar', '<x:xmpmeta> exact </x:xmpmeta>'),
      },
      {
        path: 'photo-rendered.jpg',
        role: 'companion',
        object: f.provider.put(prefix + 'companion', 'companion bytes'),
      },
    );
    f.provider.saveManifest(manifest);
    const unrelated = ['d'.repeat(24), 'e'.repeat(24), 'f'.repeat(24)].map((id) =>
      publishTestPurge(f.provider, id),
    );
    expect((await recoverBackup(f.provider, f.request, f.ctx, source)).kind).toBe('done');
    expect(f.provider.lists.filter((value) => value === 'purges/')).toHaveLength(2);
    for (const object of unrelated)
      expect(f.provider.downloads.filter((key) => key === object.key)).toHaveLength(2);
    expect(f.provider.inspections.filter((key) => key === `purges/${entryId}.json`)).toHaveLength(
      7,
    );
  } finally {
    await f.close();
  }
});
test('targeted purge fence blocks a purge published during the blob download before exclusive publication', async () => {
  const f = await fixture();
  try {
    const manifest = f.provider.manifest();
    const download = f.provider.download.bind(f.provider);
    f.provider.download = async (object) => {
      const stream = await download(object);
      if (object.key === manifest.files[0]!.object.key) publishTestPurge(f.provider);
      return stream;
    };
    await expect(recoverBackup(f.provider, f.request, f.ctx, source)).rejects.toThrow(
      'purged during recovery',
    );
    expect(
      (await readdir(f.root)).filter((name) => name === 'photo.jpg' || name.endsWith('.tmp')),
    ).toEqual([]);
    expect(f.live.db.query('SELECT COUNT(*) AS n FROM assets').get()).toEqual({ n: 0 });
  } finally {
    await f.close();
  }
});
test('targeted purge fence blocks indexing when the purge arrives after publication', async () => {
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
            publishTestPurge(f.provider);
          },
        },
        source,
      ),
    ).rejects.toThrow('purged during recovery');
    expect(await readFile(path.join(f.root, 'photo.jpg'), 'utf8')).toBe(`${entryId}-version-1`);
    expect(f.live.db.query('SELECT COUNT(*) AS n FROM assets').get()).toEqual({ n: 0 });
  } finally {
    await f.close();
  }
});
test('targeted purge fence validates the selected library and entry identity', async () => {
  for (const identity of [
    { library: 'd'.repeat(24), entry: entryId },
    { library: libraryId, entry: 'd'.repeat(24) },
  ]) {
    const f = await fixture();
    try {
      const manifest = f.provider.manifest();
      const download = f.provider.download.bind(f.provider);
      f.provider.download = async (object) => {
        const stream = await download(object);
        if (object.key === manifest.files[0]!.object.key)
          publishTestPurge(f.provider, entryId, identity.library, identity.entry);
        return stream;
      };
      await expect(recoverBackup(f.provider, f.request, f.ctx, source)).rejects.toThrow(
        'purge record identity mismatch',
      );
      expect((await readdir(f.root)).filter((name) => name === 'photo.jpg')).toEqual([]);
    } finally {
      await f.close();
    }
  }
});
test('targeted purge fence refuses corrupt journal bytes before publication', async () => {
  const f = await fixture();
  try {
    const manifest = f.provider.manifest();
    const download = f.provider.download.bind(f.provider);
    f.provider.download = async (object) => {
      const stream = await download(object);
      if (object.key === manifest.files[0]!.object.key) {
        const purge = publishTestPurge(f.provider);
        const row = f.provider.objects.get(purge.key)!;
        row.bytes = Uint8Array.from(row.bytes, (byte) => (byte === 97 ? 98 : byte));
      }
      return stream;
    };
    await expect(recoverBackup(f.provider, f.request, f.ctx, source)).rejects.toThrow(
      'catalog checksum mismatch',
    );
    expect((await readdir(f.root)).filter((name) => name === 'photo.jpg')).toEqual([]);
  } finally {
    await f.close();
  }
});
