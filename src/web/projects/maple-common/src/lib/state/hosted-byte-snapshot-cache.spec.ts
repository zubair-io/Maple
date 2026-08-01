import { describe, expect, it, vi } from 'vitest';
import type { FolderEntry } from '../folder-access/folder-access.types';
import type { AssetId } from '../models/asset';
import { HostedByteSnapshotCache } from './hosted-byte-snapshot-cache';
import { LruCache } from './lru-cache';

const id = 'lib:a.dng' as AssetId;

function entry(getFile: () => Promise<File>): FolderEntry {
  return {
    name: 'a.dng',
    kind: 'file',
    getFile,
    getSubFolder: () => Promise.reject(new Error('not a folder')),
  };
}

function file(bytes: number[], lastModified: number, onRead: () => void): File {
  return {
    size: bytes.length,
    lastModified,
    arrayBuffer: async () => {
      onRead();
      return new Uint8Array(bytes).buffer;
    },
  } as File;
}

describe('HostedByteSnapshotCache', () => {
  it('reuses cached bytes only while the File identity matches', async () => {
    const reads = vi.fn();
    const current = file([1], 100, reads);
    const cache = new HostedByteSnapshotCache(new LruCache(1024));
    cache.register(
      id,
      entry(async () => current),
    );

    expect((await cache.snapshotFor(id)).bytes).toEqual(new Uint8Array([1]));
    expect((await cache.snapshotFor(id)).bytes).toEqual(new Uint8Array([1]));
    expect(reads).toHaveBeenCalledTimes(1);
  });

  it('re-reads a same-path RAW replacement and reports its matching identity', async () => {
    const reads = vi.fn();
    let current = file([1], 100, reads);
    const cache = new HostedByteSnapshotCache(new LruCache(1024));
    cache.register(
      id,
      entry(async () => current),
    );
    await cache.snapshotFor(id);
    current = file([2, 3], 200, reads);

    const replaced = await cache.snapshotFor(id);

    expect(replaced.bytes).toEqual(new Uint8Array([2, 3]));
    expect(replaced.source).toEqual({ size: 2, lastModified: 200 });
    expect(reads).toHaveBeenCalledTimes(2);
  });
});
