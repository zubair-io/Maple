import { describe, expect, it } from 'vitest';
import { fallbackFileMetadata, fallbackReadFile } from './fallback-backend';
import type { MapleFolderHandle } from './folder-access.types';

function fixtureFile(path: string, contents: string, lastModified: number): File {
  const file = new File([contents], path.split('/').at(-1) ?? path, { lastModified });
  Object.defineProperty(file, 'webkitRelativePath', { value: path });
  return file;
}

describe('fallback file access', () => {
  it('rejects nested .maple cache paths instead of matching a source file by basename', async () => {
    const source = fixtureFile('Library/elsewhere/frame.avif', 'source bytes', 123);
    const folder: MapleFolderHandle = {
      name: 'Library',
      read: true,
      write: false,
      fallbackFiles: [source],
    };

    await expect(fallbackFileMetadata(folder, '2024/.maple/previews/frame.avif')).rejects.toThrow(
      'fallback: cached file metadata unavailable',
    );

    const globalWithIdb = globalThis as typeof globalThis & { indexedDB?: IDBFactory };
    const original = globalWithIdb.indexedDB;
    Reflect.deleteProperty(globalWithIdb, 'indexedDB');
    try {
      await expect(fallbackReadFile(folder, '2024/.maple/previews/frame.avif')).rejects.toThrow();
    } finally {
      if (original) globalWithIdb.indexedDB = original;
    }
  });

  it('matches the complete relative source path when basenames collide', async () => {
    const older = fixtureFile('Library/2024/frame.dng', 'older', 2024);
    const newer = fixtureFile('Library/2025/frame.dng', 'newer', 2025);
    const folder: MapleFolderHandle = {
      name: 'Library',
      read: true,
      write: false,
      fallbackFiles: [newer, older],
    };

    expect(new TextDecoder().decode(await fallbackReadFile(folder, '2024/frame.dng'))).toBe(
      'older',
    );
    await expect(fallbackFileMetadata(folder, '2024/frame.dng')).resolves.toEqual({
      size: older.size,
      lastModified: 2024,
    });
  });
});
