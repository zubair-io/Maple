import { expect, test } from 'bun:test';
import type { DriveFile } from './client.ts';
import { backupObject } from './object.ts';

const rootId = 'backup-root';
const sha256 = 'a'.repeat(64);
function validFile(): DriveFile {
  return {
    id: 'file-id',
    name: 'photo.jpg',
    mimeType: 'image/jpeg',
    parents: ['folder-id'],
    trashed: false,
    size: '3',
    sha256Checksum: sha256,
    description: JSON.stringify({ mapleBackupObject: 1, rootId, key: 'photo.jpg', sha256 }),
    ownedByMe: true,
  };
}

test('reports which Google object identity check failed without exposing object metadata', () => {
  const cases: Array<[string, (file: DriveFile) => void]> = [
    ['backup marker is missing or malformed', (file) => (file.description = '{}')],
    [
      'backup marker belongs to a different root',
      (file) =>
        (file.description = JSON.stringify({
          mapleBackupObject: 1,
          rootId: 'other-root',
          key: 'photo.jpg',
          sha256,
        })),
    ],
    ['file is in Drive Trash', (file) => (file.trashed = true)],
    [
      'shortcuts cannot be backup objects',
      (file) => (file.mimeType = 'application/vnd.google-apps.shortcut'),
    ],
    ['file does not have exactly one parent', (file) => (file.parents = [])],
    ['file size is missing or invalid', (file) => (file.size = undefined)],
    ['file size is missing or invalid', (file) => (file.size = '-1')],
    [
      'Google’s checksum does not match the backup marker',
      (file) => (file.sha256Checksum = 'b'.repeat(64)),
    ],
  ];

  for (const [reason, invalidate] of cases) {
    const file = validFile();
    invalidate(file);
    expect(() => backupObject(file, rootId)).toThrow(
      `Google object failed identity or integrity validation: ${reason}.`,
    );
  }
});
